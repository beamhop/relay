// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The relay engine: NIP-01 protocol over the runtime-neutral `Connection`,
 * live fan-out through an inverted subscription index, cross-node fan-out
 * through `ports.pubsub`, and the NIP handlers (09, 13, 17/59, 29, 40, 42, 45,
 * 50, 62, 70, 77).
 *
 * Hibernation: everything a connection needs to survive a Cloudflare Durable
 * Object eviction lives in `conn.state` as JSON data (`relay` key: open
 * subscriptions and negentropy sessions as filters); NIP-42 pubkeys live in
 * `conn.authed`. `onRestore` re-indexes subscriptions without replaying stored
 * events or EOSE; negentropy sessions are rebuilt lazily on the next NEG-MSG.
 *
 * Concurrency model: messages of one connection are processed in order on a
 * per-connection promise chain (so AUTH-then-EVENT is deterministic). The
 * stored-events phase of a REQ runs detached from the chain so a slow query
 * never blocks CLOSE or other messages; live events that match while that
 * query runs are buffered and flushed after EOSE (deduplicated).
 */
import {
  type Connection,
  type ConnectionHandler,
  type Decision,
  type Filter,
  type Kernel,
  type NostrEvent,
  type PolicyContext,
  type ReasonPrefix,
  type RelayConfig,
  type RelayId,
  expirationOf,
  kindClass,
  parseClientMessage,
  reason,
  tagValues,
  validateEventShape,
  validateFilter,
  verifyEventId,
  verifyEventSig,
} from '@beamhop/core';
import { type RelayModuleConfig, RelayModuleConfigSchema } from './config.ts';
import { type Audience, type RelayExtension, allAudiences } from './extensions.ts';
import { GIFT_WRAP_KINDS, giftWrapExtension } from './giftwrap.ts';
import type { GroupsConfig } from './groups.ts';
import { archiveHeld, deletionTargets, holdsOf, queryAll } from './holds.ts';
import { type IndexedSub, SubscriptionIndex } from './subindex.ts';
import { Negentropy, NegentropyStorageVector } from './vendor/negentropy.ts';

export const RELAY_MODULE_ID = 'relay';
export const AUTH_KIND = 22242;
export const VANISH_KIND = 62;
export const DELETION_KIND = 5;
export const REPORT_KIND = 1984;

export interface Subscription extends IndexedSub {
  readonly subId: string;
  readonly subIdJson: string;
  readonly conn: ConnState;
  readonly abort: AbortController;
  /** Live events buffered while the stored-events query runs; null after EOSE. */
  pending: NostrEvent[] | null;
}

export interface ConnState {
  readonly conn: Connection;
  readonly relayId: RelayId;
  readonly subs: Map<string, Subscription>;
  /** Live negentropy sessions (rebuilt lazily from `negFilters` after hibernation). */
  readonly negs: Map<string, Negentropy>;
  /** Filters of open negentropy sessions (persisted). */
  readonly negFilters: Map<string, Filter[]>;
  readonly tiers: Map<string, string | undefined>;
  chain: Promise<void>;
  pending: number;
  opened: boolean;
  closed: boolean;
  dropping: boolean;
  dropped: number;
}

interface RelayRuntime {
  index: SubscriptionIndex<Subscription>;
  seen: RecentIds;
  unsubscribe: () => void;
}

/** Wire format of cross-node fan-out messages on `relay:<relayId>`. */
export interface FanoutMessage {
  /** Origin node id (messages from self are ignored). */
  o: string;
  e: NostrEvent;
}

export function fanoutChannel(relayId: RelayId): string {
  return `relay:${relayId}`;
}

/** Bounded insertion-ordered id set used for dedupe-before-verify and pubsub dedupe. */
export class RecentIds {
  private set = new Set<string>();
  constructor(private capacity: number) {}
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    if (this.set.size > this.capacity) {
      const first = this.set.values().next().value;
      if (first !== undefined) this.set.delete(first);
    }
  }
  delete(id: string): void {
    this.set.delete(id);
  }
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Does a relay URL (from an AUTH or vanish tag) point at this virtual relay? */
export function relayUrlMatches(relay: RelayConfig, url: string, connHost?: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return relay.hosts.some((h) => {
    // A catch-all relay is "this relay" only under the host the client actually connected to.
    if (h === '*') return connHost === undefined || connHost === host;
    return h.toLowerCase().replace(/:\d+$/, '') === host;
  });
}

const noop = () => {};
/** Key in `Connection.state` marking a connection the engine has torn down. */
const CLOSED_KEY = 'relay.closed';

/** PubSub channel (enterprise identity): `{ pubkey, reason }` → drop that key's sockets everywhere. */
export const REVOKED_CHANNEL = 'enterprise.revoked';
/** Key in `Connection.state` holding the hibernation-safe connection state. */
export const CONN_STATE_KEY = 'relay';
type Detached = { detached?: Promise<void> };

/** JSON-serializable per-connection state kept in `conn.state` (survives hibernation). */
export interface PersistedConnState {
  v: 1;
  /** subId → filters (after validation, limits and extension rewrites). */
  subs: Record<string, Filter[]>;
  /** NEG subId → filter. */
  negs: Record<string, Filter[]>;
}

function readPersisted(conn: Connection): PersistedConnState | null {
  const v = conn.state.get(CONN_STATE_KEY) as Partial<PersistedConnState> | undefined;
  if (!v || typeof v !== 'object' || v.v !== 1) return null;
  const clean = (rec: unknown): Record<string, Filter[]> => {
    const out: Record<string, Filter[]> = {};
    if (!rec || typeof rec !== 'object') return out;
    for (const [id, fs] of Object.entries(rec as Record<string, unknown>)) {
      if (!Array.isArray(fs)) continue;
      const filters: Filter[] = [];
      for (const f of fs) {
        const check = validateFilter(f);
        if (check.ok) filters.push(check.filter);
      }
      if (filters.length > 0) out[id] = filters;
    }
    return out;
  };
  return { v: 1, subs: clean(v.subs), negs: clean(v.negs) };
}

