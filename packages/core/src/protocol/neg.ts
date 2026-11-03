import type { Filter, ReadContext } from "@beamhop/sdk";
import { IP_RATE_FACTOR } from "../constants";
import type { RelayContext } from "../context";
import { Negentropy, NegentropyStorage } from "../nips/nip77/negentropy";
import { onlyGatedKinds } from "../subscriptions/visibility";
import { withPrefix } from "../util/reasons";
import { yieldToLoop } from "./backpressure";
import type { Connection, NegSession } from "./connection";
import {
  connBucket,
  MAX_NEG_ITEMS,
  MAX_NEG_SESSIONS_PER_CONN,
  MAX_VISIBILITY_SCAN,
  NEG_FRAME_SIZE_LIMIT,
  NEG_GLOBAL_ITEM_BUDGET,
  NEG_ID_PAGE,
  NEG_IDLE_TIMEOUT_MS,
  NEG_MSG_HEX_PER_MINUTE,
  NEG_OPEN_CONCURRENCY,
  NEG_OPEN_PER_IP,
  NEG_OPEN_WAIT_MS,
  NEG_SESSION_TTL_MS,
} from "./limits";
import { admitQuery, authReadDenied, meteredStore, READ_RATE_ERROR, type ReadStore, readRate } from "./read-guard";
import { filterVisible, hiddenIds } from "./visibility-scan";

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
  conn.negOpens.delete(subId);
  conn.send(["NEG-ERR", subId, reason]);
}

