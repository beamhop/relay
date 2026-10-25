/** The LRU (with optional TTL) lives in @beamhop/sdk/util; re-exported under this package's old name. */
export { Lru as LruCache } from "@beamhop/sdk/util";

/**
 * Map of short-lived single-use tokens (challenges, NIP-98 replay ids).
 * Never evicts live entries: when full (after dropping expired ones) `set` refuses and returns false,
 * so a flood can't push out a pending challenge or a replay-protection id.
 */
export class ExpiringMap<V> {
  private map = new Map<string, { v: V; exp: number }>();
  /** earliest time at which pruning can free anything (avoids an O(n) scan on every set while full) */
  private nextPruneAt = 0;
  constructor(
    private readonly max = 10_000,
    private readonly now: () => number = Date.now,
  ) {}
  set(key: string, v: V, ttlMs: number): boolean {
    const n = this.now();
    if (!this.map.has(key) && this.map.size >= this.max) {
      if (n >= this.nextPruneAt) this.prune();
      if (this.map.size >= this.max) return false;
    }
    this.map.set(key, { v, exp: n + ttlMs });
    return true;
  }
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }
  /** Returns the value and removes it (single use). */
  take(key: string): V | undefined {
    const v = this.get(key);
    this.map.delete(key);
    return v;
  }
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  prune(): void {
    const n = this.now();
    let earliest = Infinity;
    for (const [k, e] of this.map) {
      if (e.exp < n) this.map.delete(k);
      else if (e.exp < earliest) earliest = e.exp;
    }
    this.nextPruneAt = earliest === Infinity ? 0 : earliest + 1;
  }
  get size() {
    return this.map.size;
  }
}
