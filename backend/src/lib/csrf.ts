import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export function computeCsrfToken(sessionId: string): string {
  return createHmac('sha256', env.SESSION_SECRET)
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
