interface Bucket {
  tokens: number;
  updated: number;
  capacity: number;
}

/**
 * Token buckets keyed by string. Capacity = perMinute (allows a one-minute burst),
 * refill rate = perMinute / 60 tokens per second.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Consumes one token; returns false if the bucket is empty. perMinute <= 0 disables the limit. */
  take(key: string, perMinute: number, cost = 1): boolean {
    if (!(perMinute > 0)) return true;
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: perMinute, updated: t, capacity: perMinute };
      this.buckets.set(key, b);
    } else {
      if (b.capacity !== perMinute) {
        b.tokens = Math.min(b.tokens, perMinute);
        b.capacity = perMinute;
      }
      b.tokens = Math.min(b.capacity, b.tokens + ((t - b.updated) / 60_000) * perMinute);
      b.updated = t;
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** Drops buckets that are full again (idle keys). */
  sweep(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.updated) / 60_000) * b.capacity >= b.capacity) this.buckets.delete(k);
    }
  }

  delete(key: string) {
    this.buckets.delete(key);
  }

  get size() {
    return this.buckets.size;
  }
}
