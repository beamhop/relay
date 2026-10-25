import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { ConnectionHandle, ConnectionMeta, CoreDeps, CreateRelay, NostrEvent, RelayEngine, RelaySocket, StopContext } from "@beamhop/sdk";
import { nowSec, settleBy, TaskTracker } from "@beamhop/sdk";
import { SHUTTING_DOWN } from "./constants";
import type { RelayContext } from "./context";
import { createHttp } from "./http/app";
import { buildNip11 } from "./http/nip11";
import { IpRuleCache } from "./ip-rules";
import { runRetention } from "./jobs/retention";
import { Scheduler } from "./jobs/scheduler";
import { GroupsService } from "./nips/nip29/groups";
import { GroupRepo } from "./nips/nip29/repo";
import { ContentPolicy } from "./pipeline/content-policy";
import { MAX_VANISH_MARKERS, VANISH_KV_NAMESPACE } from "./pipeline/special-kinds";
import { Verifier } from "./pipeline/verify";
import { sharedVerifyPool } from "./pipeline/verify-pool";
import { EPHEMERAL_DEDUP_SIZE, processEvent } from "./pipeline/write";
import { Connection, type EventJson, serializeEvent } from "./protocol/connection";
import {
  authReadDenied,
  cancelSub,
  CONN_RATE_BUCKETS,
  connBucket,
  deliverLive,
  dropAllNegSessions,
  handleAuth,
  handleClose,
  handleCount,
  handleEvent,
  handleNegClose,
  handleNegMsg,
  handleNegOpen,
  handleReq,
  MAX_INFLIGHT_EVENTS,
  MAX_INFLIGHT_EVENTS_TRUSTED,
  MESSAGE_IP_FACTOR,
  MESSAGES_PER_MINUTE,
  NEG_SWEEP_MS,
  negError,
  sweepNegSessions,
} from "./protocol/handlers";
import { parseClientMessage, peekMessage, peekType, validateEventShape } from "./protocol/messages";
import { ReadLimits } from "./protocol/read-limits";
import { loadRelayKey } from "./relay-key";
import { SubscriptionIndex } from "./subscriptions/index";
import { isVisibleTo } from "./subscriptions/visibility";
import { UserCache } from "./users";
import { randomHex } from "./util/hex";
import { Lru } from "./util/lru";
import { RateLimiter } from "./util/rate-limit";
import { ipSiteKey } from "./util/cidr";
import { toWsUrl } from "./util/url";

const IP_RULES_REFRESH_MS = 30_000;
const EXPIRATION_PURGE_MS = 60_000;
/**
 * connectionsPerIp applies per address; an IPv6 /64 (one subscriber's prefix, or a whole office LAN)
 * may hold this many times that in total.
 */
const V6_PREFIX_CONNECTION_FACTOR = 4;
/** An IPv6 /48 (a site: many /64s) may hold this many times connectionsPerIp, unless limits.connectionsPerIpv6Site is set. */
const V6_SITE_CONNECTION_FACTOR = 16;
/** A connection refused more than this many times its message limit within a minute is closed. */
const OVER_LIMIT_CLOSE_FACTOR = 3;
/** CLOSE / NEG-CLOSE skip the message limit only up to this size (a subscription id is at most 64 chars). */
const MAX_EXEMPT_CLOSE_CHARS = 2048;
export { MESSAGES_PER_MINUTE };

const noopHandle = (id: string): ConnectionHandle => ({ id, onMessage() {}, onClose() {} });

