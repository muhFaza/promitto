// Typed wrapper around EventSource. Phase 2 uses this for WhatsApp QR + status streaming.

export type SseHandlers<T = unknown> = {
  onMessage?: (data: T) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
};

export function subscribeSse<T = unknown>(
  path: string,
  handlers: SseHandlers<T>,
): () => void {
  const url = path.startsWith('/') ? path : `/${path}`;
  const source = new EventSource(url, { withCredentials: true });

  if (handlers.onOpen) source.onopen = () => handlers.onOpen?.();

  source.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data) as T;
      handlers.onMessage?.(parsed);
    } catch (err) {
      handlers.onError?.(err);
    }
  };

  source.onerror = (err) => handlers.onError?.(err);

  return () => source.close();
}
