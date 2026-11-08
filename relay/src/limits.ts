// Token buckets: one per connection for messages, one per client address for connects and refused joins.
export class TokenBucket {
  private tokens: number;
  private at: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;
  constructor(rate: number, burst: number, now: () => number = Date.now) {
    this.rate = rate; this.burst = burst; this.now = now;
    this.tokens = burst; this.at = now();
  }
  take(cost = 1): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
  /** Tokens available now (refilled, nothing spent). */
  available(): number { this.take(0); return this.tokens; }
  /** True when the bucket is full again (nothing to remember). */
  idle(): boolean { return this.available() >= this.burst; }
}

/** Buckets by key (a client address), forgotten once full again so memory stays bounded by recent activity. */
export class KeyedLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly perMinute: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  constructor(perMinute: number, now: () => number = Date.now, maxKeys = 100_000) {
    this.perMinute = perMinute; this.now = now; this.maxKeys = maxKeys;
  }
  take(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.sweep();
      if (this.buckets.size >= this.maxKeys) return false;
      bucket = new TokenBucket(this.perMinute / 60, this.perMinute, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.take();
  }
  /** Whether a take would succeed, without spending. */
  allows(key: string): boolean { const bucket = this.buckets.get(key); return !bucket || bucket.available() >= 1; }
  sweep() { for (const [key, bucket] of this.buckets) if (bucket.idle()) this.buckets.delete(key); }
  get size() { return this.buckets.size; }
}
