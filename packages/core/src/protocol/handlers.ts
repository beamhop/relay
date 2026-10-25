import type { Filter, NostrEvent, ReadContext, UserRecord } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { isExpired } from "../nips/nip40";
import { verifyAuthEvent } from "../nips/nip42";
import { Negentropy, NegentropyStorage } from "../nips/nip77/negentropy";
import { processEvent } from "../pipeline/write";
import { isVisibleTo, onlyGatedKinds, restrictedSubFilters } from "../subscriptions/visibility";
import { filterWeight } from "../util/filter";
import { withPrefix } from "../util/reasons";
import { type Connection, type EventJson, type NegSession, SOFT_BUFFER_LIMIT, type Subscription } from "./connection";
import { eventSize, isSearchFilter, REQ_BURST, SEARCH_MAX_LIMIT, SEARCH_MS_PER_MINUTE, SEARCH_PER_MINUTE } from "./read-limits";
import { nowSec } from "@beamhop/sdk";

/** Max items in a negentropy session before refusing with NEG-ERR. */
export const MAX_NEG_ITEMS = 500_000;
/** Ids listed per query while preparing a negentropy session. */
const NEG_ID_PAGE = 50_000;
/** Negentropy frame size limit (bytes before hex encoding). */
const NEG_FRAME_SIZE_LIMIT = 60_000;
/** Negentropy sessions open longer than this are dropped (idle ones sooner, see NEG_IDLE_TIMEOUT_MS). */
const NEG_SESSION_TTL_MS = 5 * 60_000;
/** Negentropy sessions (open or being prepared) per connection. */
export const MAX_NEG_SESSIONS_PER_CONN = 2;
/** Items held by all open negentropy sessions and listed by NEG-OPENs being prepared, together (~72 bytes each). */
const NEG_GLOBAL_ITEM_BUDGET = 2_000_000;
/** NEG-OPENs being prepared at once, relay-wide (each may load up to MAX_NEG_ITEMS ids). */
const NEG_OPEN_CONCURRENCY = 4;
/** NEG-MSG payload (hex chars) per connection per minute; per address it's IP_RATE_FACTOR times that. */
const NEG_MSG_HEX_PER_MINUTE = 32 << 20;
/** Max sync candidates checked one by one against visibility rules (plugin hooks, many private events). */
const MAX_VISIBILITY_SCAN = 50_000;
/** Sum of filterWeight() over a connection's open subscriptions. */
export const MAX_FILTER_WEIGHT_PER_CONN = 20_000;
/** EVENTs a connection may have awaiting their OK. */
export const MAX_INFLIGHT_EVENTS = 100;
/** The same for staff, allow-listed IPs and users with a rate-limit override (bridges, importers). */
export const MAX_INFLIGHT_EVENTS_TRUSTED = 1_000;
/**
 * Inbound messages per connection per minute (one-minute burst), checked before any expensive work
 * (signature verification, queries). Per address the limit is MESSAGE_IP_FACTOR times that. CLOSE and
 * NEG-CLOSE are exempt, as are relay staff and allow-listed IPs; users with a rate-limit override get
 * a higher per-connection limit and no per-address bucket (their own limits apply).
 */
export const MESSAGES_PER_MINUTE = 1200;
export const MESSAGE_IP_FACTOR = 4;
/** Pubkeys one connection may authenticate as (NIP-42). */
export const MAX_AUTHED_PUBKEYS = 10;
const AUTH_PER_MINUTE = 30;
/**
 * Stored results are paced to keep the client's send buffer below half of SOFT_BUFFER_LIMIT (where live
 * delivery starts dropping events), so a backfill doesn't crowd out live events on other subscriptions.
 * A client that doesn't drain within drainTimeoutMs is disconnected.
 */
export const BACKPRESSURE = { drainTimeoutMs: 10_000, pollMs: 25, highWater: SOFT_BUFFER_LIMIT / 2 };
/** Interval of the relay-wide sweep of expired negentropy sessions. */
export const NEG_SWEEP_MS = 30_000;
/** NEG-OPENs being prepared at once per client address; more wait briefly for a slot (NEG_OPEN_WAIT_MS). */
const NEG_OPEN_PER_IP = 2;
const NEG_OPEN_WAIT_MS = 3_000;
/** Max live events buffered while a stored query is in flight. */
const MAX_PENDING_LIVE = 1000;
const IP_RATE_FACTOR = 4;
const VISIBILITY_BATCH = 500;
/** Bytes of events (at maxEventBytes each) loaded at once for visibility checks. */
const VISIBILITY_BATCH_BYTES = 4 << 20;
/**
 * Rows a REQ may load beyond its filters' first pages, to refill limits taken by events the connection
 * can't see (see streamStored).
 */
export const MAX_REFILL_SCAN = 5_000;
/** Smallest refill page: a few hidden events shouldn't cost a query per missing result. */
const REFILL_MIN_PAGE = 20;
/** Queries per search filter while raising its limit past hidden results (search can't be paged). */
const SEARCH_REFILL_ROUNDS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const yieldToLoop = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ EVENT

export function handleEvent(ctx: RelayContext, conn: Connection, event: NostrEvent, bytes: number): void {
  // bounded: the per-connection queue would otherwise grow without limit when events arrive faster than they're stored
  if (conn.inflightEvents >= conn.maxInflightEvents) return conn.ok(event.id, false, "rate-limited: too many events awaiting OK; slow down");
  conn.inflightEvents++;
  // serialize per connection so OK messages keep submission order
  conn.queue = conn.queue.then(async () => {
    try {
      if (conn.closed) return;
      const res = await processEvent(ctx, event, { conn, source: "ws", bytes });
      conn.ok(event.id, res.ok, res.message);
    } finally {
      conn.inflightEvents--;
    }
  });
}

/**
 * Waits while the client's send buffer is above the soft limit (stored results honour backpressure
 * like live delivery). Returns false when the connection closed, the subscription was cancelled, or
 * the client didn't drain in time (it is then disconnected as a slow consumer).
 */
