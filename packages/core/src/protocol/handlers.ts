import type { Filter, NostrEvent, ReadContext } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { isExpired } from "../nips/nip40";
import { verifyAuthEvent } from "../nips/nip42";
import { Negentropy, NegentropyStorage } from "../nips/nip77/negentropy";
import { processEvent } from "../pipeline/write";
import { isVisibleTo, onlyGatedKinds } from "../subscriptions/visibility";
import { withPrefix } from "../util/reasons";
import type { Connection, Subscription } from "./connection";
import { nowSec } from "@beamhop/sdk";

/** Max items in a negentropy session before refusing with NEG-ERR. */
export const MAX_NEG_ITEMS = 500_000;
/** Negentropy frame size limit (bytes before hex encoding). */
export const NEG_FRAME_SIZE_LIMIT = 60_000;
/** Max live events buffered while a stored query is in flight. */
const MAX_PENDING_LIVE = 1000;
const IP_RATE_FACTOR = 4;

// ------------------------------------------------------------------ EVENT

export function handleEvent(ctx: RelayContext, conn: Connection, event: NostrEvent, bytes: number): void {
  // serialize per connection so OK messages keep submission order
  conn.queue = conn.queue.then(async () => {
    if (conn.closed) return;
    const res = await processEvent(ctx, event, { conn, source: "ws", bytes });
    conn.ok(event.id, res.ok, res.message);
  });
}

// ------------------------------------------------------------------ rate limiting for reads

async function reqRateOk(ctx: RelayContext, conn: Connection): Promise<boolean> {
  const def = ctx.s().limits.reqPerMinute;
  let limit = def;
  let override = false;
  for (const pk of conn.authedPubkeys) {
    const u = await ctx.users.get(pk);
    if (ctx.users.isStaff(pk, u)) return true;
    const o = u?.rateLimit?.reqPerMinute;
    if (o !== undefined) {
      limit = override ? Math.max(limit, o) : o;
      override = true;
    }
  }
  if (!ctx.rate.take(`req:conn:${conn.id}`, limit)) return false;
  return override || ctx.rate.take(`req:ip:${conn.ip}`, def * IP_RATE_FACTOR);
}

function authReadDenied(ctx: RelayContext, conn: Connection): string | undefined {
  if (ctx.s().access.authForRead && conn.authedPubkeys.size === 0) return "auth-required: authentication is required to read from this relay";
  return undefined;
}

// ------------------------------------------------------------------ REQ / CLOSE

export function cancelSub(ctx: RelayContext, sub: Subscription): void {
  sub.abort.abort();
  ctx.subs.remove(sub);
  if (sub.conn.subs.get(sub.id) === sub) sub.conn.subs.delete(sub.id);
}

export async function handleReq(ctx: RelayContext, conn: Connection, subId: string, input: Filter[]): Promise<void> {
  const started = performance.now();
  const L = ctx.s().limits;
  let filters = input;

  const denied = authReadDenied(ctx, conn);
  if (denied) return conn.closedSub(subId, denied);
  if (!(await reqRateOk(ctx, conn))) return conn.closedSub(subId, "rate-limited: too many requests");

  const existing = conn.subs.get(subId);
  if (existing) cancelSub(ctx, existing);
  else if (conn.subs.size >= L.maxSubscriptions) return conn.closedSub(subId, `rate-limited: too many subscriptions (max ${L.maxSubscriptions})`);

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

  const sub: Subscription = { conn, id: subId, filters, pending: [], sentIds: new Set(), abort: new AbortController() };
  conn.subs.set(subId, sub);
  ctx.subs.add(sub);

  const queryFilters = filters
    .filter((f) => f.limit !== 0)
    .map((f) => ({ ...f, limit: Math.min(f.limit ?? L.defaultLimit, L.maxLimit) }));
  let results = 0;
  if (queryFilters.length) {
    let events: NostrEvent[];
    try {
      events = await ctx.stores.events.query(queryFilters, { maxLimit: L.maxLimit, signal: sub.abort.signal });
    } catch (err) {
      if (sub.abort.signal.aborted) return;
      ctx.logger.error("REQ query failed", { err: String(err), subId });
      cancelSub(ctx, sub);
      return conn.closedSub(subId, "error: query failed");
    }
    if (sub.abort.signal.aborted || conn.subs.get(subId) !== sub) return;
    const now = nowSec();
    for (const ev of events) {
      if (isExpired(ev, now) || !isVisibleTo(ctx, ev, conn, rctx)) continue;
      conn.send(["EVENT", subId, ev]);
      sub.sentIds!.add(ev.id);
      results++;
    }
  }
  conn.send(["EOSE", subId]);

  const pending = sub.pending ?? [];
  const sent = sub.sentIds!;
  sub.pending = null;
  sub.sentIds = null;
  for (const ev of pending) if (!sent.has(ev.id)) conn.sendLive(subId, ev);

  ctx.bus.emit("req.executed", { connId: conn.id, subId, filters, results, durationMs: performance.now() - started, ip: conn.ip });
}

