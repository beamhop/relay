// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `RelayRoom` Durable Object: one per virtual-relay shard (`<relayId>#<shard>`).
 *
 * Uses the WebSocket Hibernation API: sockets are accepted with
 * `state.acceptWebSocket`, so the object can be evicted from memory while clients
 * stay connected. On wake-up the constructor rebuilds a fresh kernel for this room
 * and every `Connection` from its socket attachment, then calls the optional
 * `kernel.ws.onRestore(conn)` so the relay engine can re-index subscriptions.
 *
 * Each room has its own kernel (not shared per isolate): several rooms may live in
 * one isolate, and a room may only do I/O on its own sockets.
 */
import { type Kernel, parseConfig } from '@beamhop/core';
import type { DurableObjectStateLike, HibernatableWebSocket } from './cf-types.ts';
import { type ConnAttachment, HibernatableConnection, connStorageKey } from './connection.ts';
import { PUBSUB_PATH, ShardedPubSub, shardName } from './ports/pubsub.ts';
import { AlarmScheduler, type RoomJobFilter } from './ports/scheduler.ts';
import type { SharedServices } from './runtime.ts';

export const ROOM_IDENTITY_KEY = 'beamhop:room';
export const CONFIG_CHANNEL = 'broadcast:config';

/** Headers set by the Worker when forwarding an upgrade to a room. */
export const H_RELAY = 'x-beamhop-relay';
export const H_SHARD = 'x-beamhop-shard';
export const H_IP_HASH = 'x-beamhop-ip-hash';
/** ISO country from Cloudflare's `cf-ipcountry` (set by the Worker, never by clients). */
export const H_COUNTRY = 'x-beamhop-country';

export interface RoomIdentity {
  relayId: string;
  shard: number;
}

export interface RoomHooks {
  /** Create the (client, server) socket pair. Default: `new WebSocketPair()`. */
  createPair?: () => { client: unknown; server: HibernatableWebSocket };
  /** Build the 101 response. Default: `new Response(null, { status: 101, webSocket })`. */
  upgradeResponse?: (client: unknown) => Response;
  /** Defer a state flush. Default: `setTimeout(fn, 0)`. */
  defer?: (fn: () => void) => void;
  roomJobFilter?: RoomJobFilter;
}

function defaultCreatePair(): { client: unknown; server: HibernatableWebSocket } {
  const Pair = (globalThis as unknown as { WebSocketPair?: new () => Record<0 | 1, unknown> })
    .WebSocketPair;
  if (!Pair) throw new Error('WebSocketPair is only available on Cloudflare Workers');
  const pair = new Pair();
  return { client: pair[0], server: pair[1] as HibernatableWebSocket };
}

