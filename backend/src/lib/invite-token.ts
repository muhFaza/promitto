import { createHash, randomBytes } from 'node:crypto';

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

// 256 bits of entropy, URL-safe so it can sit in a path segment unencoded.
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

// The raw token is never stored — only this digest. Plain SHA-256 is correct
// here precisely because the token is high-entropy random: there is no
// dictionary to run and nothing to slow an attacker down, and unlike Argon2 a
// digest can be a primary key we look the invite up by.
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