export const createRelay: CreateRelay = async (deps: CoreDeps): Promise<RelayEngine> => {
  const logger = deps.logger.child("core");
  const key = loadRelayKey(deps.config);
  const conns = new Map<string, Connection>();
  const subs = new SubscriptionIndex();

  const ctx: RelayContext = {
    ...deps,
    tasks: deps.tasks ?? new TaskTracker({ logger }),
    logger,
    relayUrl: toWsUrl(deps.config.server.publicUrl),
    key,
    users: new UserCache(deps.stores.users, deps.bus, deps.config.admin.owners),
    rate: new RateLimiter(),
    ipRules: new IpRuleCache(deps.stores.ipRules, logger),
    subs,
    conns,
    groups: undefined as unknown as GroupsService,
    verifier: new Verifier(
      undefined,
      sharedVerifyPool(deps.config.server.verifyWorkers ?? 0, (msg, err) => logger.error(msg, err === undefined ? {} : { err: String(err) })),
    ),
    policy: new ContentPolicy(deps.settings, logger),
    vanished: new Map(),
    ephemeralSeen: new Lru(EPHEMERAL_DEDUP_SIZE),
    neg: { items: 0, opening: 0, openingByIp: new Map() },
    reads: new ReadLimits(),
    s: () => deps.settings.get(),
    broadcast(event: NostrEvent): number {
      let n = 0;
      // serialized once (at the first delivery) for all recipients
      let json: EventJson | undefined;
      const serialized = () => (json ??= serializeEvent(event));
      for (const sub of subs.match(event)) {
        if (sub.conn.closed) continue;
        // read auth can be switched on at runtime: subscriptions opened anonymously before that end here
        const denied = authReadDenied(ctx, sub.conn);
        if (denied) {
          cancelSub(ctx, sub);
          sub.conn.closedSub(sub.id, denied);
          continue;
        }
        if (!isVisibleTo(ctx, event, sub.conn, { conn: sub.conn, subId: sub.id, source: "ws" })) continue;
        if (deliverLive(sub, event, serialized)) n++;
      }
      return n;
    },
    disconnect: (target, notice) => disconnect(target, notice),
  };
  ctx.groups = new GroupsService(ctx, new GroupRepo(deps.stores.db));
  await ctx.groups.init();
  for (const [pk, at] of Object.entries(await deps.stores.kv.list<number>(VANISH_KV_NAMESPACE))) {
    if (ctx.vanished.size >= MAX_VANISH_MARKERS) break;
    if (typeof at === "number") ctx.vanished.set(pk, at);
  }
  await ctx.ipRules.refresh();

  /** open connections per address and (IPv6) per /64 and per /48 */
  const ipCounts = new Map<string, number>();
  const countKeys = (conn: Connection) => (conn.addrKey === conn.ipKey ? [conn.addrKey] : [conn.addrKey, conn.ipKey, ipSiteKey(conn.ip) ?? conn.ipKey]);
  /** caps for countKeys(conn), in the same order (0 = unlimited) */
  const countCaps = (keys: string[]) => {
    const L = ctx.s().limits;
    const max = L.connectionsPerIp;
    return keys.length === 1 ? [max] : [max, max * V6_PREFIX_CONNECTION_FACTOR, L.connectionsPerIpv6Site ?? max * V6_SITE_CONNECTION_FACTOR];
  };
  const scheduler = new Scheduler(logger);
  let stopped = false;
  /** shutting down: no new connections or messages; EVENTs already queued are still processed and answered */
  let draining = false;

  function cleanup(conn: Connection, handledClose: { done: boolean }) {
    if (handledClose.done) return;
    handledClose.done = true;
    conn.closed = true;
    for (const sub of [...conn.subs.values()]) cancelSub(ctx, sub);
    dropAllNegSessions(ctx, conn);
    conns.delete(conn.id);
    for (const b of CONN_RATE_BUCKETS) ctx.rate.delete(connBucket(b, conn.id));
    for (const k of countKeys(conn)) {
      const n = (ipCounts.get(k) ?? 1) - 1;
      if (n <= 0) ipCounts.delete(k);
      else ipCounts.set(k, n);
    }
    deps.bus.emit("connection.close", { connId: conn.id, ip: conn.ip, durationMs: Date.now() - conn.connectedAt, at: nowSec() });
  }
  const closers = new Map<string, () => void>();

  /** NIP-01: refusals answer with OK (EVENT/AUTH) or CLOSED (REQ/COUNT) when the id is known; NOTICE otherwise. */
  function refuse(conn: Connection, r: { type?: string; subId?: string; eventId?: string; reason: string }) {
    const { type, subId, eventId, reason } = r;
    if ((type === "EVENT" || type === "AUTH") && eventId) conn.ok(eventId, false, reason);
    else if ((type === "REQ" || type === "COUNT") && subId) {
      handleClose(ctx, conn, subId);
      conn.closedSub(subId, reason);
    } else if (type?.startsWith("NEG-") && subId) negError(ctx, conn, subId, reason);
    else conn.notice(reason);
  }

  /**
   * Takes an inbound message token. A connection whose refused messages within a minute exceed
   * OVER_LIMIT_CLOSE_FACTOR times its limit is closed: the flood costs bandwidth and decompression even
   * when refused unparsed.
   */
  function overLimit(conn: Connection): boolean {
    if (conn.trusted) return false;
    if (
      ctx.rate.take(connBucket("msg", conn.id), conn.messagesPerMinute) &&
      (conn.ownMessageLimit || ctx.rate.take(`msg:ip:${conn.ipKey}`, MESSAGES_PER_MINUTE * MESSAGE_IP_FACTOR))
    ) {
      return false;
    }
    const now = Date.now();
    if (now - conn.refusedSince >= 60_000) {
      conn.refusedSince = now;
      conn.refused = 0;
    }
    if (++conn.refused > OVER_LIMIT_CLOSE_FACTOR * conn.messagesPerMinute) {
      logger.info("closing connection that keeps exceeding the message limit", { ip: conn.ip, refused: conn.refused });
      closeConn(conn, "rate-limited: too many messages", 1008, "rate limited");
    }
    return true;
  }

  /**
   * Shutting down: new work is answered (OK false / CLOSED / NEG-ERR, unparsed) instead of started. Closing
   * subscriptions still goes through (returns false: handle it as usual).
   */
  function refuseWhileDraining(conn: Connection, data: string): boolean {
    const type = peekType(data);
    if ((type === "CLOSE" || type === "NEG-CLOSE") && data.length <= MAX_EXEMPT_CLOSE_CHARS) return false;
    const peeked = peekMessage(data);
    if (peeked.subId || peeked.eventId) refuse(conn, { ...peeked, reason: SHUTTING_DOWN });
    return true;
  }

  function onMessage(conn: Connection, data: string) {
    if (conn.closed) return;
    conn.messagesIn++;
    if (draining && refuseWhileDraining(conn, data)) return;
    const L = ctx.s().limits;
    // The rate token is taken before the message is parsed (or even measured), from its type read off the
    // head: a flood is refused at the cost of a peek. Closing things is always allowed (it frees
    // resources), but only small CLOSE / NEG-CLOSE messages count as such.
    const type = peekType(data);
    const exempt = (type === "CLOSE" || type === "NEG-CLOSE") && data.length <= MAX_EXEMPT_CLOSE_CHARS;
    if (!exempt && overLimit(conn)) {
      deps.bus.emit("message.in", { connId: conn.id, type: type ?? "INVALID", bytes: Buffer.byteLength(data) });
      // answered only when it can be matched (OK / CLOSED / NEG-ERR; closes get no answer); NOTICEs would cost as much as the flood
      if (conn.closed || type === "CLOSE" || type === "NEG-CLOSE") return;
      const peeked = peekMessage(data);
      if (peeked.subId || peeked.eventId) refuse(conn, { ...peeked, reason: "rate-limited: too many messages, slow down" });
      return;
    }
    const bytes = Buffer.byteLength(data);
    if (bytes > L.maxMessageBytes) {
      deps.bus.emit("message.in", { connId: conn.id, type: "OVERSIZE", bytes });
      if (exempt && overLimit(conn)) return;
      refuse(conn, { ...peekMessage(data), reason: `invalid: message too large (max ${L.maxMessageBytes} bytes)` });
      return;
    }
    const parsed = parseClientMessage(data, { maxFilters: L.maxFilters });
    deps.bus.emit("message.in", { connId: conn.id, type: parsed.ok ? parsed.msg.type : (parsed.type ?? "INVALID"), bytes });
    // a peeked CLOSE that turned out malformed (or not to be one) pays its token after all
    if (exempt && (!parsed.ok || (parsed.msg.type !== "CLOSE" && parsed.msg.type !== "NEG-CLOSE")) && overLimit(conn)) return;
    if (!parsed.ok) {
      refuse(conn, parsed);
      return;
    }
    const msg = parsed.msg;
    // a handler that throws still answers (NIP-01: CLOSED / NEG-ERR / OK), and a subscription it registered is cancelled
    const fail = (err: unknown) => {
      logger.error(`${msg.type} handler failed`, { err: String(err) });
      if (conn.closed) return;
      const reason = "error: internal error";
      if (msg.type === "REQ" || msg.type === "COUNT") {
        handleClose(ctx, conn, msg.subId);
        conn.closedSub(msg.subId, reason);
      } else if (msg.type === "NEG-OPEN") negError(ctx, conn, msg.subId, reason);
      else if (msg.type === "AUTH") conn.ok(msg.event.id, false, reason);
    };
    switch (msg.type) {
      case "EVENT":
        return handleEvent(ctx, conn, msg.event, bytes);
      case "REQ":
        return void handleReq(ctx, conn, msg.subId, msg.filters).catch(fail);
      case "COUNT":
        return void handleCount(ctx, conn, msg.subId, msg.filters).catch(fail);
      case "CLOSE":
        return handleClose(ctx, conn, msg.subId);
      case "AUTH":
        return void handleAuth(ctx, conn, msg.event).catch(fail);
      case "NEG-OPEN":
        return void handleNegOpen(ctx, conn, msg.subId, msg.filter, msg.message).catch(fail);
      case "NEG-MSG":
        return handleNegMsg(ctx, conn, msg.subId, msg.message);
      case "NEG-CLOSE":
        return handleNegClose(ctx, conn, msg.subId);
    }
  }

  function handleConnection(socket: RelaySocket, meta: ConnectionMeta): ConnectionHandle {
    const id = randomUUID();
    const verdict = ctx.ipRules.check(meta.ip);
    const conn = new Connection(
      id,
      socket,
      meta.ip,
      randomHex(16),
      deps.bus,
      { messagesPerMinute: MESSAGES_PER_MINUTE, maxInflightEvents: verdict.allowed ? MAX_INFLIGHT_EVENTS_TRUSTED : MAX_INFLIGHT_EVENTS },
      meta.userAgent,
      meta.origin,
    );
    // allow-listed addresses are exempt from the inbound message limit (like staff)
    if (verdict.allowed) {
      conn.trusted = true;
      conn.ownMessageLimit = true;
    }
    const reject = (notice: string, reason: string) => {
      conn.notice(notice);
      conn.close(1008, reason);
      return noopHandle(id);
    };
    if (stopped || draining) return reject(SHUTTING_DOWN, "shutting down");
    if (verdict.blocked) return reject(`blocked: ${verdict.reason ?? "your IP address is blocked"}`, "blocked");
    const keys = countKeys(conn);
    if (!verdict.allowed) {
      const maxConnections = ctx.s().limits.maxConnections;
      if (maxConnections > 0 && conns.size >= maxConnections) return reject("rate-limited: relay has too many connections, try again later", "relay full");
      const caps = countCaps(keys);
      const over = keys.some((k, i) => caps[i] > 0 && (ipCounts.get(k) ?? 0) >= caps[i]);
      if (over) return reject("rate-limited: too many connections from your IP address", "too many connections");
    }
    for (const k of keys) ipCounts.set(k, (ipCounts.get(k) ?? 0) + 1);
    conns.set(id, conn);
    const state = { done: false };
    closers.set(id, () => cleanup(conn, state));
    deps.bus.emit("connection.open", { connId: id, ip: meta.ip, userAgent: meta.userAgent, at: nowSec() });
    conn.send(["AUTH", conn.challenge]);
    return {
      id,
      onMessage: (data: string) => onMessage(conn, data),
      onClose: () => {
        closers.delete(id);
        cleanup(conn, state);
      },
    };
  }

  function closeConn(conn: Connection, notice: string, code: number, reason: string) {
    conn.notice(notice);
    conn.close(code, reason);
    closers.get(conn.id)?.();
    closers.delete(conn.id);
  }

  function disconnect(target: { id?: string; pubkey?: string; ip?: string }, notice = "blocked: disconnected by relay operator"): number {
    let n = 0;
    for (const conn of [...conns.values()]) {
      const hit =
        (target.id !== undefined && conn.id === target.id) ||
        (target.pubkey !== undefined && conn.authedPubkeys.has(target.pubkey)) ||
        (target.ip !== undefined && conn.ip === target.ip);
      if (!hit) continue;
      closeConn(conn, notice, 1008, "disconnected");
      n++;
    }
    return n;
  }

  let offIpRules: (() => void) | undefined;

  async function refreshIpRules() {
    await ctx.ipRules.refresh();
    for (const conn of [...conns.values()]) {
      const v = ctx.ipRules.check(conn.ip);
      if (v.blocked) closeConn(conn, `blocked: ${v.reason ?? "your IP address is blocked"}`, 1008, "blocked");
    }
  }

  async function purgeExpired() {
    const n = await deps.stores.events.purgeExpired(nowSec());
    if (n > 0) logger.debug("purged expired events", { count: n });
  }

  let lastRetention = 0;
  async function retentionTick(signal: AbortSignal) {
    const intervalMs = Math.max(1, ctx.s().retention.intervalMinutes) * 60_000;
    if (Date.now() - lastRetention < intervalMs) return;
    lastRetention = Date.now();
    await runRetention(ctx, signal);
  }

  const engine: RelayEngine = {
    pubkey: key.pubkey,
    handleConnection,
    http: createHttp(ctx),
    async publish(event, source) {
      const v = validateEventShape(event);
      if ("reason" in v) return { ok: false, message: v.reason };
      const r = await processEvent(ctx, v.event, { source });
      return { ok: r.ok, message: r.message };
    },
    sign: (t) => key.sign(t),
    connections: () => [...conns.values()].map((c) => c.summary()),
    disconnect: (target) => disconnect(target),
    nip11: () => buildNip11(ctx),
    groups: {
      list: async () => ctx.groups.list(),
      get: async (id) => ctx.groups.get(id),
      delete: (id, actor) => ctx.groups.delete(id, actor),
    },
    async start() {
      stopped = false;
      draining = false;
      ctx.refuseQueuedEvents = false;
      scheduler.resume();
      scheduler.every("ip-rules", IP_RULES_REFRESH_MS, refreshIpRules);
      offIpRules?.();
      offIpRules = deps.bus.on("ip.rules.changed", () => void scheduler.runNow("ip-rules", refreshIpRules));
      scheduler.every("expiration", EXPIRATION_PURGE_MS, purgeExpired);
      scheduler.every("retention", 60_000, retentionTick);
      scheduler.every("rate-sweep", 60_000, () => ctx.rate.sweep());
      scheduler.every("neg-sweep", NEG_SWEEP_MS, () => sweepNegSessions(ctx));
      void scheduler.runNow("expiration", purgeExpired);
    },
    async drain(sc: StopContext) {
      draining = true;
      offIpRules?.();
      offIpRules = undefined;
      // past the deadline, EVENTs still waiting in a connection's queue are answered at once instead of processed
      const onDeadline = () => (ctx.refuseQueuedEvents = true);
      if (sc.signal.aborted) onDeadline();
      else sc.signal.addEventListener("abort", onDeadline, { once: true });
      try {
        await Promise.all([
          scheduler.drain(sc.signal),
          settleBy(sc.signal, Promise.all([...conns.values()].map((c) => c.queue))),
          ctx.tasks!.idle(sc.signal),
        ]);
      } finally {
        sc.signal.removeEventListener("abort", onDeadline);
      }
    },
    async stop() {
      stopped = true;
      draining = true;
      ctx.refuseQueuedEvents = true;
      offIpRules?.();
      offIpRules = undefined;
      // drained first by the server; embedders and tests that stop right away still get their jobs told to stop
      void scheduler.drain();
      for (const conn of [...conns.values()]) {
        // never close with EVENTs unanswered: a client can't tell whether to resend them
        conn.answerPending(SHUTTING_DOWN);
        conn.notice(SHUTTING_DOWN);
        conn.close(1001, "relay shutting down");
        closers.get(conn.id)?.();
      }
      closers.clear();
      ctx.policy.dispose();
      ctx.users.dispose();
    },
  };
  return engine;
};
