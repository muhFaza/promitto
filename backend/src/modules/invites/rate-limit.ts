import { TokenBucket } from '../../lib/rate-limit.js';

// Deliberately separate from the login buckets: invite traffic must not be able
// to consume the login budget (or vice versa), or a burst of invite probes would
// lock a legitimate user out of signing in.

// GET /api/invite/:token — per-IP: 20 burst, one token every 2 seconds. Cheap
// lookup, so this only exists to stop token enumeration from being free.
export const inviteLookupIpBucket = new TokenBucket({
  capacity: 20,
  refillTokens: 1,
  refillIntervalMs: 2_000,
});

// POST /api/invite/:token — per-IP: 10 burst, one token every 10 seconds.
// Deliberately much tighter than the lookup: this is an UNAUTHENTICATED endpoint
// that runs Argon2id, which is expensive by design. The box has 965MB RAM and
// V8's old space is pinned at 192MB, so an unthrottled KDF here is a
// memory-exhaustion vector, not just a CPU one.
export const inviteConsumeIpBucket = new TokenBucket({
  capacity: 10,
  refillTokens: 1,
  refillIntervalMs: 10_000,
});
