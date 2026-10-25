import type { Filter, NostrEvent, ReadContext } from "@beamhop/sdk";
import { nowSec } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { isExpired } from "../nips/nip40";
import { isVisibleTo, onlyGatedKinds, restrictedSubFilters } from "../subscriptions/visibility";
import { filterWeight } from "../util/filter";
import { withPrefix } from "../util/reasons";
import { waitForDrain, yieldToLoop } from "./backpressure";
import type { Connection, EventJson, Subscription } from "./connection";
import { MAX_FILTER_WEIGHT_PER_CONN, MAX_PENDING_LIVE, MAX_REFILL_SCAN, REFILL_MIN_PAGE, SEARCH_REFILL_ROUNDS } from "./limits";
import {
  admitQuery,
  admitSearch,
  authReadDenied,
  meteredStore,
  READ_RATE_ERROR,
  type ReadStore,
  readRate,
  refundSearch,
  runSearch,
  type SearchCharge,
  withQuerySlot,
} from "./read-guard";
import { eventSize, isSearchFilter, SEARCH_MAX_LIMIT } from "./read-limits";

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
function olderPages(ctx: RelayContext, store: ReadStore, f: Filter, first: NostrEvent[], scan: { left: number }, signal: AbortSignal) {
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
    const r = await withQuerySlot(ctx, signal, () => store.query([{ ...f, until, limit: ask }], { maxLimit: ask, signal }));
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
  store: ReadStore,
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
    // a search's queries are timed (and budgeted) by runSearch as a whole
    const first = search ? ctx.stores.events : store;
    const run = async () => {
      const out = [plain.length ? await first.query(plain, { maxLimit: L.maxLimit, signal }) : []];
      for (const f of gapped) {
        if (signal.aborted) break;
        out.push(isSearchFilter(f) ? await rankVisible(ctx, f, visible, scan, signal) : await first.query([f], { maxLimit: L.maxLimit, signal }));
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
        more: f && !isSearchFilter(f) ? olderPages(ctx, store, f, evs, scan, signal) : null,
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
  // relay-wide, the fan-out index is bounded too (transient: subscriptions elsewhere close)
  if (L.maxTotalFilterWeight > 0 && ctx.subs.weight + weight > L.maxTotalFilterWeight) {
    return conn.closedSub(subId, "rate-limited: relay holds too many subscriptions, try again later");
  }
  let search: SearchCharge | null = null;
  if (filters.some((f) => f.limit !== 0 && isSearchFilter(f))) {
    const admitted = admitSearch(ctx, conn, rate === "staff");
    if ("reason" in admitted) return conn.closedSub(subId, admitted.reason);
    search = admitted;
  } else if (filters.some((f) => f.limit !== 0)) {
    const refused = admitQuery(ctx, conn, rate === "staff");
    if (refused) return conn.closedSub(subId, refused);
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
      const sent = await streamStored(ctx, conn, sub, queryFilters, rctx, search, meteredStore(ctx, conn, rate === "staff"));
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
