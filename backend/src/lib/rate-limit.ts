type Bucket = { tokens: number; lastRefill: number };

type Options = {
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
};

export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(private readonly opts: Options) {}

  take(key: string, cost = 1): boolean {
    const now = Date.now();
    this.sweepIfNeeded(now);

    const bucket = this.buckets.get(key) ?? { tokens: this.opts.capacity, lastRefill: now };
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / this.opts.refillIntervalMs) * this.opts.refillTokens;
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    return true;
  }

  private sweepIfNeeded(now: number): void {
    const hour = 60 * 60 * 1000;
    if (now - this.lastSweep < hour) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > hour && bucket.tokens >= this.opts.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}