function defaultUpgradeResponse(client: unknown): Response {
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

export class RelayRoomCore {
  identity: RoomIdentity | null = null;
  kernel: Kernel | null = null;
  pubsub: ShardedPubSub | null = null;
  scheduler: AlarmScheduler | null = null;
  readonly conns = new Map<HibernatableWebSocket, HibernatableConnection>();
  readonly ready: Promise<void>;
  private readonly dirty = new Set<HibernatableConnection>();
  private flushScheduled = false;
  private pendingFlush: Promise<void> = Promise.resolve();

  constructor(
    readonly state: DurableObjectStateLike,
    private readonly shared: () => Promise<SharedServices>,
    private readonly hooks: RoomHooks = {},
  ) {
    this.ready = state.blockConcurrencyWhile(async () => {
      const identity = await state.storage.get<RoomIdentity>(ROOM_IDENTITY_KEY);
      if (identity) await this.boot(identity);
    });
  }

  private async boot(identity: RoomIdentity): Promise<void> {
    this.identity = identity;
    const services = await this.shared();
    const logger = services.logger.child({ room: shardName(identity.relayId, identity.shard) });
    this.pubsub = new ShardedPubSub({
      namespace: services.env.RELAY_ROOM,
      relayIds: () => (this.kernel?.config() ?? services.baseConfig).relays.map((r) => r.id),
      shards: services.shards,
      self: shardName(identity.relayId, identity.shard),
      logger,
    });
    this.scheduler = new AlarmScheduler(
      this.state.storage,
      services.clock,
      logger,
      () => this.state.getWebSockets().length > 0,
      this.hooks.roomJobFilter,
    );
    this.kernel = await services.createKernel({
      pubsub: this.pubsub,
      scheduler: this.scheduler,
      logger,
    });
    const kernel = this.kernel;
    this.pubsub.subscribe(CONFIG_CHANNEL, (next) => {
      try {
        void kernel.applyConfig(parseConfig(next));
      } catch (err) {
        logger.log('warn', 'Ignored an invalid configuration update', { error: String(err) });
      }
    });
    // Rebuild connections that survived hibernation.
    for (const ws of this.state.getWebSockets()) await this.restore(ws);
    await this.scheduler.restore();
  }

  private async restore(ws: HibernatableWebSocket): Promise<HibernatableConnection | null> {
    const existing = this.conns.get(ws);
    if (existing) return existing;
    const att = ws.deserializeAttachment();
    if (!HibernatableConnection.isAttachment(att)) return null;
    const ext = (att as ConnAttachment).ext
      ? await this.state.storage.get<string>(connStorageKey(att.id))
      : undefined;
    const conn = HibernatableConnection.restore(ws, att, ext, (c) => this.markDirty(c));
    this.conns.set(ws, conn);
    this.kernel?.ws?.onRestore?.(conn);
    return conn;
  }

  async fetch(req: Request): Promise<Response> {
    await this.ready;
    const url = new URL(req.url);
    if (url.pathname === PUBSUB_PATH && req.method === 'POST') {
      // A room that never booted has no subscribers: nothing to deliver.
      if (!this.pubsub) return new Response(null, { status: 204 });
      return this.pubsub.receive(req);
    }
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const relayId = req.headers.get(H_RELAY);
    const shard = Number(req.headers.get(H_SHARD) ?? '0');
    if (!relayId) return new Response('Missing relay', { status: 400 });
    if (!this.identity) {
      const identity = { relayId, shard };
      await this.state.storage.put(ROOM_IDENTITY_KEY, identity);
      await this.boot(identity);
    }
    const kernel = this.kernel as Kernel;
    if (!kernel.ws) {
      return new Response('The relay engine is not enabled on this server', { status: 503 });
    }
    const services = await this.shared();
    const { client, server } = (this.hooks.createPair ?? defaultCreatePair)();
    this.state.acceptWebSocket(server, [relayId]);
    const conn = new HibernatableConnection(
      server,
      {
        id: services.crypto.randomHex(16),
        relayId,
        ipHash: req.headers.get(H_IP_HASH) ?? 'unknown',
        userAgent: req.headers.get('user-agent') ?? undefined,
        country: req.headers.get(H_COUNTRY) ?? undefined,
        host: new URL(req.url).hostname.toLowerCase(),
        openedAt: services.clock.nowMs(),
        challenge: services.crypto.randomHex(32),
      },
      undefined,
      (c) => this.markDirty(c),
    );
    this.conns.set(server, conn);
    try {
      kernel.ws.onOpen(conn);
    } catch (err) {
      services.logger.log('error', 'Connection open handler failed', { error: String(err) });
    }
    await this.persist(conn);
    await this.scheduler?.arm();
    return (this.hooks.upgradeResponse ?? defaultUpgradeResponse)(client);
  }

  async webSocketMessage(ws: HibernatableWebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const conn = await this.restore(ws);
    if (!conn || !this.kernel?.ws) {
      ws.close(1011, 'connection state lost');
      return;
    }
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    this.kernel.ws.onMessage(conn, raw);
    this.markDirty(conn);
  }

  async webSocketClose(ws: HibernatableWebSocket, code: number, reason: string): Promise<void> {
    await this.ready;
    const conn = await this.restore(ws);
    this.conns.delete(ws);
    if (conn) {
      this.dirty.delete(conn);
      conn.closed = true;
      try {
        this.kernel?.ws?.onClose(conn);
      } finally {
        if (conn.ext) await this.state.storage.delete(connStorageKey(conn.id));
      }
    }
    try {
      // Complete the close handshake (no-op if already closed).
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // ignore
    }
  }

  async webSocketError(ws: HibernatableWebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.scheduler?.onAlarm();
  }

  // ───────────── state persistence (attachment / storage spill) ─────────────

  markDirty(conn: HibernatableConnection): void {
    if (conn.closed) return;
    this.dirty.add(conn);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    (this.hooks.defer ?? ((fn) => setTimeout(fn, 0)))(() => {
      this.flushScheduled = false;
      this.pendingFlush = this.flush();
    });
  }

  /** Persist all dirty connections now. */
  async flush(): Promise<void> {
    await this.pendingFlush;
    const batch = [...this.dirty];
    this.dirty.clear();
    for (const conn of batch) await this.persist(conn);
  }

  async persist(conn: HibernatableConnection): Promise<void> {
    if (conn.closed) return;
    const snap = conn.snapshot();
    if (!snap) return;
    if (snap.spill !== null) {
      await this.state.storage.put(connStorageKey(conn.id), snap.spill);
      conn.ext = true;
    } else if (conn.ext) {
      await this.state.storage.delete(connStorageKey(conn.id));
      conn.ext = false;
    }
    conn.ws.serializeAttachment(snap.attachment);
    conn.lastPersisted = snap.signature;
  }
}