export function dropAllNegSessions(ctx: RelayContext, conn: Connection): void {
  for (const id of [...conn.negSessions.keys()]) dropNegSession(ctx, conn, id);
}

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
  // NIP-77: opening an existing id closes the old session first, even if the new one is refused. That includes an
  // earlier NEG-OPEN of the id still being prepared: it ends silently (its reply would be taken for this one's).
  const open = {};
  conn.negOpens.set(subId, open);
  const current = () => conn.negOpens.get(subId) === open;
  const negErr = (reason: string) => {
    if (current()) negError(ctx, conn, subId, reason);
  };
  dropNegSession(ctx, conn, subId);
  expireNegSessions(ctx, conn);
  const denied = authReadDenied(ctx, conn);
  if (denied) return negErr(denied);
  if (conn.authedPubkeys.size === 0 && onlyGatedKinds(filter)) return negErr("auth-required: authentication is required to sync direct messages");
  const rate = await readRate(ctx, conn);
  if (rate === "limited") return negErr("rate-limited: too many requests");
  if (rate === "error") return negErr(READ_RATE_ERROR);
  const refused = admitQuery(ctx, conn, rate === "staff");
  if (refused) return negErr(refused);
  if (conn.negSessions.size + conn.negOpening >= MAX_NEG_SESSIONS_PER_CONN) {
    return negErr(`blocked: too many negentropy sessions (max ${MAX_NEG_SESSIONS_PER_CONN})`);
  }
  // preparation slots: few relay-wide, and a couple per address so a single client can't hold them all.
  // A NEG-OPEN that finds them taken waits briefly (normal clients open their two sessions back to back).
  conn.negOpening++;
  const busy = () => ctx.neg.opening >= NEG_OPEN_CONCURRENCY || (ctx.neg.openingByIp.get(conn.ipKey) ?? 0) >= NEG_OPEN_PER_IP;
  const deadline = Date.now() + NEG_OPEN_WAIT_MS;
  while (busy()) {
    if (conn.closed || !current() || Date.now() >= deadline) {
      conn.negOpening--;
      return conn.closed ? undefined : negErr("rate-limited: too many syncs starting at once, try again shortly");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  ctx.neg.opening++;
  ctx.neg.openingByIp.set(conn.ipKey, (ctx.neg.openingByIp.get(conn.ipKey) ?? 0) + 1);
  try {
    await openNegSession(ctx, meteredStore(ctx, conn, rate === "staff"), conn, subId, filter, message, current, negErr);
  } finally {
    if (current()) conn.negOpens.delete(subId);
    conn.negOpening--;
    ctx.neg.opening--;
    const left = (ctx.neg.openingByIp.get(conn.ipKey) ?? 1) - 1;
    if (left > 0) ctx.neg.openingByIp.set(conn.ipKey, left);
    else ctx.neg.openingByIp.delete(conn.ipKey);
  }
}

async function openNegSession(
  ctx: RelayContext,
  store: ReadStore,
  conn: Connection,
  subId: string,
  filter: Filter,
  message: string,
  /** false once the client closed the id or reopened it */
  current: () => boolean,
  negErr: (reason: string) => void,
): Promise<void> {
  const rctx: ReadContext = { conn, subId, source: "sync" };
  const hq = await ctx.hooks.runQuery([filter], rctx).catch(() => ({ reject: "error: query policy failed" }));
  if ("reject" in hq) return negErr(withPrefix(hq.reject, "blocked"));

  // a hook may rewrite the filter into several (union) or none (match nothing)
  const syncFilters = hq.filters.map(({ limit: _limit, ...f }) => f);
  if (syncFilters.some((f) => f.search !== undefined)) return negErr("unsupported: search filters cannot be used for sync");
  // Ids are listed page by page straight into the session's typed arrays (no object per id is kept), and count
  // against the relay-wide item budget (by allocated slots) while they are listed, so syncs being prepared can't exhaust memory either.
  const storage = new NegentropyStorage();
  let listed = 0;
  try {
    let exclude: { id: string; created_at: number }[] = [];
    try {
      for (const f of syncFilters) {
        const refused = await listSyncIds(ctx, store, f, storage, (n) => {
          ctx.neg.items += n;
          listed += n;
        });
        if (refused) return negErr(refused);
        if (conn.closed) return;
      }
      // ids are disclosed to the client, so everything it may not read must go. The hidden set is
      // computed after the ids, so every listed id already existed when it was computed. Under plugin
      // visibility hooks, or with too many private candidates, every listed id is checked instead.
      const hidden = ctx.hooks.counts.visibility > 0 ? null : await hiddenIds(ctx, store, conn, syncFilters, rctx);
      if (hidden) exclude = [...hidden].map(([id, created_at]) => ({ id, created_at }));
      else {
        const items = storage.inserted > MAX_VISIBILITY_SCAN ? null : storage.pendingItems();
        const visible = items && (await filterVisible(ctx, store, conn, items, rctx));
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
    if (conn.closed || !current()) return;
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
 * Lists the (created_at, id) pairs matching `f` into `storage`, NEG_ID_PAGE at a time (oldest first), charging the
 * slots allocated for each page with `charge`. Returns a NEG-ERR reason when the sync is refused.
 */
async function listSyncIds(ctx: RelayContext, store: ReadStore, f: Filter, storage: NegentropyStorage, charge: (n: number) => void): Promise<string | undefined> {
  let since = f.since;
  /** ids already listed at `since` (the next page reads that second again) */
  let boundary = new Set<string>();
  for (;;) {
    const rows = await store.queryIdsForSync({ ...f, ...(since !== undefined ? { since } : {}), limit: NEG_ID_PAGE });
    // the page's room is allocated at once (no doubling), and what is allocated is what's charged
    const fresh = since === undefined ? rows : rows.filter((r) => r.created_at > since! || (r.created_at === since && !boundary.has(r.id)));
    const allocated = storage.capacity;
    storage.reserve(fresh.length);
    for (const r of fresh) storage.insert(r.created_at, r.id);
    const added = fresh.length;
    charge(storage.capacity - allocated);
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
  if (!ctx.rate.take(connBucket("neg", conn.id), NEG_MSG_HEX_PER_MINUTE, cost) || !ctx.rate.take(`neg:ip:${conn.ipKey}`, NEG_MSG_HEX_PER_MINUTE * IP_RATE_FACTOR, cost)) {
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
  conn.negOpens.delete(subId); // a NEG-OPEN still being prepared is abandoned
}
