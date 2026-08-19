import type { NextFunction, Request, Response } from 'express';
import { errors } from '../../lib/errors.js';
import { TokenBucket } from '../../lib/rate-limit.js';

// Every settings route that takes a password verifies it with Argon2id, which
// allocates ~64 MiB per call (node-argon2's default memoryCost) *outside* the V8
// heap, so --max-old-space-size does not bound it. The container is capped at
// mem_limit: 384m and this host has OOM-killed Node before; an OOM here takes
// the paired WhatsApp session and the scheduler with it.
//
// One bucket shared across all three routes, keyed by user id: the cost is per
// *verify*, not per endpoint, so three separate budgets would multiply the very
// thing being bounded. Keying by user rather than IP is right here because
// every one of these routes is behind requireAuth — there is no unauthenticated
// caller to spend the budget, and an authenticated one is already identified.
//
// 3 burst, one token back every 30s. Deliberately far below anything a person
// does: the three actions (change password, purge data, delete account) are
// each once-in-a-while, and the only way to reach the third token is retyping a
// password wrong three times inside a minute — which still leaves the next
// attempt 30s away, not blocked. Worst case from this path is therefore ~192
// MiB of transient Argon2 allocation per user rather than an unbounded pile.
//
// In-memory, like the login buckets: a restart clears it, and that is accepted.
export const passwordVerifyBucket = new TokenBucket({
  capacity: 3,
  refillTokens: 1,
  refillIntervalMs: 30_000,
});

/**
 * Spend one password-verify token for the authenticated user, or 429.
 *
 * Mounted per-route rather than on the whole settings router on purpose: the
 * router also serves cheap reads (timezone list) and cheap writes (timezone,
 * retention, contact sync) that must not consume a budget sized for Argon2.
 *
 * Runs before the zod parse, so a malformed body still costs a token — that is
 * intended. The attack is volume, and body shape is free to vary.
 */
export function requirePasswordVerifyBudget(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.user) return next(errors.unauthorized());
  if (!passwordVerifyBucket.take(req.user.id)) {
    return next(errors.tooManyRequests('Too many password confirmations. Try again in a moment.'));
  }
  next();
}
