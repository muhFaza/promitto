import { randomBytes } from 'node:crypto';

// 32 random bytes encoded as base64url → 43 URL-safe chars. ~256 bits of entropy.
export function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}
