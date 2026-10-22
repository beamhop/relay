import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { ConnectionHandle, ConnectionMeta, CoreDeps, CreateRelay, NostrEvent, RelayEngine, RelaySocket } from "@beamhop/sdk";
import { nowSec } from "@beamhop/sdk";
import type { RelayContext } from "./context";
import { createHttp } from "./http/app";
import { buildNip11 } from "./http/nip11";
import { IpRuleCache } from "./ip-rules";
import { runRetention } from "./jobs/retention";
import { Scheduler } from "./jobs/scheduler";
import { GroupsService } from "./nips/nip29/groups";
import { GroupRepo } from "./nips/nip29/repo";
import { ContentPolicy } from "./pipeline/content-policy";
import { VANISH_KV_NAMESPACE } from "./pipeline/special-kinds";
import { Verifier } from "./pipeline/verify";
import { processEvent } from "./pipeline/write";
import { Connection } from "./protocol/connection";
import {
  cancelSub,
  deliverLive,
  handleAuth,
  handleClose,
  handleCount,
  handleEvent,
  handleNegClose,
  handleNegMsg,
  handleNegOpen,
  handleReq,
} from "./protocol/handlers";
import { parseClientMessage, validateEventShape } from "./protocol/messages";
import { loadRelayKey } from "./relay-key";
import { SubscriptionIndex } from "./subscriptions/index";
import { isVisibleTo } from "./subscriptions/visibility";
import { UserCache } from "./users";
import { ipKey } from "./util/cidr";
import { randomHex } from "./util/hex";
import { RateLimiter } from "./util/rate-limit";
import { toWsUrl } from "./util/url";

export const IP_RULES_REFRESH_MS = 30_000;
export const EXPIRATION_PURGE_MS = 60_000;

const noopHandle = (id: string): ConnectionHandle => ({ id, onMessage() {}, onClose() {} });