export class RelayEngine implements ConnectionHandler {
  readonly nodeId: string;
  private conns = new Map<string, ConnState>();
  private relays = new Map<RelayId, RelayRuntime>();
  private cfg: RelayModuleConfig;
  private offConfig: () => void;
  private offRevoked: () => void;
  private extensions: RelayExtension[] = [giftWrapExtension];

  constructor(private kernel: Kernel) {
    this.nodeId = kernel.ports.crypto.randomHex(8);
    this.cfg = RelayModuleConfigSchema.parse(kernel.config().modules[RELAY_MODULE_ID] ?? {});
    this.offConfig = kernel.onConfigChange((next) => {
      this.cfg = RelayModuleConfigSchema.parse(next.modules[RELAY_MODULE_ID] ?? {});
    });
    // Cluster-wide revocation (enterprise offboarding): every node drops the person's sockets.
    this.offRevoked = kernel.ports.pubsub.subscribe(REVOKED_CHANNEL, (msg) => {
      const m = msg as { pubkey?: unknown; reason?: unknown } | null;
      if (typeof m?.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(m.pubkey)) return;
      this.disconnectPubkey(m.pubkey, typeof m.reason === 'string' ? m.reason : undefined);
    });
  }

  /**
   * Close every live connection on this node authenticated (NIP-42) as `pubkey`.
   * Returns how many were closed. Other nodes do the same when a message
   * arrives on the `enterprise.revoked` PubSub channel.
   */
  disconnectPubkey(pubkey: string, reason?: string): number {
    let n = 0;
    for (const st of [...this.conns.values()]) {
      if (st.closed || !st.conn.authed.has(pubkey)) continue;
      this.send(st, ['NOTICE', `restricted: ${reason ? reason.slice(0, 200) : 'access revoked'}`]);
      this.closeConn(st, 1008, 'restricted: access revoked');
      n++;
    }
    if (n > 0)
      this.kernel.ports.logger.log('info', 'connections closed for revoked key', { count: n });
    return n;
  }

  config(): RelayModuleConfig {
    return this.cfg;
  }

  groupsConfig(): GroupsConfig {
    return this.cfg.groups;
  }

  /** Register an internal NIP extension (read/write gates, side effects). */
  addExtension(ext: RelayExtension): void {
    this.extensions = [...this.extensions.filter((e) => e.id !== ext.id), ext];
  }

  /** Number of open connections (all relays or one relay). */
  connectionCount(relayId?: RelayId): number {
    if (!relayId) return this.conns.size;
    let n = 0;
    for (const c of this.conns.values()) if (c.relayId === relayId) n++;
    return n;
  }

  subscriptionCount(relayId: RelayId): number {
    return this.relays.get(relayId)?.index.size ?? 0;
  }

  stop(): void {
    this.offConfig();
    this.offRevoked();
    for (const rt of this.relays.values()) rt.unsubscribe();
    this.relays.clear();
  }

  // ───────────────────────── ConnectionHandler ─────────────────────────

  onOpen(conn: Connection): void {
    this.open(conn);
  }

  onMessage(conn: Connection, raw: string): void {
    void this.handle(conn, raw);
  }

  onClose(conn: Connection): void {
    const st = this.conns.get(conn.id);
    if (!st) return;
    this.teardown(st);
    if (st.opened) {
      this.kernel.bus.emit('conn.close', {
        relayId: st.relayId,
        connId: conn.id,
        durationMs: Math.max(0, this.kernel.ports.clock.nowMs() - conn.openedAt),
      });
    }
  }

  /**
   * Rebuild a connection after socket hibernation: re-index persisted
   * subscriptions (live only — no stored events, no EOSE) and remember
   * negentropy sessions. The connect policy and AUTH challenge are not re-run.
   */
  onRestore(conn: Connection): void {
    if (this.conns.has(conn.id) || conn.state.get(CLOSED_KEY)) return;
    const saved = readPersisted(conn);
    if (!saved) return;
    const st = this.newState(conn);
    st.opened = true;
    this.conns.set(conn.id, st);
    const rt = this.runtime(st.relayId);
    for (const [subId, filters] of Object.entries(saved.subs)) {
      const sub = this.makeSub(st, subId, filters);
      sub.pending = null;
      st.subs.set(subId, sub);
      rt.index.add(sub);
    }
    for (const [subId, filters] of Object.entries(saved.negs)) st.negFilters.set(subId, filters);
  }

  private newState(conn: Connection): ConnState {
    return {
      conn,
      relayId: conn.relayId,
      subs: new Map(),
      negs: new Map(),
      negFilters: new Map(),
      tiers: new Map(),
      chain: Promise.resolve(),
      pending: 0,
      opened: false,
      closed: false,
      dropping: false,
      dropped: 0,
    };
  }

  private makeSub(st: ConnState, subId: string, filters: Filter[]): Subscription {
    return {
      key: `${st.conn.id}\u0000${subId}`,
      subId,
      subIdJson: JSON.stringify(subId),
      filters,
      conn: st,
      abort: new AbortController(),
      pending: [],
    };
  }

  /** Mirror subscriptions and sync sessions into `conn.state` (hibernation). */
  private persist(st: ConnState): void {
    if (st.closed) return;
    const subs: Record<string, Filter[]> = {};
    for (const [id, sub] of st.subs) subs[id] = sub.filters;
    const negs: Record<string, Filter[]> = {};
    for (const [id, f] of st.negFilters) negs[id] = f;
    const value: PersistedConnState = { v: 1, subs, negs };
    st.conn.state.set(CONN_STATE_KEY, value);
  }

  /** Open a connection; resolves when the connect policy has run. */
  open(conn: Connection): Promise<void> {
    const existing = this.conns.get(conn.id);
    if (existing) return existing.chain;
    conn.state.delete(CLOSED_KEY);
    const st = this.newState(conn);
    this.conns.set(conn.id, st);
    st.chain = this.connect(st).catch((err) => this.fail(st, 'connect', err));
    return st.chain;
  }

