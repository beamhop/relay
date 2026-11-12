/**
 * Minimal FIFO semaphore: at most `max` jobs run, at most `maxQueue` wait. `canEnter` tells beforehand whether `run`
 * would be admitted (so a caller can answer 503 early); `run` itself throws `SemaphoreFullError` when it isn't.
 */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    readonly max: number,
    readonly maxQueue = Infinity,
  ) {}
  /** false when the queue is full (caller should answer 503) */
  canEnter(): boolean {
    return this.active < this.max || this.waiters.length < this.maxQueue;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canEnter()) throw new SemaphoreFullError();
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class SemaphoreFullError extends Error {
  constructor() {
    super("semaphore queue full");
  }
}

/**
 * Fixed-window counter per key (e.g. "ip:1.2.3.4", "pk:<hex>"). Memory is bounded: expired windows are swept
 * when the map grows, and the oldest keys are dropped beyond `maxKeys`.
 */
export class WindowLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}
  /** Counts one hit; returns false when the key is over the limit for the current window. 0 = unlimited. */
  take(key: string): boolean {
    if (this.limit <= 0) return true;
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= t) {
      if (this.hits.size >= this.maxKeys) this.sweep(t);
      e = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.n++;
    return e.n <= this.limit;
  }
  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

/** Rate-limit key for an IP: IPv6 addresses are grouped by /64 (one subscriber usually owns a whole /64). */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * Bytes of request bodies held in memory at once, shared by all uploads and mirrors. `capacity` is re-read on
 * every take so it follows settings changes. Bytes are reserved as they arrive (a Content-Length that lies high
 * reserves nothing it doesn't send) and released when the request is done with them.
 */
export class ByteBudget {
  private used = 0;
  constructor(private readonly capacity: () => number) {}
  get inUse() {
    return this.used;
  }
  /** Whether `bytes` more would fit right now (nothing is reserved). */
  fits(bytes: number): boolean {
    return this.used + bytes <= this.capacity();
  }
  /**
   * A per-request handle: `take` reserves more (false when the budget is exhausted), `give` returns part of it,
   * `release` gives all of it back.
   */
  lease(): { take(bytes: number): boolean; give(bytes: number): void; release(): void } {
    let held = 0;
    return {
      take: (bytes) => {
        if (this.used + bytes > this.capacity()) return false;
        this.used += bytes;
        held += bytes;
        return true;
      },
      give: (bytes) => {
        const n = Math.min(Math.max(0, bytes), held);
        this.used -= n;
        held -= n;
      },
      release: () => {
        this.used -= held;
        held = 0;
      },
    };
  }
}

/** Concurrent operations per key (e.g. per client IP bucket). */
export class KeyedConcurrency {
  private active = new Map<string, number>();
  constructor(readonly max: number) {}
  /** Returns a release function, or undefined when the key is at its limit. 0 = unlimited. */
  tryAcquire(key: string): (() => void) | undefined {
    const n = this.active.get(key) ?? 0;
    if (this.max > 0 && n >= this.max) return undefined;
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left > 0) this.active.set(key, left);
      else this.active.delete(key);
    };
  }
}

/** Ids remembered until their own expiry (e.g. single-use auth tokens). Bounded: oldest entries go first. */
export class ExpiringSet {
  private items = new Map<string, number>();
  /** Forgets every item. */
  clear(): void {
    this.items.clear();
  }
  constructor(
    private readonly maxKeys = 100_000,
    private readonly now: () => number = Date.now,
  ) {}
  has(id: string): boolean {
    const exp = this.items.get(id);
    if (exp === undefined) return false;
    if (exp > this.now()) return true;
    this.items.delete(id);
    return false;
  }
  /** `expiresAt` in ms */
  add(id: string, expiresAt: number) {
    if (this.items.size >= this.maxKeys) {
      const t = this.now();
      for (const [k, v] of this.items) if (v <= t) this.items.delete(k);
      for (const k of this.items.keys()) {
        if (this.items.size < this.maxKeys) break;
        this.items.delete(k);
      }
    }
    this.items.set(id, expiresAt);
  }
}
