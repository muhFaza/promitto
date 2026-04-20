import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

function sign(sessionId: string): string {
  return createHmac('sha256', env.SESSION_SECRET)
    .update(sessionId)
    .digest('base64url');
}

export function signSessionId(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`;
}

export function readSignedSessionId(raw: string | undefined): string | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const sid = raw.slice(0, idx);
  const providedSig = raw.slice(idx + 1);
  const expectedSig = sign(sid);
  if (providedSig.length !== expectedSig.length) return null;
  try {
    const a = Buffer.from(providedSig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return sid;
}