  /**
   * Process one client frame. Resolves once the message is fully handled,
   * including the stored-events phase of a REQ (useful for tests and runtimes
   * that want to await work, e.g. Durable Object `waitUntil`).
   */
  async handle(conn: Connection, raw: string): Promise<void> {
    let st = this.conns.get(conn.id);
    if (!st) {
      if (conn.state.get(CLOSED_KEY)) return;
      // A hibernated connection whose runtime did not call onRestore.
      if (readPersisted(conn)) this.onRestore(conn);
      else void this.open(conn);
      st = this.conns.get(conn.id)!;
    }
    if (st.closed) return;
    if (st.pending >= this.cfg.maxPendingMessages) {
      this.send(st, ['NOTICE', reason('rate-limited', 'too many messages in flight, slow down')]);
      return;
    }
    st.pending++;
    const start = this.kernel.ports.clock.nowMs();
    const state = st;
    const run = st.chain.then(() => (state.closed ? undefined : this.dispatch(state, raw, start)));
    st.chain = run
      .then(noop, (err) => this.fail(state, 'message', err))
      .finally(() => {
        state.pending--;
      });
    try {
      const res = await run;
      if (res?.detached) await res.detached;
    } catch {
      // already reported via fail()
    }
  }

  // ───────────────────────── connection lifecycle ─────────────────────────

  private async connect(st: ConnState): Promise<void> {
    const { conn } = st;
    const relay = this.kernel.relay(st.relayId);
    if (!relay) {
      this.send(st, ['NOTICE', reason('error', 'unknown relay')]);
      this.closeConn(st, 1008, 'unknown relay');
      return;
    }
    conn.challenge = this.kernel.ports.crypto.randomHex(16);
    const d = await this.kernel.policy.run('onConnect', [this.ctx(st)]);
    if (d.action === 'reject') {
      this.send(st, ['NOTICE', reason(d.prefix, d.message)]);
      this.closeConn(st, 1008, d.prefix);
      return;
    }
    st.opened = true;
    this.persist(st);
    this.runtime(st.relayId);
    this.kernel.bus.emit('conn.open', {
      relayId: st.relayId,
      connId: conn.id,
      ipHash: conn.ipHash,
      ...(conn.userAgent !== undefined ? { userAgent: conn.userAgent } : {}),
      ...(conn.country !== undefined ? { country: conn.country } : {}),
    });
    this.send(st, ['AUTH', conn.challenge]);
  }

  private teardown(st: ConnState): void {
    st.closed = true;
    st.conn.state.set(CLOSED_KEY, true);
    const rt = this.relays.get(st.relayId);
    for (const sub of st.subs.values()) {
      sub.abort.abort();
      rt?.index.remove(sub.key);
    }
    st.subs.clear();
    st.negs.clear();
    st.negFilters.clear();
    this.conns.delete(st.conn.id);
  }

  private closeConn(st: ConnState, code: number, why: string): void {
    if (st.closed) return;
    this.teardown(st);
    try {
      st.conn.close(code, why);
    } catch {
      // socket already gone
    }
    if (st.opened) {
      this.kernel.bus.emit('conn.close', {
        relayId: st.relayId,
        connId: st.conn.id,
        durationMs: Math.max(0, this.kernel.ports.clock.nowMs() - st.conn.openedAt),
      });
      st.opened = false;
    }
  }

  private fail(st: ConnState | null, source: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.kernel.bus.emit('error', {
      ...(st ? { relayId: st.relayId } : {}),
      source: `relay.${source}`,
      message,
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });
    this.kernel.ports.logger.log('error', 'relay engine error', { source, message });
  }

  // ───────────────────────── per-relay runtime ─────────────────────────

  private runtime(relayId: RelayId): RelayRuntime {
    let rt = this.relays.get(relayId);
    if (rt) return rt;
    const index = new SubscriptionIndex<Subscription>();
    const seen = new RecentIds(this.cfg.dedupeCacheSize);
    const unsubscribe = this.kernel.ports.pubsub.subscribe(fanoutChannel(relayId), (msg) =>
      this.onRemote(relayId, msg),
    );
    rt = { index, seen, unsubscribe };
    this.relays.set(relayId, rt);
    return rt;
  }

  private onRemote(relayId: RelayId, msg: unknown): void {
    const m = msg as Partial<FanoutMessage> | null;
    if (!m || typeof m !== 'object' || m.o === this.nodeId || !m.e) return;
    const rt = this.relays.get(relayId);
    if (!rt) return;
    const shape = validateEventShape(m.e);
    if (!shape.ok) return;
    if (rt.seen.has(shape.event.id)) return;
    rt.seen.add(shape.event.id);
    void this.fanoutChecked(relayId, rt, shape.event);
  }

  /**
   * Who may receive `event` (NIP-59 recipients, NIP-29 private group members).
   * Synchronous unless an extension needs a lookup.
   */
  audienceOf(relayId: RelayId, event: NostrEvent): Audience | Promise<Audience> {
    let list: Audience[] | null = null;
    let promises: Promise<Audience>[] | null = null;
    for (const ext of this.extensions) {
      if (!ext.audience) continue;
      const a = ext.audience(relayId, event);
      if (a instanceof Promise) {
        if (!promises) promises = [];
        promises.push(a);
      } else if (a) {
        if (!list) list = [];
        list.push(a);
      }
    }
    if (promises) {
      const base = list ?? [];
      return Promise.all(promises).then((r) => allAudiences([...base, ...r]));
    }
    return list ? allAudiences(list) : null;
  }

  /**
   * Publish an accepted event to local subscribers and other nodes. Resolves
   * once local delivery is done.
   */
  broadcast(relayId: RelayId, event: NostrEvent, json?: string): Promise<void> {
    const rt = this.runtime(relayId);
    rt.seen.add(event.id);
    const message: FanoutMessage = { o: this.nodeId, e: event };
    this.kernel.ports.pubsub
      .publish(fanoutChannel(relayId), message)
      .catch((err) => this.fail(null, 'pubsub', err));
    return this.fanoutChecked(relayId, rt, event, json);
  }

