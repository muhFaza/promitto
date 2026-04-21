import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { CSRF_COOKIE_NAME, SESSION_DURATION_MS } from '../config/constants.js';
import { env } from '../config/env.js';

export function computeCsrfToken(sessionId: string): string {
  return createHmac('sha256', env.CSRF_SECRET)
    .update('csrf:' + sessionId)
    .digest('base64url');
}

export function verifyCsrfToken(sessionId: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = computeCsrfToken(sessionId);
  if (provided.length !== expected.length) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Centralized setter so login and sliding-TTL refresh agree on cookie flags.
// Non-HttpOnly by design — the frontend needs to read the value to echo it in
// the X-CSRF-Token header on mutating requests.
export function setCsrfCookie(res: Response, sessionId: string): void {
  res.cookie(CSRF_COOKIE_NAME, computeCsrfToken(sessionId), {
    httpOnly: false,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DURATION_MS,
  });
}