export const createRelay: CreateRelay = async (deps: CoreDeps): Promise<RelayEngine> => {
  const logger = deps.logger.child("core");
  const key = await loadRelayKey(deps.config, deps.stores.kv, logger);
  const conns = new Map<string, Connection>();
  const subs = new SubscriptionIndex();

  const ctx: RelayContext = {
    ...deps,
    logger,
    relayUrl: toWsUrl(deps.config.server.publicUrl),
    key,
    users: new UserCache(deps.stores.users, deps.bus, deps.config.admin.owners),
    rate: new RateLimiter(),
    ipRules: new IpRuleCache(deps.stores.ipRules, logger),
    subs,
    conns,
    groups: undefined as unknown as GroupsService,
    verifier: new Verifier(),
    policy: new ContentPolicy(deps.settings, logger),
    vanished: new Map(),
    s: () => deps.settings.get(),
    broadcast(event: NostrEvent): number {
      let n = 0;
      for (const sub of subs.match(event)) {
        if (sub.conn.closed) continue;
        if (!isVisibleTo(ctx, event, sub.conn, { conn: sub.conn, subId: sub.id, source: "ws" })) continue;
        if (deliverLive(sub, event)) n++;
      }
      return n;
    },
  };
  ctx.groups = new GroupsService(ctx, new GroupRepo(deps.stores.db));
  await ctx.groups.init();
  for (const [pk, at] of Object.entries(await deps.stores.kv.list<number>(VANISH_KV_NAMESPACE))) {
    if (typeof at === "number") ctx.vanished.set(pk, at);
  }
  await ctx.ipRules.refresh();

  const ipCounts = new Map<string, number>();
  const scheduler = new Scheduler(logger);
  let stopped = false;

  function cleanup(conn: Connection, handledClose: { done: boolean }) {
    if (handledClose.done) return;
    handledClose.done = true;
    conn.closed = true;
    for (const sub of [...conn.subs.values()]) cancelSub(ctx, sub);
    conn.negSessions.clear();
    conns.delete(conn.id);
    ctx.rate.delete(`req:conn:${conn.id}`);
    const k = ipKey(conn.ip);
    const n = (ipCounts.get(k) ?? 1) - 1;
    if (n <= 0) ipCounts.delete(k);
    else ipCounts.set(k, n);
    deps.bus.emit("connection.close", { connId: conn.id, ip: conn.ip, durationMs: Date.now() - conn.connectedAt, at: nowSec() });
  }
  const closers = new Map<string, () => void>();

  function onMessage(conn: Connection, data: string) {
    if (conn.closed) return;
    conn.messagesIn++;
    const L = ctx.s().limits;
    const bytes = Buffer.byteLength(data);
    if (bytes > L.maxMessageBytes) {
      deps.bus.emit("message.in", { connId: conn.id, type: "OVERSIZE", bytes });
      conn.notice(`invalid: message too large (max ${L.maxMessageBytes} bytes)`);
      return;
    }
    const parsed = parseClientMessage(data, { maxFilters: L.maxFilters });
    deps.bus.emit("message.in", { connId: conn.id, type: parsed.ok ? parsed.msg.type : (parsed.type ?? "INVALID"), bytes });
    if (!parsed.ok) {
      const { type, subId, eventId, reason } = parsed;
      if ((type === "EVENT" || type === "AUTH") && eventId) conn.ok(eventId, false, reason);
      else if ((type === "REQ" || type === "COUNT") && subId) conn.closedSub(subId, reason);
      else if (type?.startsWith("NEG-") && subId) conn.send(["NEG-ERR", subId, reason]);
      else conn.notice(reason);
      return;
    }
    const msg = parsed.msg;
    const fail = (err: unknown) => logger.error(`${msg.type} handler failed`, { err: String(err) });
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
    const conn = new Connection(id, socket, meta.ip, randomHex(16), deps.bus, meta.userAgent, meta.origin);
    const reject = (notice: string, reason: string) => {
      conn.notice(notice);
      conn.close(1008, reason);
      return noopHandle(id);
    };
    if (stopped) return reject("error: relay is shutting down", "shutting down");
    const verdict = ctx.ipRules.check(meta.ip);
    if (verdict.blocked) return reject(`blocked: ${verdict.reason ?? "your IP address is blocked"}`, "blocked");
    const k = ipKey(meta.ip);
    const count = ipCounts.get(k) ?? 0;
    const max = ctx.s().limits.connectionsPerIp;
    if (!verdict.allowed && max > 0 && count >= max) return reject("rate-limited: too many connections from your IP address", "too many connections");
    ipCounts.set(k, count + 1);
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
  async function retentionTick() {
    const intervalMs = Math.max(1, ctx.s().retention.intervalMinutes) * 60_000;
    if (Date.now() - lastRetention < intervalMs) return;
    lastRetention = Date.now();
    await runRetention(ctx);
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
    disconnect(target) {
      let n = 0;
      for (const conn of [...conns.values()]) {
        const hit =
          (target.id !== undefined && conn.id === target.id) ||
          (target.pubkey !== undefined && conn.authedPubkeys.has(target.pubkey)) ||
          (target.ip !== undefined && conn.ip === target.ip);
        if (!hit) continue;
        closeConn(conn, "blocked: disconnected by relay operator", 1008, "disconnected");
        n++;
      }
      return n;
    },
    nip11: () => buildNip11(ctx),
    groups: {
      list: async () => ctx.groups.list(),
      get: async (id) => ctx.groups.get(id),
      delete: (id, actor) => ctx.groups.delete(id, actor),
    },
    async start() {
      stopped = false;
      scheduler.every("ip-rules", IP_RULES_REFRESH_MS, refreshIpRules);
      offIpRules?.();
      offIpRules = deps.bus.on("ip.rules.changed", () => void scheduler.runNow("ip-rules", refreshIpRules));
      scheduler.every("expiration", EXPIRATION_PURGE_MS, purgeExpired);
      scheduler.every("retention", 60_000, retentionTick);
      scheduler.every("rate-sweep", 60_000, () => ctx.rate.sweep());
      void scheduler.runNow("expiration", purgeExpired);
    },
    async stop() {
      stopped = true;
      offIpRules?.();
      offIpRules = undefined;
      scheduler.stopAll();
      for (const conn of [...conns.values()]) {
        conn.notice("error: relay is shutting down");
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