  private fanoutChecked(
    relayId: RelayId,
    rt: RelayRuntime,
    event: NostrEvent,
    json?: string,
  ): Promise<void> {
    const aud = this.audienceOf(relayId, event);
    if (aud instanceof Promise) {
      // Fail closed: when visibility cannot be determined, nothing is delivered live.
      return aud.then(
        (a) => this.fanout(rt, event, json, a),
        (err) => this.fail(null, 'audience', err),
      );
    }
    this.fanout(rt, event, json, aud);
    return Promise.resolve();
  }

  private fanout(
    rt: RelayRuntime,
    event: NostrEvent,
    json: string | undefined,
    aud: Audience,
  ): void {
    const subs = rt.index.match(event);
    if (subs.length === 0) return;
    const body = json ?? JSON.stringify(event);
    for (const sub of subs) this.deliver(sub, event, body, aud);
  }

  private deliver(sub: Subscription, event: NostrEvent, json: string, aud: Audience): void {
    const st = sub.conn;
    if (st.closed) return;
    if (aud && !aud(st.conn.authed)) return;
    if (sub.pending) {
      sub.pending.push(event);
      return;
    }
    if (!this.hasRoom(st)) return;
    st.conn.send(`["EVENT",${sub.subIdJson},${json}]`);
  }

  /** May this connection receive a stored event? (fails closed on lookup errors) */
  private visibleTo(st: ConnState, e: NostrEvent): boolean | Promise<boolean> {
    const a = this.audienceOf(st.relayId, e);
    if (a instanceof Promise)
      return a.then(
        (x) => !x || x(st.conn.authed),
        () => false,
      );
    return !a || a(st.conn.authed);
  }

  /** Backpressure gate for live frames. */
  private hasRoom(st: ConnState): boolean {
    const buffered = st.conn.bufferedAmount();
    const bp = this.cfg.backpressure;
    if (buffered > bp.closeAboveBytes) {
      this.send(st, ['NOTICE', reason('error', 'connection too slow, closing')]);
      this.closeConn(st, 1013, 'slow consumer');
      return false;
    }
    if (buffered > bp.dropAboveBytes) {
      st.dropped++;
      if (!st.dropping) {
        st.dropping = true;
        this.send(st, ['NOTICE', reason('rate-limited', 'connection too slow, skipping updates')]);
      }
      return false;
    }
    st.dropping = false;
    return true;
  }

  // ───────────────────────── dispatch ─────────────────────────

  private send(st: ConnState, msg: unknown[]): void {
    if (st.closed && msg[0] !== 'NOTICE') return;
    try {
      st.conn.send(JSON.stringify(msg));
    } catch (err) {
      this.fail(st, 'send', err);
    }
  }

  private ctx(st: ConnState, tier?: string): PolicyContext {
    const ctx: PolicyContext = {
      relayId: st.relayId,
      now: this.kernel.ports.clock.now(),
      conn: st.conn,
    };
    if (tier !== undefined) ctx.tier = tier;
    return ctx;
  }

  private async dispatch(st: ConnState, raw: string, start: number): Promise<Detached | undefined> {
    if (raw.length > this.cfg.maxMessageBytes) {
      this.send(st, ['NOTICE', reason('invalid', 'message is too large')]);
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(st, ['NOTICE', parsed.reason]);
      return;
    }
    const msg = parsed.message;
    switch (msg[0]) {
      case 'EVENT':
        await this.onEvent(st, msg[1], start);
        return;
      case 'REQ':
        return this.onReq(st, msg[1], msg.slice(2), start);
      case 'CLOSE':
        this.removeSub(st, msg[1]);
        return;
      case 'COUNT':
        await this.onCount(st, msg[1], msg.slice(2));
        return;
      case 'AUTH':
        await this.onAuth(st, msg[1]);
        return;
      case 'NEG-OPEN':
        await this.onNegOpen(st, msg[1], msg[2], msg[3]);
        return;
      case 'NEG-MSG':
        await this.onNegMsg(st, msg[1], msg[2]);
        return;
      case 'NEG-CLOSE':
        this.closeNeg(st, msg[1]);
        return;
    }
  }

  // ───────────────────────── access helpers ─────────────────────────

  private async tierOf(st: ConnState, pubkey: string | null): Promise<string | undefined> {
    if (!pubkey) return undefined;
    if (st.tiers.has(pubkey)) return st.tiers.get(pubkey);
    let tier: string | undefined;
    for (const r of this.kernel.access) {
      if (!r.tierOf) continue;
      tier = await r.tierOf(st.relayId, pubkey);
      if (tier !== undefined) break;
    }
    st.tiers.set(pubkey, tier);
    return tier;
  }

  private async canWrite(relay: RelayConfig, pubkey: string): Promise<boolean> {
    for (const r of this.kernel.access) {
      if (!r.canWrite) continue;
      const v = await r.canWrite(relay.id, pubkey);
      if (v !== undefined) return v;
    }
    if (relay.access.mode === 'open') return true;
    // Without an access module deciding, restricted modes admit only the owner.
    return relay.info.pubkey !== undefined && relay.info.pubkey === pubkey;
  }

  private async canRead(relay: RelayConfig, pubkey: string | null): Promise<boolean> {
    for (const r of this.kernel.access) {
      if (!r.canRead) continue;
      const v = await r.canRead(relay.id, pubkey);
      if (v !== undefined) return v;
    }
    return true;
  }

  private readerPubkey(st: ConnState): string | null {
    for (const pk of st.conn.authed) return pk;
    return null;
  }

  // ───────────────────────── EVENT ─────────────────────────

  private ok(st: ConnState, id: string, accepted: boolean, message: string): void {
    this.send(st, ['OK', id, accepted, message]);
  }

