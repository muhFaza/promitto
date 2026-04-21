export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

const CSRF_COOKIE_NAME = 'promitto_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${CSRF_COOKIE_NAME}=`;
  for (const raw of document.cookie.split(';')) {
    const c = raw.trim();
    if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length));
  }
  return null;
}

export async function apiRequest<T = unknown>(
  path: string,
  { method = 'GET', body, signal, headers = {} }: RequestOptions = {},
): Promise<T> {
  const url = path.startsWith('/') ? path : `/${path}`;

  const csrfHeader: Record<string, string> = {};
  if (!SAFE_METHODS.has(method)) {
    const token = readCsrfCookie();
    if (token) csrfHeader['X-CSRF-Token'] = token;
  }

  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...csrfHeader,
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    let code = 'unknown_error';
    let message = res.statusText || `Request failed (${res.status})`;
    let details: unknown;
    try {
      const parsed = (await res.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      if (parsed?.error) {
        code = parsed.error.code ?? code;
        message = parsed.error.message ?? message;
        details = parsed.error.details;
      }
    } catch {
      // non-JSON body — use defaults
    }
    throw new ApiError(res.status, code, message, details);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
