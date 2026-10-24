import type { Filter, NostrEvent } from "@beamhop/sdk";

/**
 * Burst (bucket capacity) of the general REQ/COUNT bucket per connection; per address it's 4× that.
 * Clients open many subscriptions at once on connect (feeds, profiles, notifications), so this stays
 * generous; expensive reads (search) have their own buckets below.
 */
export const REQ_BURST = 120;
/**
 * NIP-50 search runs a synchronous full-text query on the event loop, so it gets its own, much smaller
 * buckets (per search filter) on top of the general REQ limit. Staff are exempt.
 */
export const SEARCH_PER_MINUTE = { conn: 10, connBurst: 3, ip: 30, ipBurst: 10 };
/**
 * Search query time (ms) an address / the whole relay may spend per minute. An estimate (recent average
 * query time) is charged when a search is admitted, so a burst of queued searches is bounded by these
 * budgets too; the difference to the actual time is settled after the query ran.
 */
export const SEARCH_MS_PER_MINUTE = { ip: 3_000, ipBurst: 1_500, all: 15_000, allBurst: 5_000 };
/** Bounds of the per-search time estimate charged at admission (ms). */
export const SEARCH_ESTIMATE_MS = { initial: 25, min: 10, max: 1_000 };
/** Max `limit` of a search filter (ranking cost grows with it). */
export const SEARCH_MAX_LIMIT = 100;
/** Search queries running at once, relay-wide; each waits a loop turn first so other work interleaves. */
const SEARCH_CONCURRENCY = 1;
/** Searches waiting for a slot before new ones are refused as busy. */
const SEARCH_MAX_WAITING = 64;
/** Stored queries (and their result streams) running at once per connection; further REQs wait. */
export const MAX_QUERIES_PER_CONN = 3;
/** Stored queries executing at once, relay-wide (bounds concurrent result materialization on async drivers). */
const QUERY_CONCURRENCY = 16;
const QUERY_MAX_WAITING = 1_000;
/** Estimated bytes of materialized-but-unsent stored results, per connection / per address / relay-wide. */
export const RESULT_BYTES = { conn: 32 << 20, ip: 64 << 20, all: 384 << 20 };

export type GateResult = "ok" | "busy" | "aborted";

interface Waiter {
  resolve: (r: GateResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Counting semaphore with a bounded FIFO wait queue; waiting can be cancelled with an AbortSignal. */
export class Gate {
  private active = 0;
  private waiters: Waiter[] = [];
  constructor(
    readonly limit: number,
    readonly maxWaiting = Number.POSITIVE_INFINITY,
  ) {}

  acquire(signal?: AbortSignal): Promise<GateResult> {
    if (signal?.aborted) return Promise.resolve("aborted");
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve("ok");
    }
    if (this.waiters.length >= this.maxWaiting) return Promise.resolve("busy");
    return new Promise((resolve) => {
      const w: Waiter = { resolve, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve("aborted");
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
  }

  /** Releases a slot; it is handed straight to the next waiter, if any. */
  release(): void {
    const w = this.waiters.shift();
    if (w) {
      if (w.onAbort) w.signal!.removeEventListener("abort", w.onAbort);
      w.resolve("ok");
      return;
    }
    if (this.active > 0) this.active--;
  }

  get inUse() {
    return this.active;
  }
  get waiting() {
    return this.waiters.length;
  }
}

/** Relay-wide read accounting (one per relay instance). */
export class ReadLimits {
  readonly search = new Gate(SEARCH_CONCURRENCY, SEARCH_MAX_WAITING);
  readonly queries = new Gate(QUERY_CONCURRENCY, QUERY_MAX_WAITING);
  /** estimated bytes of stored results held for sending, relay-wide and per address */
  resultBytes = 0;
  readonly resultBytesByIp = new Map<string, number>();
  /** moving average of search query time (ms), charged up front when a search is admitted */
  private searchMs: number = SEARCH_ESTIMATE_MS.initial;

  get searchEstimateMs(): number {
    return Math.min(SEARCH_ESTIMATE_MS.max, Math.max(SEARCH_ESTIMATE_MS.min, this.searchMs));
  }

  recordSearchMs(ms: number): void {
    this.searchMs = this.searchMs * 0.8 + ms * 0.2;
  }

  /** Reserves `bytes` of result memory unless a budget would be exceeded (a lone result always fits its connection). */
  reserve(ipKey: string, connHeld: number, bytes: number): boolean {
    if (bytes <= 0) return true; // nothing held: no per-address entry to leak
    const ipHeld = this.resultBytesByIp.get(ipKey) ?? 0;
    if (connHeld > 0 && connHeld + bytes > RESULT_BYTES.conn) return false;
    if (ipHeld > 0 && ipHeld + bytes > RESULT_BYTES.ip) return false;
    if (this.resultBytes > 0 && this.resultBytes + bytes > RESULT_BYTES.all) return false;
    this.resultBytes += bytes;
    this.resultBytesByIp.set(ipKey, ipHeld + bytes);
    return true;
  }

  release(ipKey: string, bytes: number): void {
    if (bytes <= 0) return;
    this.resultBytes = Math.max(0, this.resultBytes - bytes);
    const left = (this.resultBytesByIp.get(ipKey) ?? 0) - bytes;
    if (left > 0) this.resultBytesByIp.set(ipKey, left);
    else this.resultBytesByIp.delete(ipKey);
  }
}

export const isSearchFilter = (f: Filter) => typeof f.search === "string" && f.search.trim() !== "";

/** Rough in-memory/serialized size of an event, without serializing it. */
export function eventSize(ev: NostrEvent): number {
  let n = 300 + ev.content.length;
  for (const t of ev.tags) {
    n += 4;
    for (const v of t) n += v.length + 3;
  }
  return n;
}