  private rejectEvent(
    st: ConnState,
    event: NostrEvent,
    prefix: ReasonPrefix,
    message: string,
    by?: string,
  ): void {
    const why = reason(prefix, message);
    this.ok(st, event.id, false, why);
    this.kernel.bus.emit('event.rejected', {
      relayId: st.relayId,
      eventId: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      reason: why,
      ...(by !== undefined ? { by } : {}),
    });
  }

  private async onEvent(st: ConnState, input: unknown, start: number): Promise<void> {
    const rawId =
      typeof input === 'object' &&
      input !== null &&
      typeof (input as { id?: unknown }).id === 'string'
        ? ((input as { id: string }).id as string)
        : '';
    const shape = validateEventShape(input);
    if (!shape.ok) {
      this.ok(st, rawId, false, shape.reason);
      return;
    }
    const event = shape.event;
    const relay = this.kernel.relay(st.relayId);
    if (!relay) {
      this.ok(st, event.id, false, reason('error', 'unknown relay'));
      return;
    }
    const store = this.kernel.ports.events;
    const rt = this.runtime(st.relayId);
    const now = this.kernel.ports.clock.now();
    const tier = await this.tierOf(st, event.pubkey);
    const limits = this.kernel.limits(st.relayId, tier);
    const json = JSON.stringify(event);
    const size = utf8Length(json);
    if (size > limits.maxEventBytes) {
      this.rejectEvent(
        st,
        event,
        'invalid',
        `event is too large (${size} > ${limits.maxEventBytes} bytes)`,
      );
      return;
    }

    // Dedupe before the (expensive) signature check.
    const cls = kindClass(event.kind);
    if (rt.seen.has(event.id)) {
      this.ok(st, event.id, true, reason('duplicate', 'already have this event'));
      return;
    }
    if (cls !== 'ephemeral' && (await store.getById(st.relayId, event.id))) {
      rt.seen.add(event.id);
      this.ok(st, event.id, true, reason('duplicate', 'already have this event'));
      return;
    }

    if (!verifyEventId(event)) {
      this.rejectEvent(st, event, 'invalid', 'event id does not match its content');
      return;
    }
    if (!verifyEventSig(event)) {
      this.rejectEvent(st, event, 'invalid', 'bad signature');
      return;
    }
    if (event.kind === AUTH_KIND) {
      this.rejectEvent(st, event, 'invalid', 'sign-in events must be sent with AUTH');
      return;
    }
    if (event.created_at > now + limits.maxCreatedAtFutureSeconds) {
      this.rejectEvent(st, event, 'invalid', 'created_at is too far in the future');
      return;
    }
    if (
      limits.maxCreatedAtPastSeconds > 0 &&
      event.created_at < now - limits.maxCreatedAtPastSeconds
    ) {
      this.rejectEvent(st, event, 'invalid', 'created_at is too far in the past');
      return;
    }
    const exp = expirationOf(event);
    if (exp !== undefined && exp <= now) {
      this.rejectEvent(st, event, 'invalid', 'event has expired');
      return;
    }

    // NIP-62: the right to vanish is never blocked by access or content policy.
    if (event.kind === VANISH_KIND) {
      await this.onVanish(st, relay, event, start);
      return;
    }

    if (limits.allowedKinds && !limits.allowedKinds.includes(event.kind)) {
      this.rejectEvent(st, event, 'blocked', `kind ${event.kind} is not allowed here`);
      return;
    }
    if (limits.blockedKinds.includes(event.kind)) {
      this.rejectEvent(st, event, 'blocked', `kind ${event.kind} is not allowed here`);
      return;
    }
    if (relay.access.authRequired.write && st.conn.authed.size === 0) {
      this.rejectEvent(st, event, 'auth-required', 'please sign in to post');
      return;
    }
    // NIP-70 protected events.
    if (event.tags.some((t) => t[0] === '-' && t.length === 1)) {
      if (st.conn.authed.size === 0) {
        this.rejectEvent(
          st,
          event,
          'auth-required',
          'this event may only be published by its author',
        );
        return;
      }
      if (!st.conn.authed.has(event.pubkey)) {
        this.rejectEvent(st, event, 'restricted', 'this event may only be published by its author');
        return;
      }
    }
    if (!(await this.canWrite(relay, event.pubkey))) {
      this.rejectEvent(st, event, 'restricted', 'you are not allowed to post here');
      return;
    }
    const wctx = { relayId: st.relayId, authed: st.conn.authed };
    for (const ext of this.extensions) {
      if (!ext.checkEvent) continue;
      const r = await ext.checkEvent(event, wctx);
      if (r) {
        this.rejectEvent(st, event, r.prefix, r.message, `relay.${ext.id}`);
        return;
      }
    }

    const d: Decision & { by?: string } = await this.kernel.policy.run('onEvent', [
      event,
      this.ctx(st, tier),
    ]);
    if (d.action === 'reject') {
      this.rejectEvent(st, event, d.prefix, d.message, d.by);
      return;
    }
    if (d.action === 'shadow') {
      this.ok(st, event.id, true, '');
      this.kernel.bus.emit('event.rejected', {
        relayId: st.relayId,
        eventId: event.id,
        pubkey: event.pubkey,
        kind: event.kind,
        reason: `shadow: ${d.message ?? ''}`.trim(),
        ...(d.by !== undefined ? { by: d.by } : {}),
      });
      return;
    }
    if (d.action === 'hold') {
      this.ok(st, event.id, true, d.message ?? '');
      this.kernel.bus.emit('event.held', {
        relayId: st.relayId,
        event,
        ...(d.by !== undefined ? { by: d.by } : {}),
        ...(d.message !== undefined ? { reason: d.message } : {}),
      });
      return;
    }

    if (cls === 'ephemeral') {
      this.ok(st, event.id, true, '');
      await this.accepted(st, event, json, start);
      return;
    }

    const res = await store.save(st.relayId, event);
    switch (res.status) {
      case 'duplicate':
        rt.seen.add(event.id);
        this.ok(st, event.id, true, reason('duplicate', 'already have this event'));
        return;
      case 'superseded':
        this.ok(st, event.id, true, reason('duplicate', 'a newer version is already stored'));
        return;
      case 'deleted':
        this.rejectEvent(st, event, 'blocked', 'this event has been deleted');
        return;
      case 'saved':
        break;
    }
    this.ok(st, event.id, true, '');
    if (event.kind === DELETION_KIND) {
      // Legal hold: held targets are archived first, then deleted as asked.
      const holds = holdsOf(this.kernel);
      if (holds) {
        const targets = await deletionTargets(this.kernel, st.relayId, event);
        await archiveHeld(this.kernel, holds, st.relayId, targets, 'nip09');
      }
      const ids = await store.applyDeletion(st.relayId, event);
      if (ids.length > 0)
        this.kernel.bus.emit('event.deleted', { relayId: st.relayId, ids, cause: 'nip09' });
    }
    if (event.kind === REPORT_KIND)
      this.kernel.bus.emit('report.received', { relayId: st.relayId, report: event });
    await this.accepted(st, event, json, start);
  }

