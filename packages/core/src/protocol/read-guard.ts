import type { EventStore } from "@beamhop/sdk";
import { IP_RATE_FACTOR } from "../constants";
import type { RelayContext } from "../context";
import { yieldToLoop } from "./backpressure";
import type { Connection } from "./connection";
import { connBucket } from "./limits";
import { QUERY_MS_PER_MINUTE, REQ_BURST, SEARCH_MS_PER_MINUTE, SEARCH_PER_MINUTE } from "./read-limits";

// ------------------------------------------------------------------ rate limiting for reads

export type ReadRate = "staff" | "ok" | "limited" | "error";

/** Refusal for a read whose rate limit couldn't be determined (the user lookup failed). */
export const READ_RATE_ERROR = "error: internal error";

/**
 * General REQ/COUNT/NEG-OPEN bucket. The burst is capped (REQ_BURST) so a client can't have a whole
 * minute's allowance executed back to back. "error" when a user lookup failed: the read is refused,
 * but answered.
 */
export async function readRate(ctx: RelayContext, conn: Connection): Promise<ReadRate> {
  try {
    return await takeReadRate(ctx, conn);
  } catch (err) {
    ctx.logger.warn("user lookup for read limits failed", { err: String(err) });
    return "error";
  }
}

async function takeReadRate(ctx: RelayContext, conn: Connection): Promise<ReadRate> {
  const def = ctx.s().limits.reqPerMinute;
  let limit = def;
  let override = false;
  for (const pk of conn.authedPubkeys) {
    const u = await ctx.users.get(pk);
    if (ctx.users.isStaff(pk, u)) return "staff";
    const o = u?.rateLimit?.reqPerMinute;
    if (o !== undefined) {
      limit = override ? Math.max(limit, o) : o;
      override = true;
    }
  }
  if (!ctx.rate.take(connBucket("req", conn.id), limit, 1, Math.min(limit, REQ_BURST))) return "limited";
  if (override) return "ok";
  const ipLimit = def * IP_RATE_FACTOR;
  return ctx.rate.take(`req:ip:${conn.ipKey}`, ipLimit, 1, Math.min(ipLimit, REQ_BURST * IP_RATE_FACTOR)) ? "ok" : "limited";
}

/** Search time charged when a search was admitted (settled against the actual time afterwards). */
export interface SearchCharge {
  staff: boolean;
  /** ms charged up front to the relay-wide and (non-staff) per-address budgets */
  prepaid: number;
}

/**
 * Admission for NIP-50 search (synchronous full-text queries): per-request buckets plus query-time
 * budgets. The estimated query time is charged right away, so searches already queued count against
 * the budgets and a burst can't line up more work than the budgets allow.
 */
export function admitSearch(ctx: RelayContext, conn: Connection, staff: boolean): SearchCharge | { reason: string } {
  if (staff) return { staff, prepaid: 0 };
  const S = SEARCH_PER_MINUTE;
  const M = SEARCH_MS_PER_MINUTE;
  const est = ctx.reads.searchEstimateMs;
  const ipMs = `searchms:ip:${conn.ipKey}`;
  if (!ctx.rate.take(connBucket("search", conn.id), S.conn, 1, S.connBurst)) return { reason: "rate-limited: too many searches, slow down" };
  if (!ctx.rate.take(`search:ip:${conn.ipKey}`, S.ip, 1, S.ipBurst)) return { reason: "rate-limited: too many searches, slow down" };
  if (!ctx.rate.take(ipMs, M.ip, est, M.ipBurst)) return { reason: "rate-limited: too many searches, slow down" };
  if (!ctx.rate.take("searchms:all", M.all, est, M.allBurst)) {
    ctx.rate.refund(ipMs, M.ip, est, M.ipBurst);
    return { reason: "rate-limited: search is busy, try again shortly" };
  }
  return { staff, prepaid: est };
}

export type Guarded<T> = { value: T } | { reason: string } | { aborted: true };

/**
 * Runs a search: one at a time relay-wide. The search slot is taken before anything else (in particular
 * before a relay-wide query slot), so searches waiting their turn never hold slots plain REQs need.
 * `fn` gets `timed`, which runs the actual query after a loop turn (so I/O and other clients interleave
 * with the synchronous full-text work) and measures it; the measured time settles the prepaid charge.
 */