async function waitForDrain(conn: Connection, signal?: AbortSignal): Promise<boolean> {
  const buffered = () => conn.socket.bufferedAmount?.() ?? 0;
  // RelaySocket has no drain event, so this polls
  if (buffered() <= BACKPRESSURE.highWater) return !conn.closed;
  const deadline = Date.now() + BACKPRESSURE.drainTimeoutMs;
  while (!conn.closed && !signal?.aborted) {
    await sleep(BACKPRESSURE.pollMs);
    if (buffered() <= BACKPRESSURE.highWater) return !conn.closed && !signal?.aborted;
    if (Date.now() >= deadline) {
      conn.close(1008, "slow consumer");
      return false;
    }
  }
  return false;
}

// ------------------------------------------------------------------ rate limiting for reads

type ReadRate = "staff" | "ok" | "limited" | "error";

/** Refusal for a read whose rate limit couldn't be determined (the user lookup failed). */
const READ_RATE_ERROR = "error: internal error";

/**
 * General REQ/COUNT/NEG-OPEN bucket. The burst is capped (REQ_BURST) so a client can't have a whole
 * minute's allowance executed back to back. "error" when a user lookup failed: the read is refused,
 * but answered.
 */
async function readRate(ctx: RelayContext, conn: Connection): Promise<ReadRate> {
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
  if (!ctx.rate.take(`req:conn:${conn.id}`, limit, 1, Math.min(limit, REQ_BURST))) return "limited";
  if (override) return "ok";
  const ipLimit = def * IP_RATE_FACTOR;
  return ctx.rate.take(`req:ip:${conn.ipKey}`, ipLimit, 1, Math.min(ipLimit, REQ_BURST * IP_RATE_FACTOR)) ? "ok" : "limited";
}

/** Search time charged when a search was admitted (settled against the actual time afterwards). */
interface SearchCharge {
  staff: boolean;
  /** ms charged up front to the relay-wide and (non-staff) per-address budgets */
  prepaid: number;
}

/**
 * Admission for NIP-50 search (synchronous full-text queries): per-request buckets plus query-time
 * budgets. The estimated query time is charged right away, so searches already queued count against
 * the budgets and a burst can't line up more work than the budgets allow.
 */
function admitSearch(ctx: RelayContext, conn: Connection, staff: boolean): SearchCharge | { reason: string } {
  if (staff) return { staff, prepaid: 0 };
  const S = SEARCH_PER_MINUTE;
  const M = SEARCH_MS_PER_MINUTE;
  const est = ctx.reads.searchEstimateMs;
  const ipMs = `searchms:ip:${conn.ipKey}`;
  if (!ctx.rate.take(`search:conn:${conn.id}`, S.conn, 1, S.connBurst)) return { reason: "rate-limited: too many searches, slow down" };
  if (!ctx.rate.take(`search:ip:${conn.ipKey}`, S.ip, 1, S.ipBurst)) return { reason: "rate-limited: too many searches, slow down" };
  if (!ctx.rate.take(ipMs, M.ip, est, M.ipBurst)) return { reason: "rate-limited: too many searches, slow down" };
  if (!ctx.rate.take("searchms:all", M.all, est, M.allBurst)) {
    ctx.rate.refund(ipMs, M.ip, est, M.ipBurst);
    return { reason: "rate-limited: search is busy, try again shortly" };
  }
  return { staff, prepaid: est };
}

type Guarded<T> = { value: T } | { reason: string } | { aborted: true };

/**
 * Runs a search: one at a time relay-wide. The search slot is taken before anything else (in particular
 * before a relay-wide query slot), so searches waiting their turn never hold slots plain REQs need.
 * `fn` gets `timed`, which runs the actual query after a loop turn (so I/O and other clients interleave
 * with the synchronous full-text work) and measures it; the measured time settles the prepaid charge.
 */