  private async accepted(
    st: ConnState,
    event: NostrEvent,
    json: string,
    start: number,
  ): Promise<void> {
    const wctx = { relayId: st.relayId, authed: st.conn.authed };
    for (const ext of this.extensions) {
      if (!ext.afterAccept) continue;
      try {
        await ext.afterAccept(event, wctx);
      } catch (err) {
        this.fail(st, `${ext.id}.afterAccept`, err);
      }
    }
    await this.broadcast(st.relayId, event, json);
    this.kernel.bus.emit('event.accepted', {
      relayId: st.relayId,
      event,
      connId: st.conn.id,
      latencyMs: Math.max(0, this.kernel.ports.clock.nowMs() - start),
    });
  }

  private async onVanish(
    st: ConnState,
    relay: RelayConfig,
    event: NostrEvent,
    start: number,
  ): Promise<void> {
    const targets = tagValues(event, 'relay');
    const forUs = targets.some(
      (u) => u === 'ALL_RELAYS' || relayUrlMatches(relay, u, st.conn.host),
    );
    if (!forUs) {
      this.rejectEvent(st, event, 'invalid', 'this request to vanish names a different relay');
      return;
    }
    const store = this.kernel.ports.events;
    const until = event.created_at;
    // Stored gift-wrap kinds addressed to the vanishing user (NIP-62 SHOULD).
    const wraps: Filter = {
      kinds: [...GIFT_WRAP_KINDS].filter((k) => kindClass(k) !== 'ephemeral'),
      '#p': [event.pubkey],
      until,
    };
    // Collect (capped) ids before they are gone, for event.deleted consumers.
    const cap = this.cfg.vanishIdCap;
    let ids: string[] = [];
    if (cap > 0) {
      try {
        const evs = await store.query(
          st.relayId,
          [
            { authors: [event.pubkey], until, limit: cap },
            { ...wraps, limit: cap },
          ],
          { maxLimit: cap },
        );
        ids = evs.slice(0, cap).map((e) => e.id);
      } catch (err) {
        this.fail(st, 'vanish', err);
      }
    }
    // Legal hold: archive held events (the user's own and wraps addressed to
    // them) before they are erased; the request itself is still honoured.
    const holds = holdsOf(this.kernel);
    if (holds) {
      const own = await queryAll(this.kernel, st.relayId, { authors: [event.pubkey], until });
      await archiveHeld(this.kernel, holds, st.relayId, own, 'nip62');
      const received = await queryAll(this.kernel, st.relayId, wraps);
      await archiveHeld(this.kernel, holds, st.relayId, received, 'nip62', () => event.pubkey);
    }
    const removed =
      (await store.vanish(st.relayId, event.pubkey, until)) +
      (await store.deleteMatching(st.relayId, wraps));
    this.runtime(st.relayId).seen.add(event.id);
    this.ok(st, event.id, true, '');
    this.kernel.bus.emit('event.deleted', {
      relayId: st.relayId,
      ids,
      cause: 'nip62',
      count: Math.max(removed, ids.length),
    });
    this.kernel.bus.emit('event.accepted', {
      relayId: st.relayId,
      event,
      connId: st.conn.id,
      latencyMs: Math.max(0, this.kernel.ports.clock.nowMs() - start),
    });
  }

  // ───────────────────────── REQ / COUNT ─────────────────────────

  /**
   * Validate filters and read access shared by REQ, COUNT and NEG-OPEN.
   * On failure calls `fail(reason)` and returns null.
   */
  private async prepareRead(
    st: ConnState,
    rawFilters: unknown[],
    fail: (why: string) => void,
  ): Promise<{ filters: Filter[]; maxLimit: number } | null> {
    const relay = this.kernel.relay(st.relayId);
    if (!relay) {
      fail(reason('error', 'unknown relay'));
      return null;
    }
    const reader = this.readerPubkey(st);
    const tier = await this.tierOf(st, reader);
    const limits = this.kernel.limits(st.relayId, tier);
    if (rawFilters.length === 0) {
      fail(reason('invalid', 'at least one filter is required'));
      return null;
    }
    if (rawFilters.length > limits.maxFilters) {
      fail(reason('invalid', `too many filters (max ${limits.maxFilters})`));
      return null;
    }
    const filters: Filter[] = [];
    for (const f of rawFilters) {
      const check = validateFilter(f);
      if (!check.ok) {
        fail(check.reason);
        return null;
      }
      const limit = Math.min(check.filter.limit ?? limits.maxLimit, limits.maxLimit);
      filters.push({ ...check.filter, limit });
    }
    if (
      filters.some((f) => f.search !== undefined) &&
      !this.kernel.ports.events.capabilities.search
    ) {
      fail('unsupported: search is not supported by this relay');
      return null;
    }
    if (relay.access.authRequired.read && st.conn.authed.size === 0) {
      fail(reason('auth-required', 'please sign in to read'));
      return null;
    }
    if (!(await this.canRead(relay, reader))) {
      fail(reason('restricted', 'you are not allowed to read here'));
      return null;
    }
    let checked = filters;
    for (const ext of this.extensions) {
      if (!ext.filters) continue;
      const r = await ext.filters(st.relayId, checked, st.conn.authed);
      if (!r.ok) {
        fail(reason(r.prefix, r.message));
        return null;
      }
      checked = r.filters;
    }
    const d = await this.kernel.policy.run('onReq', [checked, this.ctx(st, tier)]);
    if (d.action === 'reject') {
      fail(reason(d.prefix, d.message));
      return null;
    }
    if (d.action !== 'accept') {
      // shadow/hold on reads: serve nothing, silently.
      return { filters: [], maxLimit: limits.maxLimit };
    }
    return { filters: checked, maxLimit: limits.maxLimit };
  }