export async function runSearch<T>(
  ctx: RelayContext,
  conn: Connection,
  charge: SearchCharge,
  signal: AbortSignal | undefined,
  fn: (timed: <Q>(q: () => Promise<Q>) => Promise<Q>) => Promise<Guarded<T>>,
): Promise<Guarded<T>> {
  let ms = 0;
  const settle = () => {
    const M = SEARCH_MS_PER_MINUTE;
    const delta = ms - charge.prepaid;
    if (delta > 0) {
      ctx.rate.charge("searchms:all", M.all, delta, M.allBurst);
      if (!charge.staff) ctx.rate.charge(`searchms:ip:${conn.ipKey}`, M.ip, delta, M.ipBurst);
    } else if (delta < 0) {
      ctx.rate.refund("searchms:all", M.all, -delta, M.allBurst);
      if (!charge.staff) ctx.rate.refund(`searchms:ip:${conn.ipKey}`, M.ip, -delta, M.ipBurst);
    }
  };
  const slot = await ctx.reads.search.acquire(signal);
  if (slot !== "ok") {
    settle();
    return slot === "aborted" ? { aborted: true } : { reason: "rate-limited: search is busy, try again shortly" };
  }
  try {
    return await fn(async (q) => {
      await yieldToLoop();
      if (signal?.aborted || conn.closed) throw new SearchAborted();
      const t0 = performance.now();
      try {
        return await q();
      } finally {
        ms += performance.now() - t0;
        ctx.reads.recordSearchMs(performance.now() - t0);
      }
    });
  } catch (err) {
    if (err instanceof SearchAborted) return { aborted: true };
    throw err;
  } finally {
    ctx.reads.search.release();
    settle();
  }
}

class SearchAborted extends Error {}

/** Returns the prepaid estimate of a search that never ran. */
export function refundSearch(ctx: RelayContext, conn: Connection, charge: SearchCharge): void {
  if (!(charge.prepaid > 0)) return;
  const M = SEARCH_MS_PER_MINUTE;
  ctx.rate.refund("searchms:all", M.all, charge.prepaid, M.allBurst);
  if (!charge.staff) ctx.rate.refund(`searchms:ip:${conn.ipKey}`, M.ip, charge.prepaid, M.ipBurst);
}

/** Runs `fn` holding one of the relay-wide stored-query slots. */
export async function withQuerySlot<T>(ctx: RelayContext, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<Guarded<T>> {
  const gate = await ctx.reads.queries.acquire(signal);
  if (gate === "aborted") return { aborted: true };
  if (gate === "busy") return { reason: "rate-limited: relay is busy, try again shortly" };
  try {
    return { value: await fn() };
  } finally {
    ctx.reads.queries.release();
  }
}

/** The event store calls reads make (metered per connection for plain reads, see meteredStore). */
export type ReadStore = Pick<EventStore, "query" | "count" | "queryIdsForSync">;

/**
 * Admission for plain (non-search) stored reads: refused while the address's or the relay-wide query-time
 * budget is in debt. Staff are exempt (their time still counts relay-wide).
 */
export function admitQuery(ctx: RelayContext, conn: Connection, staff: boolean): string | undefined {
  if (staff) return undefined;
  const Q = QUERY_MS_PER_MINUTE;
  if (!ctx.rate.take(`queryms:ip:${conn.ipKey}`, Q.ip, 0, Q.ipBurst)) return "rate-limited: too many expensive queries, slow down";
  if (!ctx.rate.take("queryms:all", Q.all, 0, Q.allBurst)) return "rate-limited: relay is busy, try again shortly";
  return undefined;
}

/** The event store with each query's measured time charged to the query-time budgets (QUERY_MS_PER_MINUTE). */
export function meteredStore(ctx: RelayContext, conn: Connection, staff: boolean): ReadStore {
  const events = ctx.stores.events;
  const Q = QUERY_MS_PER_MINUTE;
  const timed = async <T>(q: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await q();
    } finally {
      const ms = performance.now() - t0;
      ctx.rate.charge("queryms:all", Q.all, ms, Q.allBurst);
      if (!staff) ctx.rate.charge(`queryms:ip:${conn.ipKey}`, Q.ip, ms, Q.ipBurst);
    }
  };
  return {
    query: (filters, opts) => timed(() => events.query(filters, opts)),
    count: (filters) => timed(() => events.count(filters)),
    queryIdsForSync: (filter) => timed(() => events.queryIdsForSync(filter)),
  };
}

export function authReadDenied(ctx: RelayContext, conn: Connection): string | undefined {
  const { access } = ctx.s();
  if ((access.authForRead || access.mode === "auth-required") && conn.authedPubkeys.size === 0) return "auth-required: authentication is required to read from this relay";
  return undefined;
}
