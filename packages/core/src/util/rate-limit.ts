interface Bucket {
  tokens: number;
  updated: number;
  /** refill rate, tokens per minute */
  rate: number;
  capacity: number;
}

/**
 * Token buckets keyed by string. Refill rate = perMinute / 60 tokens per second; capacity = `burst`
 * (default perMinute, i.e. a one-minute burst). New buckets start full.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  private bucket(key: string, perMinute: number, burst: number): Bucket {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: burst, updated: t, rate: perMinute, capacity: burst };
      this.buckets.set(key, b);
      return b;
    }
    if (b.rate !== perMinute || b.capacity !== burst) {
      b.tokens = Math.min(b.tokens, burst);
      b.rate = perMinute;
      b.capacity = burst;
    }
    b.tokens = Math.min(b.capacity, b.tokens + ((t - b.updated) / 60_000) * b.rate);
    b.updated = t;
    return b;
  }

  /**
   * Consumes `cost` tokens; returns false (consuming nothing) if fewer are available. cost 0 only checks
   * that the bucket isn't in debt (see charge()). perMinute <= 0 disables the limit.
   */
  take(key: string, perMinute: number, cost = 1, burst = perMinute): boolean {
    if (!(perMinute > 0)) return true;
    const b = this.bucket(key, perMinute, Math.max(1, burst));
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /**
   * Consumes `cost` tokens unconditionally; the bucket may go into debt (down to -perMinute) so a cost
   * only known afterwards (e.g. query time) is still paid for before the next take().
   */
  charge(key: string, perMinute: number, cost: number, burst = perMinute): void {
    if (!(perMinute > 0) || !(cost > 0)) return;
    const b = this.bucket(key, perMinute, Math.max(1, burst));
    b.tokens = Math.max(-perMinute, b.tokens - cost);
  }

  /** Gives back `amount` tokens (e.g. an up-front estimate that turned out too high), up to the capacity. */
  refund(key: string, perMinute: number, amount: number, burst = perMinute): void {
    if (!(perMinute > 0) || !(amount > 0)) return;
    const b = this.bucket(key, perMinute, Math.max(1, burst));
    b.tokens = Math.min(b.capacity, b.tokens + amount);
  }

  /** Drops buckets that are full again (idle keys). */
  sweep(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.updated) / 60_000) * b.rate >= b.capacity) this.buckets.delete(k);
    }
  }

  delete(key: string) {
    this.buckets.delete(key);
  }

  get size() {
    return this.buckets.size;
  }
}