/** Called by fan-out for a matched subscription. Returns true if delivered (or buffered). */
export function deliverLive(sub: Subscription, event: NostrEvent): boolean {
  if (sub.pending) {
    if (sub.pending.length >= MAX_PENDING_LIVE) sub.pending.shift();
    sub.pending.push(event);
    return true;
  }
  return sub.conn.sendLive(sub.id, event);
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
  if (!(await reqRateOk(ctx, conn))) return conn.closedSub(subId, "rate-limited: too many requests");
  const started = performance.now();
  let hq: { filters: Filter[] } | { reject: string };
  try {
    hq = await ctx.hooks.runQuery(input, { conn, subId, source: "count" });
  } catch {
    return conn.closedSub(subId, "error: query policy failed");
  }
  if ("reject" in hq) return conn.closedSub(subId, withPrefix(hq.reject, "blocked"));
  try {
    const count = await ctx.stores.events.count(hq.filters.map(({ limit: _l, ...f }) => f));
    conn.send(["COUNT", subId, { count }]);
    ctx.bus.emit("req.executed", { connId: conn.id, subId, filters: hq.filters, results: count, durationMs: performance.now() - started, ip: conn.ip });
  } catch (err) {
    ctx.logger.error("COUNT failed", { err: String(err) });
    conn.closedSub(subId, "error: count failed");
  }
}

// ------------------------------------------------------------------ AUTH (NIP-42)

export async function handleAuth(ctx: RelayContext, conn: Connection, event: NostrEvent): Promise<void> {
  const reason = await verifyAuthEvent(ctx, conn, event);
  if (reason) return conn.ok(event.id, false, reason);
  const isNew = !conn.authedPubkeys.has(event.pubkey);
  conn.authedPubkeys.add(event.pubkey);
  conn.ok(event.id, true, "");
  if (isNew) ctx.bus.emit("connection.auth", { connId: conn.id, pubkey: event.pubkey, ip: conn.ip });
}

// ------------------------------------------------------------------ NIP-77 negentropy

const negErr = (conn: Connection, subId: string, reason: string) => conn.send(["NEG-ERR", subId, reason]);

export async function handleNegOpen(ctx: RelayContext, conn: Connection, subId: string, filter: Filter, message: string): Promise<void> {
  const denied = authReadDenied(ctx, conn);
  if (denied) return negErr(conn, subId, denied);
  if (conn.authedPubkeys.size === 0 && onlyGatedKinds(filter)) return negErr(conn, subId, "auth-required: authentication is required to sync direct messages");
  if (!(await reqRateOk(ctx, conn))) return negErr(conn, subId, "rate-limited: too many requests");
  conn.negSessions.delete(subId);
  if (conn.negSessions.size >= ctx.s().limits.maxSubscriptions) return negErr(conn, subId, "blocked: too many negentropy sessions");

  const hq = await ctx.hooks.runQuery([filter], { conn, subId, source: "sync" }).catch(() => ({ reject: "error: query policy failed" }));
  if ("reject" in hq) return negErr(conn, subId, withPrefix(hq.reject, "blocked"));

  const { limit: _limit, ...syncFilter } = hq.filters[0] ?? filter;
  let items: { id: string; created_at: number }[];
  try {
    items = await ctx.stores.events.queryIdsForSync(syncFilter);
  } catch (err) {
    ctx.logger.error("NEG-OPEN query failed", { err: String(err) });
    return negErr(conn, subId, "error: query failed");
  }
  if (items.length > MAX_NEG_ITEMS) return negErr(conn, subId, "blocked: too many results");

  const storage = new NegentropyStorage();
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    storage.insert(it.created_at, it.id);
  }
  storage.seal();
  const neg = new Negentropy(storage, NEG_FRAME_SIZE_LIMIT);
  let out: string | null;
  try {
    out = neg.reconcile(message).output;
  } catch (err) {
    return negErr(conn, subId, `invalid: ${(err as Error).message}`);
  }
  if (conn.closed) return;
  conn.negSessions.set(subId, { neg, openedAt: Date.now() });
  conn.send(["NEG-MSG", subId, out ?? ""]);
}

export function handleNegMsg(ctx: RelayContext, conn: Connection, subId: string, message: string): void {
  const session = conn.negSessions.get(subId);
  if (!session) return negErr(conn, subId, "closed: no such negentropy session");
  try {
    const out = session.neg.reconcile(message).output;
    conn.send(["NEG-MSG", subId, out ?? ""]);
  } catch (err) {
    conn.negSessions.delete(subId);
    negErr(conn, subId, `invalid: ${(err as Error).message}`);
  }
}

export function handleNegClose(_ctx: RelayContext, conn: Connection, subId: string): void {
  conn.negSessions.delete(subId);
}