async function runSearch<T>(
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
function refundSearch(ctx: RelayContext, conn: Connection, charge: SearchCharge): void {
  if (!(charge.prepaid > 0)) return;
  const M = SEARCH_MS_PER_MINUTE;
  ctx.rate.refund("searchms:all", M.all, charge.prepaid, M.allBurst);
  if (!charge.staff) ctx.rate.refund(`searchms:ip:${conn.ipKey}`, M.ip, charge.prepaid, M.ipBurst);
}

/** Runs `fn` holding one of the relay-wide stored-query slots. */
async function withQuerySlot<T>(ctx: RelayContext, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<Guarded<T>> {
  const gate = await ctx.reads.queries.acquire(signal);
  if (gate === "aborted") return { aborted: true };
  if (gate === "busy") return { reason: "rate-limited: relay is busy, try again shortly" };
  try {
    return { value: await fn() };
  } finally {
    ctx.reads.queries.release();
  }
}

export function authReadDenied(ctx: RelayContext, conn: Connection): string | undefined {
  const { access } = ctx.s();
  if ((access.authForRead || access.mode === "auth-required") && conn.authedPubkeys.size === 0) return "auth-required: authentication is required to read from this relay";
  return undefined;
}

/** Max potentially-private events inspected per COUNT / NEG-OPEN before refusing the filter as too broad. */
export const MAX_PRIVATE_SCAN = 5_000;
/** Max search matches checked one by one for a COUNT under plugin visibility hooks (search can't list ids cheaply). */
export const MAX_SEARCH_COUNT_SCAN = 1_000;

/**
 * Stored events matching `filters` that the connection may not see under the built-in privacy rules, which
 * only affect a known subset of events (restrictedSubFilters), as id → created_at. Returns null when too many
 * candidates exist to check cheaply (caller should refuse). Candidates are listed by id and checked in
 * small batches: anyone can store thousands of them (gift wraps, DMs) near maxEventBytes each.
 */
async function hiddenIds(ctx: RelayContext, conn: Connection, filters: Filter[], rctx: ReadContext): Promise<Map<string, number> | null> {
  const subs = filters.flatMap((f) => restrictedSubFilters(ctx, f, conn.authedPubkeys));
  const hidden = new Map<string, number>();
  if (!subs.length) return hidden;
  const candidates = new Map<string, { id: string; created_at: number }>();
  for (const { limit: _x, ...f } of subs) {
    const items = await candidateIds(ctx, f, MAX_PRIVATE_SCAN);
    if (!items) return null;
    for (const it of items) candidates.set(it.id, it);
    if (candidates.size > MAX_PRIVATE_SCAN) return null;
  }
  const visible = await filterVisible(ctx, conn, [...candidates.values()], rctx);
  if (!visible) return null;
  const seen = new Set(visible.map((it) => it.id));
  for (const [id, it] of candidates) if (!seen.has(id)) hidden.set(id, it.created_at);
  return hidden;
}

/**
 * (id, created_at) of the events matching `f`, or null when more than `max` match. Search can't be listed
 * by id (the store applies it only when loading events), so search matches are counted first and loaded
 * only when at most MAX_SEARCH_COUNT_SCAN match (searches run one at a time relay-wide).
 */
async function candidateIds(ctx: RelayContext, f: Filter, max: number): Promise<{ id: string; created_at: number }[] | null> {
  if (!isSearchFilter(f)) {
    const items = await ctx.stores.events.queryIdsForSync({ ...f, limit: max + 1 });
    return items.length > max ? null : items;
  }
  const cap = Math.min(max, MAX_SEARCH_COUNT_SCAN);
  if ((await ctx.stores.events.count([f])) > cap) return null;
  const evs = await ctx.stores.events.query([{ ...f, limit: cap + 1 }], { maxLimit: cap + 1 });
  return evs.length > cap ? null : evs.map((ev) => ({ id: ev.id, created_at: ev.created_at }));
}

/**
 * Exact count of the events matching `filters` that the connection may see, when plugin visibility hooks
 * may hide anything: candidate ids are listed (cheap), then checked in batches like sync candidates.
 * Returns null when there are too many candidates to check.
 */
async function countVisible(ctx: RelayContext, conn: Connection, filters: Filter[], rctx: ReadContext): Promise<number | null> {
  const candidates = new Map<string, { id: string; created_at: number }>();
  for (const f of filters) {
    const items = await candidateIds(ctx, f, MAX_VISIBILITY_SCAN);
    if (!items) return null;
    for (const it of items) candidates.set(it.id, it);
    if (candidates.size > MAX_VISIBILITY_SCAN) return null;
  }
  const visible = await filterVisible(ctx, conn, [...candidates.values()], rctx);
  return visible ? visible.length : null;
}

/** Events loaded at once for visibility checks: at most VISIBILITY_BATCH, and about VISIBILITY_BATCH_BYTES. */
function visibilityBatch(ctx: RelayContext): number {
  return Math.max(16, Math.min(VISIBILITY_BATCH, Math.floor(VISIBILITY_BATCH_BYTES / ctx.s().limits.maxEventBytes)));
}

/**
 * Keeps the sync candidates the connection may see, checking each event (built-in rules and plugin
 * hooks) in batches. Returns null when there are too many candidates to check.
 */
async function filterVisible(
  ctx: RelayContext,
  conn: Connection,
  items: { id: string; created_at: number }[],
  rctx: ReadContext,
): Promise<{ id: string; created_at: number }[] | null> {
  if (items.length > MAX_VISIBILITY_SCAN) return null;
  const out: { id: string; created_at: number }[] = [];
  const size = visibilityBatch(ctx);
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const events = await ctx.stores.events.query([{ ids: batch.map((it) => it.id) }], { maxLimit: batch.length });
    const byId = new Map(events.map((ev) => [ev.id, ev]));
    for (const it of batch) {
      const ev = byId.get(it.id);
      // gone since the id query: leave it out rather than disclose it unchecked
      if (ev && isVisibleTo(ctx, ev, conn, rctx)) out.push(it);
    }
    if (conn.closed) return out;
    await yieldToLoop(); // sqlite queries are synchronous: let other connections in between batches
  }
  return out;
}

// ------------------------------------------------------------------ REQ / CLOSE

export function cancelSub(ctx: RelayContext, sub: Subscription): void {
  sub.abort.abort();
  ctx.subs.remove(sub);
  if (sub.conn.subs.get(sub.id) === sub) {
    sub.conn.subs.delete(sub.id);
    sub.conn.filterWeight -= sub.weight;
  }
}

/** A stored result held for sending; its bytes count against the result budgets until sent or dropped. */
interface Loaded {
  ev: NostrEvent;
  size: number;
}

/** Visible stored results of one filter (or of filters queried together), newest first. */
interface ResultStream {
  items: (Loaded | undefined)[];
  pos: number;
  /** results it may still deliver: its filter's limit, counting visible events only */
  left: number;
  /** loads the next, older page once `items` are used up; null when there's nothing more to load */
  more: ((left: number) => Promise<NostrEvent[] | null>) | null;
}

/** Ends a REQ's stored results early: with a reason the subscription is refused, without one it was cancelled. */
class StreamEnded extends Error {
  constructor(readonly reason?: string) {
    super(reason);
  }
}

/** Store order: newest first, ties by lowest id (NIP-01). */
const storeOrder = (a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Loads a filter's results older than its first page `first`, within the REQ's scan budget. Pages grow
 * while hidden events keep taking their slots. `until` is inclusive, so the events of the oldest second
 * already seen are read again and skipped.
 */
function olderPages(ctx: RelayContext, f: Filter, first: NostrEvent[], scan: { left: number }, signal: AbortSignal) {
  const maxLimit = ctx.s().limits.maxLimit;
  let full = first.length >= f.limit!;
  let until = Number.POSITIVE_INFINITY;
  let page = REFILL_MIN_PAGE;
  const tie = new Set<string>();
  const advance = (evs: NostrEvent[]) => {
    const last = evs[evs.length - 1];
    if (!last) return;
    if (last.created_at !== until) tie.clear();
    until = last.created_at;
    for (const ev of evs) if (ev.created_at === until) tie.add(ev.id);
  };
  advance(first);
  return async (left: number): Promise<NostrEvent[] | null> => {
    if (!full) return null;
    const ask = Math.min(Math.max(2 * left, page) + tie.size, maxLimit, scan.left);
    page *= 2;
    // scan budget used up, or a page's worth of results share one second
    if (ask <= tie.size) return null;
    await yieldToLoop(); // sqlite queries are synchronous: let other connections in between pages
    const r = await withQuerySlot(ctx, signal, () => ctx.stores.events.query([{ ...f, until, limit: ask }], { maxLimit: ask, signal }));
    if ("aborted" in r) throw new StreamEnded();
    if ("reason" in r) throw new StreamEnded(r.reason);
    const evs = r.value;
    scan.left -= evs.length;
    full = evs.length >= ask;
    const fresh = evs.filter((ev) => !tie.has(ev.id));
    advance(evs);
    return fresh;
  };
}

/**
 * Visible results of a search filter. Search picks results by rank, which can't be paged by time: the
 * limit is raised by the number of hidden events among the top results until the top `limit` visible
 * ones are known (each round's visible results all belong to them), within SEARCH_REFILL_ROUNDS queries,
 * maxLimit results and the REQ's scan budget.
 */
async function rankVisible(
  ctx: RelayContext,
  f: Filter,
  visible: (ev: NostrEvent) => boolean,
  scan: { left: number },
  signal: AbortSignal,
): Promise<NostrEvent[]> {
  const want = f.limit!;
  const maxLimit = ctx.s().limits.maxLimit;
  let n = want;
  for (let round = 1; ; round++) {
    const evs = await ctx.stores.events.query([{ ...f, limit: n }], { maxLimit: n, signal });
    const vis = evs.filter(visible);
    const next = Math.min(want + evs.length - vis.length, maxLimit, scan.left);
    if (evs.length < n || next <= n || round >= SEARCH_REFILL_ROUNDS || signal.aborted) return vis;
    scan.left -= next;
    n = next;
  }
}

/**
 * Runs a REQ's stored query and sends the results. Materialized results count against per-connection,
 * per-address and relay-wide memory budgets until sent. Returns the number sent, or null when the
 * subscription ended (cancelled, refused, connection gone).
 *
 * A filter's limit counts the events this connection may see: if hidden ones (others' DMs and gift
 * wraps, private group content, events hidden by plugins) took result slots, the number of results would
 * tell how many hidden events lie in a time range, e.g. when someone sent DMs. Filters that may match
 * hidden events are queried one by one, and when hidden events took slots, older pages are loaded until
 * the limit is met or the store is exhausted. The other filters run as one query, as before. Results of
 * all filters are merged in store order.
 *
 * The extra scan is capped per REQ (MAX_REFILL_SCAN rows), so planted hidden events can't make a REQ
 * arbitrarily expensive. Past the cap the client gets fewer results than its limit (then EOSE), and that
 * gap reflects hidden events again. It takes MAX_REFILL_SCAN hidden events in the range: one pair's DMs
 * rarely get there, but anyone can store that many gift wraps or DMs addressed to someone. Refusing the
 * REQ at the cap would leak about as much (a bit per query) and break broad filters on relays where most
 * recent events are gift wraps.
 */
async function streamStored(
  ctx: RelayContext,
  conn: Connection,
  sub: Subscription,
  queryFilters: Filter[],
  rctx: ReadContext,
  search: SearchCharge | null,
): Promise<number | null> {
  const subId = sub.id;
  const L = ctx.s().limits;
  const signal = sub.abort.signal;
  const refuse = (reason: string) => {
    cancelSub(ctx, sub);
    conn.closedSub(subId, reason);
    return null;
  };
  const now = nowSec();
  const visible = (ev: NostrEvent) => !isExpired(ev, now) && isVisibleTo(ctx, ev, conn, rctx);
  const pluginHooks = ctx.hooks.counts.visibility > 0;
  const gapped = queryFilters.filter((f) => pluginHooks || restrictedSubFilters(ctx, f, conn.authedPubkeys).length > 0);
  const plain = queryFilters.filter((f) => !gapped.includes(f));
  const scan = { left: MAX_REFILL_SCAN };
  // pages[0]: the plain filters' union; pages[i]: first page of gapped[i - 1]
  let pages: NostrEvent[][];
  try {
    const run = async () => {
      const out = [plain.length ? await ctx.stores.events.query(plain, { maxLimit: L.maxLimit, signal }) : []];
      for (const f of gapped) {
        if (signal.aborted) break;
        out.push(isSearchFilter(f) ? await rankVisible(ctx, f, visible, scan, signal) : await ctx.stores.events.query([f], { maxLimit: L.maxLimit, signal }));
      }
      return out;
    };
    const r = search
      ? await runSearch(ctx, conn, search, signal, (timed) => withQuerySlot(ctx, signal, () => timed(run)))
      : await withQuerySlot(ctx, signal, run);
    if ("aborted" in r) return null;
    if ("reason" in r) return refuse(r.reason);
    pages = r.value;
  } catch (err) {
    if (signal.aborted) return null;
    ctx.logger.error("REQ query failed", { err: String(err), subId });
    return refuse("error: query failed");
  }
  if (signal.aborted || conn.subs.get(subId) !== sub) return null;

  let held = 0;
  const hold = (bytes: number) => {
    if (!ctx.reads.reserve(conn.ipKey, conn.resultBytes, bytes)) return false;
    held += bytes;
    conn.resultBytes += bytes;
    return true;
  };
  const free = (bytes: number) => {
    held -= bytes;
    conn.resultBytes -= bytes;
    ctx.reads.release(conn.ipKey, bytes);
  };
  const sum = (sizes: number[]) => sizes.reduce((a, b) => a + b, 0);
  /** The visible events of a loaded page (whose bytes are held); the others are released at once. */
  const keep = (evs: NostrEvent[], sizes: number[]): Loaded[] => {
    const out: Loaded[] = [];
    for (let i = 0; i < evs.length; i++) {
      if (visible(evs[i])) out.push({ ev: evs[i], size: sizes[i] });
      else free(sizes[i]);
    }
    return out;
  };
  const sizes = pages.map((evs) => evs.map(eventSize));
  if (!hold(sizes.reduce((a, s) => a + sum(s), 0))) {
    pages = [];
    return refuse("rate-limited: too many results in flight, try again shortly");
  }
  let results = 0;
  try {
    const streams: ResultStream[] = pages.map((evs, i) => {
      const f = gapped[i - 1];
      return {
        items: keep(evs, sizes[i]),
        pos: 0,
        left: f ? f.limit! : Number.POSITIVE_INFINITY,
        more: f && !isSearchFilter(f) ? olderPages(ctx, f, evs, scan, signal) : null,
      };
    });
    pages = []; // let hidden results be collected right away
    const head = async (s: ResultStream): Promise<Loaded | undefined> => {
      while (s.left > 0 && s.pos >= s.items.length && s.more) {
        const evs = await s.more(s.left);
        if (signal.aborted || conn.subs.get(subId) !== sub) throw new StreamEnded();
        if (!evs) {
          s.more = null;
          break;
        }
        const pageSizes = evs.map(eventSize);
        if (!hold(sum(pageSizes))) throw new StreamEnded("rate-limited: too many results in flight, try again shortly");
        s.items = keep(evs, pageSizes);
        s.pos = 0;
      }
      return s.left > 0 ? s.items[s.pos] : undefined;
    };
    const sent = sub.sentIds!;
    for (;;) {
      let from: ResultStream | undefined;
      let next: Loaded | undefined;
      for (const s of streams) {
        const h = await head(s);
        if (h && (!next || storeOrder(h.ev, next.ev) < 0)) {
          from = s;
          next = h;
        }
      }
      if (!from || !next) break;
      from.items[from.pos++] = undefined; // let sent results be collected while the rest stream out
      from.left--;
      // an event matching several filters counts for each of them, and is sent once
      if (!sent.has(next.ev.id)) {
        if (!(await waitForDrain(conn, signal))) return null;
        conn.send(["EVENT", subId, next.ev]);
        sent.add(next.ev.id);
        results++;
      }
      free(next.size);
      if (from.left <= 0) {
        // limit met: the rest of its page goes unsent
        for (let i = from.pos; i < from.items.length; i++) free(from.items[i]!.size);
        from.items = [];
        from.pos = 0;
        from.more = null;
      }
    }
  } catch (err) {
    if (err instanceof StreamEnded) return err.reason ? refuse(err.reason) : null;
    if (signal.aborted) return null;
    ctx.logger.error("REQ query failed", { err: String(err), subId });
    return refuse("error: query failed");
  } finally {
    if (held > 0) free(held);
  }
  return results;
}

export async function handleReq(ctx: RelayContext, conn: Connection, subId: string, input: Filter[]): Promise<void> {
  const started = performance.now();
  const L = ctx.s().limits;
  let filters = input;

  // NIP-01: a REQ with an existing id replaces the old subscription, even if the new one is refused
  const existing = conn.subs.get(subId);
  if (existing) cancelSub(ctx, existing);

  const denied = authReadDenied(ctx, conn);
  if (denied) return conn.closedSub(subId, denied);
  const rate = await readRate(ctx, conn);
  if (rate === "limited") return conn.closedSub(subId, "rate-limited: too many requests");
  if (rate === "error") return conn.closedSub(subId, READ_RATE_ERROR);

  if (conn.subs.size >= L.maxSubscriptions) return conn.closedSub(subId, `rate-limited: too many subscriptions (max ${L.maxSubscriptions})`);

  // NIP-04/59 privacy: filters that can only match DMs/gift wraps need auth
  if (conn.authedPubkeys.size === 0) {
    filters = filters.filter((f) => !onlyGatedKinds(f));
    if (filters.length === 0) return conn.closedSub(subId, "auth-required: authentication is required to read direct messages");
  }

  const rctx: ReadContext = { conn, subId, source: "ws" };
  let hq: { filters: Filter[] } | { reject: string };
  try {
    hq = await ctx.hooks.runQuery(filters, rctx);
  } catch (err) {
    ctx.logger.warn("query hook failed", { err: String(err) });
    return conn.closedSub(subId, "error: query policy failed");
  }
  if ("reject" in hq) return conn.closedSub(subId, withPrefix(hq.reject, "blocked"));
  filters = hq.filters;
  if (conn.closed) return;
  if (conn.subs.has(subId)) cancelSub(ctx, conn.subs.get(subId)!); // replaced concurrently
  // re-check after the awaits above: concurrent REQs all passed the first check
  else if (conn.subs.size >= L.maxSubscriptions) return conn.closedSub(subId, `rate-limited: too many subscriptions (max ${L.maxSubscriptions})`);
  // every filter value is held in the fan-out index and checked for each new event
  const weight = filterWeight(filters);
  if (conn.filterWeight + weight > MAX_FILTER_WEIGHT_PER_CONN) {
    // not retryable as is: the client has to close subscriptions or send smaller filters
    return conn.closedSub(subId, `restricted: too many filter values across this connection's subscriptions (max ${MAX_FILTER_WEIGHT_PER_CONN})`);
  }
  let search: SearchCharge | null = null;
  if (filters.some((f) => f.limit !== 0 && isSearchFilter(f))) {
    const admitted = admitSearch(ctx, conn, rate === "staff");
    if ("reason" in admitted) return conn.closedSub(subId, admitted.reason);
    search = admitted;
  }

  const sub: Subscription = { conn, id: subId, filters, pending: [], sentIds: new Set(), abort: new AbortController(), weight };
  conn.subs.set(subId, sub);
  conn.filterWeight += weight;
  ctx.subs.add(sub);

  const queryFilters = filters
    .filter((f) => f.limit !== 0)
    .map((f) => ({ ...f, limit: Math.min(f.limit ?? L.defaultLimit, L.maxLimit, isSearchFilter(f) ? SEARCH_MAX_LIMIT : Number.POSITIVE_INFINITY) }));
  let results = 0;
  if (queryFilters.length) {
    // a few stored queries (and their result streams) at a time per connection; the rest wait their turn
    const slot = await conn.queries.acquire(sub.abort.signal);
    if (slot !== "ok") {
      if (search) refundSearch(ctx, conn, search);
      return;
    }
    try {
      const sent = await streamStored(ctx, conn, sub, queryFilters, rctx, search);
      if (sent === null) return;
      results = sent;
      // never let EOSE be dropped by an overfull send buffer
      if (!(await waitForDrain(conn, sub.abort.signal))) return;
      conn.send(["EOSE", subId]);
    } finally {
      conn.queries.release();
    }
  } else {
    if (!(await waitForDrain(conn, sub.abort.signal))) return;
    conn.send(["EOSE", subId]);
  }

  const pending = sub.pending ?? [];
  const sent = sub.sentIds!;
  sub.pending = null;
  sub.sentIds = null;
  for (const ev of pending) if (!sent.has(ev.id)) conn.sendLive(subId, ev);

  ctx.bus.emit("req.executed", { connId: conn.id, subId, filters, results, durationMs: performance.now() - started, ip: conn.ip });
}

/**
 * Called by fan-out for a matched subscription. Returns true if delivered (or buffered). `serialized`
 * gives the event's JSON, computed once for all recipients.
 */
export function deliverLive(sub: Subscription, event: NostrEvent, serialized?: () => EventJson): boolean {
  if (sub.pending) {
    if (sub.pending.length >= MAX_PENDING_LIVE) sub.pending.shift();
    sub.pending.push(event);
    return true;
  }
  return sub.conn.sendLive(sub.id, event, serialized);
}

export function handleClose(ctx: RelayContext, conn: Connection, subId: string): void {
  const sub = conn.subs.get(subId);
  if (sub) cancelSub(ctx, sub);
}

// ------------------------------------------------------------------ COUNT (NIP-45)

function countDenied(ctx: RelayContext, conn: Connection, filters: Filter[]): string | undefined {
  const authed = conn.authedPubkeys;
  const within = (vals: string[] | undefined) => !!vals && vals.length > 0 && vals.every((v) => authed.has(v));
  for (const f of filters) {
    if (f.kinds?.includes(1059) && !within(f["#p"])) {
      return authed.size ? "restricted: gift wraps can only be counted for your own pubkey (#p)" : "auth-required: authentication is required to count direct messages";
    }
    if (f.kinds?.includes(4) && !within(f["#p"]) && !within(f.authors)) {
      return authed.size ? "restricted: direct messages can only be counted for your own pubkey" : "auth-required: authentication is required to count direct messages";
    }
    for (const h of f["#h"] ?? []) {
      if (!ctx.groups.isPrivateGroup(h)) continue;
      let member = false;
      for (const pk of authed) if (ctx.groups.isMember(h, pk)) member = true;
      if (!member) return authed.size ? "restricted: not a member of this group" : "auth-required: this group is private";
    }
  }
  return undefined;
}

export async function handleCount(ctx: RelayContext, conn: Connection, subId: string, input: Filter[]): Promise<void> {
  const denied = authReadDenied(ctx, conn) ?? countDenied(ctx, conn, input);
  if (denied) return conn.closedSub(subId, denied);
  const rate = await readRate(ctx, conn);
  if (rate === "limited") return conn.closedSub(subId, "rate-limited: too many requests");
  if (rate === "error") return conn.closedSub(subId, READ_RATE_ERROR);
  const started = performance.now();
  let hq: { filters: Filter[] } | { reject: string };
  try {
    hq = await ctx.hooks.runQuery(input, { conn, subId, source: "count" });
  } catch {
    return conn.closedSub(subId, "error: query policy failed");
  }
  if ("reject" in hq) return conn.closedSub(subId, withPrefix(hq.reject, "blocked"));
  let search: SearchCharge | null = null;
  if (hq.filters.some(isSearchFilter)) {
    const admitted = admitSearch(ctx, conn, rate === "staff");
    if ("reason" in admitted) return conn.closedSub(subId, admitted.reason);
    search = admitted;
  }
  // bounded per connection like REQ, so one connection's burst of COUNTs can't take every relay-wide slot
  await conn.queries.acquire();
  if (conn.closed) {
    conn.queries.release();
    if (search) refundSearch(ctx, conn, search);
    return;
  }
  try {
    const filters = hq.filters.map(({ limit: _l, ...f }) => f);
    const rctx: ReadContext = { conn, subId, source: "count" };
    const pluginHooks = ctx.hooks.counts.visibility > 0;
    // Plugin hooks may hide any event: candidates are checked one by one (in batches). Otherwise only the
    // built-in private subsets are checked. Counted first: everything counted already exists when the
    // hidden set is computed, so a private event stored in between can only lower the count.
    const work = async (): Promise<number | null> => {
      if (pluginHooks) return countVisible(ctx, conn, filters, rctx);
      const total = await ctx.stores.events.count(filters);
      const hidden = await hiddenIds(ctx, conn, filters, rctx);
      return hidden ? Math.max(0, total - hidden.size) : null;
    };
    const r = search
      ? await runSearch(ctx, conn, search, undefined, (timed) => withQuerySlot(ctx, undefined, () => timed(work)))
      : await withQuerySlot(ctx, undefined, work);
    if ("aborted" in r) return;
    if ("reason" in r) return conn.closedSub(subId, r.reason);
    const count = r.value;
    if (count === null) {
      // an "approximate" count that includes hidden events would let clients compute the hidden ones
      return conn.closedSub(
        subId,
        pluginHooks
          ? "restricted: filter matches too many events to count under this relay's visibility rules; narrow it"
          : "restricted: filter matches too many private events to count; narrow it with kinds",
      );
    }
    conn.send(["COUNT", subId, { count }]);
    ctx.bus.emit("req.executed", { connId: conn.id, subId, filters: hq.filters, results: count, durationMs: performance.now() - started, ip: conn.ip });
  } catch (err) {
    ctx.logger.error("COUNT failed", { err: String(err) });
    conn.closedSub(subId, "error: count failed");
  } finally {
    conn.queries.release();
  }
}

// ------------------------------------------------------------------ AUTH (NIP-42)

export async function handleAuth(ctx: RelayContext, conn: Connection, event: NostrEvent): Promise<void> {
  if (!ctx.rate.take(`auth:conn:${conn.id}`, AUTH_PER_MINUTE)) return conn.ok(event.id, false, "rate-limited: too many AUTH messages");
  // every authed pubkey is consulted on each REQ (rate overrides, staff) and each delivery
  const full = () => !conn.authedPubkeys.has(event.pubkey) && conn.authedPubkeys.size >= MAX_AUTHED_PUBKEYS;
  const tooMany = `restricted: too many authenticated pubkeys on this connection (max ${MAX_AUTHED_PUBKEYS})`;
  if (full()) return conn.ok(event.id, false, tooMany);
  let reason: string | undefined;
  try {
    reason = await verifyAuthEvent(ctx, conn, event);
  } catch (err) {
    ctx.logger.warn("AUTH verification failed", { err: String(err) });
    return conn.ok(event.id, false, "error: could not verify authentication, try again");
  }
  if (reason) return conn.ok(event.id, false, reason);
  if (full()) return conn.ok(event.id, false, tooMany); // concurrent AUTHs
  const isNew = !conn.authedPubkeys.has(event.pubkey);
  conn.authedPubkeys.add(event.pubkey);
  conn.ok(event.id, true, "");
  if (isNew) ctx.bus.emit("connection.auth", { connId: conn.id, pubkey: event.pubkey, ip: conn.ip });
  // after the OK: a failing user lookup must not leave the client without an answer
  try {
    applyUserLimits(ctx, conn, event.pubkey, await ctx.users.get(event.pubkey));
  } catch (err) {
    ctx.logger.warn("user lookup after AUTH failed", { err: String(err) });
  }
}

/**
 * Inbound limits of a connection follow its most privileged authenticated user: staff are exempt from
 * the message limit, users with a rate-limit override get a matching per-connection limit (and no
 * per-address bucket), and both may have more EVENTs awaiting OK.
 */
function applyUserLimits(ctx: RelayContext, conn: Connection, pubkey: string, user: UserRecord | undefined): void {
  if (ctx.users.isStaff(pubkey, user)) {
    conn.trusted = true;
    conn.ownMessageLimit = true;
    conn.maxInflightEvents = Math.max(conn.maxInflightEvents, MAX_INFLIGHT_EVENTS_TRUSTED);
    return;
  }
  const o = user?.rateLimit;
  if (!o || (o.eventsPerMinute === undefined && o.reqPerMinute === undefined)) return;
  if (o.eventsPerMinute === 0 || o.reqPerMinute === 0) {
    // an override of 0 means "unlimited" in the rate limiter (bridges, importers): no message cap either
    conn.trusted = true;
    conn.ownMessageLimit = true;
    conn.maxInflightEvents = Math.max(conn.maxInflightEvents, MAX_INFLIGHT_EVENTS_TRUSTED);
    return;
  }
  const limit = MESSAGES_PER_MINUTE + (o.eventsPerMinute ?? 0) + (o.reqPerMinute ?? 0);
  if (limit > conn.messagesPerMinute) {
    conn.messagesPerMinute = limit;
    ctx.rate.delete(`msg:conn:${conn.id}`); // restarts full at the new capacity
  }
  conn.ownMessageLimit = true;
  conn.maxInflightEvents = Math.max(conn.maxInflightEvents, MAX_INFLIGHT_EVENTS_TRUSTED);
}

// ------------------------------------------------------------------ NIP-77 negentropy

/** Removes a session and returns its items to the relay-wide budget. */
function dropNegSession(ctx: RelayContext, conn: Connection, subId: string): void {
  const s = conn.negSessions.get(subId);
  if (!s) return;
  conn.negSessions.delete(subId);
  ctx.neg.items -= s.items;
}

/** Sends NEG-ERR, which ends the subscription (NIP-77): its session, if any, is dropped too. */
export function negError(ctx: RelayContext, conn: Connection, subId: string, reason: string): void {
  dropNegSession(ctx, conn, subId);
  conn.send(["NEG-ERR", subId, reason]);
}

export function dropAllNegSessions(ctx: RelayContext, conn: Connection): void {
  for (const id of [...conn.negSessions.keys()]) dropNegSession(ctx, conn, id);
}

/** Sessions idle longer than this are closed (NIP-77 lets relays time out inactive sessions). */
const NEG_IDLE_TIMEOUT_MS = 60_000;

const negSessionExpired = (s: NegSession, now: number) => now - s.openedAt > NEG_SESSION_TTL_MS || now - s.lastActiveAt > NEG_IDLE_TIMEOUT_MS;

/** Ends this connection's sessions that are too old or idle, telling the client (NEG-ERR). */
function expireNegSessions(ctx: RelayContext, conn: Connection, now = Date.now()): void {
  for (const [id, s] of conn.negSessions) if (negSessionExpired(s, now)) negError(ctx, conn, id, "closed: negentropy session timed out");
}

/**
 * Drops expired sessions on every connection. Runs on a timer and whenever the relay-wide budget is
 * exhausted, so idle sessions (clients that never send NEG-CLOSE) can't hold the budget.
 */
export function sweepNegSessions(ctx: RelayContext, now = Date.now()): void {
  for (const conn of ctx.conns.values()) if (conn.negSessions.size) expireNegSessions(ctx, conn, now);
}


export async function handleNegOpen(ctx: RelayContext, conn: Connection, subId: string, filter: Filter, message: string): Promise<void> {
  const negErr = (reason: string) => negError(ctx, conn, subId, reason);
  // NIP-77: opening an existing id closes the old session first, even if the new one is refused
  dropNegSession(ctx, conn, subId);
  expireNegSessions(ctx, conn);
  const denied = authReadDenied(ctx, conn);
  if (denied) return negErr(denied);
  if (conn.authedPubkeys.size === 0 && onlyGatedKinds(filter)) return negErr("auth-required: authentication is required to sync direct messages");
  const rate = await readRate(ctx, conn);
  if (rate === "limited") return negErr("rate-limited: too many requests");
  if (rate === "error") return negErr(READ_RATE_ERROR);
  if (conn.negSessions.size + conn.negOpening >= MAX_NEG_SESSIONS_PER_CONN) {
    return negErr(`blocked: too many negentropy sessions (max ${MAX_NEG_SESSIONS_PER_CONN})`);
  }
  // preparation slots: few relay-wide, and a couple per address so a single client can't hold them all.
  // A NEG-OPEN that finds them taken waits briefly (normal clients open their two sessions back to back).
  conn.negOpening++;
  const busy = () => ctx.neg.opening >= NEG_OPEN_CONCURRENCY || (ctx.neg.openingByIp.get(conn.ipKey) ?? 0) >= NEG_OPEN_PER_IP;
  const deadline = Date.now() + NEG_OPEN_WAIT_MS;
  while (busy()) {
    if (conn.closed || Date.now() >= deadline) {
      conn.negOpening--;
      return conn.closed ? undefined : negErr("rate-limited: too many syncs starting at once, try again shortly");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  ctx.neg.opening++;
  ctx.neg.openingByIp.set(conn.ipKey, (ctx.neg.openingByIp.get(conn.ipKey) ?? 0) + 1);
  try {
    await openNegSession(ctx, conn, subId, filter, message);
  } finally {
    conn.negOpening--;
    ctx.neg.opening--;
    const left = (ctx.neg.openingByIp.get(conn.ipKey) ?? 1) - 1;
    if (left > 0) ctx.neg.openingByIp.set(conn.ipKey, left);
    else ctx.neg.openingByIp.delete(conn.ipKey);
  }
}

async function openNegSession(ctx: RelayContext, conn: Connection, subId: string, filter: Filter, message: string): Promise<void> {
  const negErr = (reason: string) => negError(ctx, conn, subId, reason);
  const rctx: ReadContext = { conn, subId, source: "sync" };
  const hq = await ctx.hooks.runQuery([filter], rctx).catch(() => ({ reject: "error: query policy failed" }));
  if ("reject" in hq) return negErr(withPrefix(hq.reject, "blocked"));

  // a hook may rewrite the filter into several (union) or none (match nothing)
  const syncFilters = hq.filters.map(({ limit: _limit, ...f }) => f);
  if (syncFilters.some((f) => f.search !== undefined)) return negErr("unsupported: search filters cannot be used for sync");
  // Ids are listed page by page straight into the session's typed arrays (no object per id is kept), and count
  // against the relay-wide item budget while they are listed, so syncs being prepared can't exhaust memory either.
  const storage = new NegentropyStorage();
  let listed = 0;
  try {
    let exclude: { id: string; created_at: number }[] = [];
    try {
      for (const f of syncFilters) {
        const refused = await listSyncIds(ctx, f, storage, (n) => {
          ctx.neg.items += n;
          listed += n;
        });
        if (refused) return negErr(refused);
        if (conn.closed) return;
      }
      // ids are disclosed to the client, so everything it may not read must go. The hidden set is
      // computed after the ids, so every listed id already existed when it was computed. Under plugin
      // visibility hooks, or with too many private candidates, every listed id is checked instead.
      const hidden = ctx.hooks.counts.visibility > 0 ? null : await hiddenIds(ctx, conn, syncFilters, rctx);
      if (hidden) exclude = [...hidden].map(([id, created_at]) => ({ id, created_at }));
      else {
        const items = storage.inserted > MAX_VISIBILITY_SCAN ? null : storage.pendingItems();
        const visible = items && (await filterVisible(ctx, conn, items, rctx));
        if (!items || !visible) return negErr("blocked: filter matches too many events to check against this relay's visibility rules; narrow it");
        const ok = new Set(visible.map((it) => it.id));
        exclude = items.filter((it) => !ok.has(it.id));
      }
    } catch (err) {
      ctx.logger.error("NEG-OPEN query failed", { err: String(err) });
      return negErr("error: query failed");
    }
    if (conn.closed) return;
    storage.seal(exclude);

    const neg = new Negentropy(storage, NEG_FRAME_SIZE_LIMIT);
    let out: string | null;
    try {
      out = neg.reconcile(message).output;
    } catch (err) {
      return negErr(`invalid: ${(err as Error).message}`);
    }
    // re-check after the awaits above (no awaits from here on, so the accounting can't race)
    if (conn.closed) return;
    dropNegSession(ctx, conn, subId);
    if (conn.negSessions.size >= MAX_NEG_SESSIONS_PER_CONN) return negErr(`blocked: too many negentropy sessions (max ${MAX_NEG_SESSIONS_PER_CONN})`);
    const now = Date.now();
    conn.negSessions.set(subId, { neg, openedAt: now, lastActiveAt: now, items: storage.size() });
    ctx.neg.items += storage.size();
    conn.send(["NEG-MSG", subId, out ?? ""]);
  } finally {
    ctx.neg.items -= listed;
  }
}

/**
 * Lists the (created_at, id) pairs matching `f` into `storage`, NEG_ID_PAGE at a time (oldest first), charging
 * each page with `charge`. Returns a NEG-ERR reason when the sync is refused.
 */
async function listSyncIds(ctx: RelayContext, f: Filter, storage: NegentropyStorage, charge: (n: number) => void): Promise<string | undefined> {
  let since = f.since;
  /** ids already listed at `since` (the next page reads that second again) */
  let boundary = new Set<string>();
  for (;;) {
    const rows = await ctx.stores.events.queryIdsForSync({ ...f, ...(since !== undefined ? { since } : {}), limit: NEG_ID_PAGE });
    let added = 0;
    for (const r of rows) {
      if (since !== undefined && (r.created_at < since || (r.created_at === since && boundary.has(r.id)))) continue;
      storage.insert(r.created_at, r.id);
      added++;
    }
    charge(added);
    // counted before the filters of a union are merged
    if (storage.inserted > MAX_NEG_ITEMS) return "blocked: too many results";
    if (ctx.neg.items > NEG_GLOBAL_ITEM_BUDGET) sweepNegSessions(ctx);
    if (ctx.neg.items > NEG_GLOBAL_ITEM_BUDGET) return "rate-limited: relay is busy with other syncs, try again later";
    if (rows.length < NEG_ID_PAGE) return undefined;
    const last = rows[rows.length - 1].created_at;
    if (added === 0) {
      // a full page of one second already listed can't be paged past; otherwise nothing new is left
      return rows[0].created_at === last ? "blocked: too many events with the same created_at to sync; narrow the filter" : undefined;
    }
    if (last !== since) boundary = new Set();
    for (const r of rows) if (r.created_at === last) boundary.add(r.id);
    since = last;
    await yieldToLoop(); // sqlite queries are synchronous: let other connections in between pages
  }
}

export function handleNegMsg(ctx: RelayContext, conn: Connection, subId: string, message: string): void {
  const negErr = (reason: string) => negError(ctx, conn, subId, reason);
  const session = conn.negSessions.get(subId);
  if (!session) return negErr("closed: no such negentropy session");
  if (negSessionExpired(session, Date.now())) return negErr("closed: negentropy session timed out");
  // reconciling costs CPU proportional to the (highly compressible) message size
  const cost = Math.max(1, message.length);
  if (!ctx.rate.take(`neg:conn:${conn.id}`, NEG_MSG_HEX_PER_MINUTE, cost) || !ctx.rate.take(`neg:ip:${conn.ipKey}`, NEG_MSG_HEX_PER_MINUTE * IP_RATE_FACTOR, cost)) {
    return negErr("rate-limited: too much negentropy traffic, slow down");
  }
  session.lastActiveAt = Date.now();
  try {
    const out = session.neg.reconcile(message).output;
    conn.send(["NEG-MSG", subId, out ?? ""]);
  } catch (err) {
    negErr(`invalid: ${(err as Error).message}`);
  }
}

export function handleNegClose(ctx: RelayContext, conn: Connection, subId: string): void {
  dropNegSession(ctx, conn, subId);
}