  private removeSub(st: ConnState, subId: string): void {
    const sub = st.subs.get(subId);
    if (!sub) return;
    sub.abort.abort();
    st.subs.delete(subId);
    this.relays.get(st.relayId)?.index.remove(sub.key);
    this.persist(st);
  }

  private async onReq(
    st: ConnState,
    subId: string,
    rawFilters: unknown[],
    start: number,
  ): Promise<Detached | undefined> {
    const closed = (why: string) => this.send(st, ['CLOSED', subId, why]);
    const prepared = await this.prepareRead(st, rawFilters, closed);
    if (!prepared) {
      this.removeSub(st, subId);
      return;
    }
    const limits = this.kernel.limits(st.relayId, await this.tierOf(st, this.readerPubkey(st)));
    if (!st.subs.has(subId) && st.subs.size >= limits.maxSubscriptions) {
      closed(
        reason('rate-limited', `too many open subscriptions (max ${limits.maxSubscriptions})`),
      );
      return;
    }
    this.removeSub(st, subId);
    if (prepared.filters.length === 0) {
      this.send(st, ['EOSE', subId]);
      return;
    }
    const sub = this.makeSub(st, subId, prepared.filters);
    st.subs.set(subId, sub);
    this.runtime(st.relayId).index.add(sub);
    this.persist(st);
    return { detached: this.serveStored(st, sub, prepared.maxLimit, start) };
  }

  private async serveStored(
    st: ConnState,
    sub: Subscription,
    maxLimit: number,
    start: number,
  ): Promise<void> {
    let events: NostrEvent[];
    try {
      events = await this.kernel.ports.events.query(st.relayId, sub.filters, {
        maxLimit,
        signal: sub.abort.signal,
      });
    } catch (err) {
      if (sub.abort.signal.aborted || st.closed) return;
      this.fail(st, 'query', err);
      this.removeSub(st, sub.subId);
      this.send(st, ['CLOSED', sub.subId, reason('error', 'could not load events')]);
      return;
    }
    if (sub.abort.signal.aborted || st.closed) return;
    const now = this.kernel.ports.clock.now();
    const sent = new Set<string>();
    for (const e of events) {
      const exp = expirationOf(e);
      if (exp !== undefined && exp <= now) continue;
      let visible = this.visibleTo(st, e);
      if (visible instanceof Promise) {
        visible = await visible;
        if (sub.abort.signal.aborted || st.closed) return;
      }
      if (!visible) continue;
      st.conn.send(`["EVENT",${sub.subIdJson},${JSON.stringify(e)}]`);
      sent.add(e.id);
    }
    st.conn.send(`["EOSE",${sub.subIdJson}]`);
    const pending = sub.pending ?? [];
    sub.pending = null;
    for (const e of pending) if (!sent.has(e.id)) this.deliver(sub, e, JSON.stringify(e), null);
    if (st.conn.bufferedAmount() > this.cfg.backpressure.closeAboveBytes) {
      this.hasRoom(st);
    }
    this.kernel.bus.emit('req.served', {
      relayId: st.relayId,
      connId: st.conn.id,
      filters: sub.filters.length,
      results: sent.size,
      latencyMs: Math.max(0, this.kernel.ports.clock.nowMs() - start),
    });
  }

  private async onCount(st: ConnState, subId: string, rawFilters: unknown[]): Promise<void> {
    const closed = (why: string) => this.send(st, ['CLOSED', subId, why]);
    const prepared = await this.prepareRead(st, rawFilters, closed);
    if (!prepared) return;
    const store = this.kernel.ports.events;
    const body: { count: number; approximate?: boolean } = { count: 0 };
    if (prepared.filters.length > 0) {
      if (await this.countNeedsScan(st.relayId, prepared.filters)) {
        const r = await this.scanCount(st, prepared.filters);
        if (r === null) return;
        body.count = r.count;
        if (r.capped) body.approximate = true;
      } else {
        body.count = await store.count(st.relayId, prepared.filters);
        if (!store.capabilities.exactCount) body.approximate = true;
      }
    } else if (!store.capabilities.exactCount) body.approximate = true;
    if (st.closed) return;
    this.send(st, ['COUNT', subId, body]);
  }

  /** Could an aggregate count include events this reader may not see? */
  private async countNeedsScan(relayId: RelayId, filters: Filter[]): Promise<boolean> {
    for (const ext of this.extensions) {
      if (!ext.restrictsCount) continue;
      if (await ext.restrictsCount(relayId, filters)) return true;
    }
    return false;
  }

  /**
   * Privacy-preserving COUNT: count matching events one by one with the same
   * expiration and audience checks as REQ. Bounded by `countScanLimit`.
   */
  private async scanCount(
    st: ConnState,
    filters: Filter[],
  ): Promise<{ count: number; capped: boolean } | null> {
    const cap = this.cfg.countScanLimit;
    const events = await this.kernel.ports.events.query(
      st.relayId,
      // Like EventStore.count, `limit` does not bound a count.
      filters.map((f) => ({ ...f, limit: cap })),
      { maxLimit: cap },
    );
    const now = this.kernel.ports.clock.now();
    let count = 0;
    for (const e of events) {
      const exp = expirationOf(e);
      if (exp !== undefined && exp <= now) continue;
      let visible = this.visibleTo(st, e);
      if (visible instanceof Promise) visible = await visible;
      if (st.closed) return null;
      if (visible) count++;
    }
    return { count, capped: events.length >= cap };
  }

