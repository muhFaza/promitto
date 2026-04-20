import { TokenBucket } from '../../lib/rate-limit.js';

// Per-IP: 20 burst, one token refilled every 2 seconds.
export const loginIpBucket = new TokenBucket({
  capacity: 20,
  refillTokens: 1,
  refillIntervalMs: 2_000,
});

// Per-email: 5 burst, one token refilled every 30 seconds.
export const loginEmailBucket = new TokenBucket({
  capacity: 5,
  refillTokens: 1,
  refillIntervalMs: 30_000,
});
