// Typed wrapper around EventSource. Phase 2 uses this for WhatsApp QR + status streaming.

// Native EventSource reconnects on its own and there is no way to switch that
// off — an expired session cookie or a container restart otherwise leaves a tab
// hammering the backend every ~3s for as long as it stays open, while the UI
// keeps showing whatever status it last saw. Counting consecutive failures and
// calling close() at the cap is the only way to actually stop the retry loop.
//
// The cap is sized against a deploy, not against a network blip: the container
// is recreated on every push to main and is unreachable for ~13s while it comes
// back. At the browser's ~3s retry interval a smaller budget would be spent
// mid-deploy and strand every open tab, so this rides out a routine restart and
// only gives up on something genuinely persistent (a 401 after the session
// expires closes the stream immediately anyway, via the readyState check below).
const MAX_CONSECUTIVE_FAILURES = 10;

export type SseErrorInfo = {
  /** False once the wrapper has given up; the stream is closed for good. */
  willRetry: boolean;
};

export type SseHandlers<T = unknown> = {
  onMessage?: (data: T) => void;
  onError?: (err: unknown, info: SseErrorInfo) => void;
  onOpen?: () => void;
};

export function subscribeSse<T = unknown>(
  path: string,
  handlers: SseHandlers<T>,
): () => void {
  const url = path.startsWith('/') ? path : `/${path}`;
  const source = new EventSource(url, { withCredentials: true });

  let failures = 0;

  source.onopen = () => {
    // A successful (re)connect clears the budget, so the occasional blip over a
    // dashboard left open for hours never accumulates its way to the cap.
    failures = 0;
    handlers.onOpen?.();
  };

  source.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data) as T;
      handlers.onMessage?.(parsed);
    } catch (err) {
      // A malformed frame is a payload bug, not a transport failure — the
      // connection is still healthy, so it must not spend the retry budget.
      handlers.onError?.(err, { willRetry: true });
    }
  };

  source.onerror = (err) => {
    failures += 1;
    // readyState CLOSED means the browser has already given up by itself (a
    // non-2xx response — a 401 once the session expires, say); CONNECTING means
    // it has scheduled another attempt. Either way, past the cap we close the
    // source so the retries stop for good.
    const stopped =
      failures >= MAX_CONSECUTIVE_FAILURES || source.readyState === EventSource.CLOSED;
    if (stopped) source.close();
    handlers.onError?.(err, { willRetry: !stopped });
  };

  return () => source.close();
}