  // ───────────────────────── AUTH (NIP-42) ─────────────────────────

  private async onAuth(st: ConnState, input: unknown): Promise<void> {
    const rawId =
      typeof input === 'object' &&
      input !== null &&
      typeof (input as { id?: unknown }).id === 'string'
        ? ((input as { id: string }).id as string)
        : '';
    const shape = validateEventShape(input);
    if (!shape.ok) {
      this.ok(st, rawId, false, shape.reason);
      return;
    }
    const event = shape.event;
    const relay = this.kernel.relay(st.relayId);
    const fail = (prefix: ReasonPrefix, msg: string) =>
      this.ok(st, event.id, false, reason(prefix, msg));
    if (!relay) return fail('error', 'unknown relay');
    if (event.kind !== AUTH_KIND) return fail('invalid', `sign-in event must be kind ${AUTH_KIND}`);
    if (!verifyEventId(event) || !verifyEventSig(event)) return fail('invalid', 'bad signature');
    const now = this.kernel.ports.clock.now();
    if (Math.abs(event.created_at - now) > this.cfg.authWindowSeconds)
      return fail('invalid', 'sign-in event is too old or too far in the future');
    const challenge = tagValues(event, 'challenge')[0];
    if (!st.conn.challenge || challenge !== st.conn.challenge)
      return fail('invalid', 'challenge does not match');
    const relayTag = tagValues(event, 'relay')[0];
    if (!relayTag || !relayUrlMatches(relay, relayTag, st.conn.host))
      return fail('invalid', 'sign-in event is for a different relay');
    const d = await this.kernel.policy.run('onAuth', [event.pubkey, this.ctx(st)]);
    if (d.action === 'reject') return fail(d.prefix, d.message);
    st.conn.authed.add(event.pubkey);
    this.ok(st, event.id, true, '');
    this.kernel.bus.emit('auth.success', {
      relayId: st.relayId,
      connId: st.conn.id,
      pubkey: event.pubkey,
    });
  }

  // ───────────────────────── NEG (NIP-77) ─────────────────────────

  private closeNeg(st: ConnState, subId: string): void {
    const had = st.negFilters.delete(subId);
    st.negs.delete(subId);
    if (had) this.persist(st);
  }

  /** Build the reconciliation set for a sync session, or an error reason. */
  private async negStorage(
    st: ConnState,
    filters: Filter[],
  ): Promise<NegentropyStorageVector | string> {
    const neg = this.cfg.negentropy;
    const events =
      filters.length === 0
        ? []
        : await this.kernel.ports.events.query(st.relayId, filters, {
            maxLimit: neg.maxRecords + 1,
          });
    if (events.length > neg.maxRecords) return reason('blocked', 'too many records');
    const now = this.kernel.ports.clock.now();
    const storage = new NegentropyStorageVector();
    for (const e of events) {
      const exp = expirationOf(e);
      if (exp !== undefined && exp <= now) continue;
      let visible = this.visibleTo(st, e);
      if (visible instanceof Promise) visible = await visible;
      if (!visible) continue;
      storage.insert(e.created_at, e.id);
    }
    storage.seal();
    return storage;
  }

  private async onNegOpen(
    st: ConnState,
    subId: string,
    rawFilter: unknown,
    initial: unknown,
  ): Promise<void> {
    const negErr = (why: string) => this.send(st, ['NEG-ERR', subId, why]);
    const neg = this.cfg.negentropy;
    if (!neg.enabled) return negErr(reason('blocked', 'sync is disabled on this relay'));
    if (typeof initial !== 'string')
      return negErr(reason('invalid', 'initial message must be hex'));
    this.closeNeg(st, subId);
    if (st.negFilters.size >= neg.maxSessions)
      return negErr(reason('blocked', `too many sync sessions (max ${neg.maxSessions})`));
    const prepared = await this.prepareRead(st, [rawFilter], negErr);
    if (!prepared) return;
    const orig = (rawFilter as Filter).limit;
    const filters = prepared.filters.map(({ limit: _l, ...rest }) => {
      return (orig !== undefined ? { ...rest, limit: orig } : rest) as Filter;
    });
    const storage = await this.negStorage(st, filters);
    if (typeof storage === 'string') return negErr(storage);
    const session = new Negentropy(storage, neg.frameSizeLimit);
    let out: string | null;
    try {
      [out] = await session.reconcile(initial);
    } catch (err) {
      return negErr(reason('invalid', err instanceof Error ? err.message : String(err)));
    }
    st.negs.set(subId, session);
    st.negFilters.set(subId, filters);
    this.persist(st);
    this.send(st, ['NEG-MSG', subId, out ?? '']);
  }

  private async onNegMsg(st: ConnState, subId: string, message: unknown): Promise<void> {
    const negErr = (why: string) => this.send(st, ['NEG-ERR', subId, why]);
    let session = st.negs.get(subId);
    if (!session) {
      // The responder side is stateless between messages, so a session that
      // survived hibernation is rebuilt from its persisted filter.
      const filters = st.negFilters.get(subId);
      if (!filters || !this.cfg.negentropy.enabled) return negErr('closed: unknown sync session');
      const storage = await this.negStorage(st, filters);
      if (typeof storage === 'string') {
        this.closeNeg(st, subId);
        return negErr(storage);
      }
      session = new Negentropy(storage, this.cfg.negentropy.frameSizeLimit);
      st.negs.set(subId, session);
    }
    if (typeof message !== 'string') return negErr(reason('invalid', 'message must be hex'));
    try {
      const [out] = await session.reconcile(message);
      this.send(st, ['NEG-MSG', subId, out ?? '']);
    } catch (err) {
      this.closeNeg(st, subId);
      negErr(reason('invalid', err instanceof Error ? err.message : String(err)));
    }
  }
}
