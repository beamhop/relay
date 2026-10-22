interface Entry {
  failures: number[];
  lockouts: number;
  lockedUntil: number;
  lastAt: number;
}

/**
 * Login brute-force protection: `maxFailures` within `windowMs` locks the key out with
 * exponential backoff (window * 2^(n-1), capped at maxLockMs). Success resets the key.
 */
export class LoginLimiter {
  private entries = new Map<string, Entry>();
  constructor(
    private readonly now: () => number,
    private readonly maxFailures = 5,
    private readonly windowMs = 60_000,
    private readonly maxLockMs = 60 * 60_000,
  ) {}

  /** Returns ms to wait, or 0 if allowed. */
  check(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const n = this.now();
    return e.lockedUntil > n ? e.lockedUntil - n : 0;
  }

  fail(key: string): number {
    const n = this.now();
    if (this.entries.size > 50_000) this.prune();
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { failures: [], lockouts: 0, lockedUntil: 0, lastAt: n }));
    e.lastAt = n;
    e.failures = e.failures.filter((t) => n - t < this.windowMs);
    e.failures.push(n);
    if (e.failures.length >= this.maxFailures) {
      e.lockouts++;
      e.lockedUntil = n + Math.min(this.windowMs * 2 ** (e.lockouts - 1), this.maxLockMs);
      e.failures = [];
    }
    return this.check(key);
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  private prune() {
    const n = this.now();
    for (const [k, e] of this.entries) {
      if (e.lockedUntil < n && n - e.lastAt > this.maxLockMs) this.entries.delete(k);
    }
  }
}

/** Simple token bucket (used for SSE event throttling). */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSec: number,
    private readonly burst = ratePerSec,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  take(): boolean {
    const n = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((n - this.last) / 1000) * this.ratePerSec);
    this.last = n;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
