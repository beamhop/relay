// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The relay engine: NIP-01 protocol over the runtime-neutral `Connection`,
 * live fan-out through an inverted subscription index, cross-node fan-out
 * through `ports.pubsub`, and the NIP handlers (09, 13, 40, 42, 45, 50, 62, 70, 77).
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
  readonly negs: Map<string, Negentropy>;
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
export function relayUrlMatches(relay: RelayConfig, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return relay.hosts.some((h) => h === '*' || h.toLowerCase().replace(/:\d+$/, '') === host);
}

const noop = () => {};
/** Key in `Connection.state` marking a connection the engine has torn down. */
const CLOSED_KEY = 'relay.closed';
type Detached = { detached?: Promise<void> };

export class RelayEngine implements ConnectionHandler {
  readonly nodeId: string;
  private conns = new Map<string, ConnState>();
  private relays = new Map<RelayId, RelayRuntime>();
  private cfg: RelayModuleConfig;
  private offConfig: () => void;

  constructor(private kernel: Kernel) {
    this.nodeId = kernel.ports.crypto.randomHex(8);
    this.cfg = RelayModuleConfigSchema.parse(kernel.config().modules[RELAY_MODULE_ID] ?? {});
    this.offConfig = kernel.onConfigChange((next) => {
      this.cfg = RelayModuleConfigSchema.parse(next.modules[RELAY_MODULE_ID] ?? {});
    });
  }

  config(): RelayModuleConfig {
    return this.cfg;
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

  /** Open a connection; resolves when the connect policy has run. */
  open(conn: Connection): Promise<void> {
    const existing = this.conns.get(conn.id);
    if (existing) return existing.chain;
    conn.state.delete(CLOSED_KEY);
    const st: ConnState = {
      conn,
      relayId: conn.relayId,
      subs: new Map(),
      negs: new Map(),
      tiers: new Map(),
      chain: Promise.resolve(),
      pending: 0,
      opened: false,
      closed: false,
      dropping: false,
      dropped: 0,
    };
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
      void this.open(conn);
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
    this.runtime(st.relayId);
    this.kernel.bus.emit('conn.open', {
      relayId: st.relayId,
      connId: conn.id,
      ipHash: conn.ipHash,
      ...(conn.userAgent !== undefined ? { userAgent: conn.userAgent } : {}),
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
    this.fanout(rt, shape.event);
  }

  /** Publish an accepted event to local subscribers and other nodes. */
  broadcast(relayId: RelayId, event: NostrEvent, json?: string): void {
    const rt = this.runtime(relayId);
    rt.seen.add(event.id);
    this.fanout(rt, event, json);
    const message: FanoutMessage = { o: this.nodeId, e: event };
    this.kernel.ports.pubsub
      .publish(fanoutChannel(relayId), message)
      .catch((err) => this.fail(null, 'pubsub', err));
  }

  private fanout(rt: RelayRuntime, event: NostrEvent, json?: string): void {
    const subs = rt.index.match(event);
    if (subs.length === 0) return;
    const body = json ?? JSON.stringify(event);
    for (const sub of subs) this.deliver(sub, event, body);
  }

  private deliver(sub: Subscription, event: NostrEvent, json: string): void {
    const st = sub.conn;
    if (st.closed) return;
    if (sub.pending) {
      sub.pending.push(event);
      return;
    }
    if (!this.hasRoom(st)) return;
    st.conn.send(`["EVENT",${sub.subIdJson},${json}]`);
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
        st.negs.delete(msg[1]);
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
      this.accepted(st, event, json, start);
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
      const ids = await store.applyDeletion(st.relayId, event);
      if (ids.length > 0)
        this.kernel.bus.emit('event.deleted', { relayId: st.relayId, ids, cause: 'nip09' });
    }
    if (event.kind === REPORT_KIND)
      this.kernel.bus.emit('report.received', { relayId: st.relayId, report: event });
    this.accepted(st, event, json, start);
  }

  private accepted(st: ConnState, event: NostrEvent, json: string, start: number): void {
    this.broadcast(st.relayId, event, json);
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
    const forUs = targets.some((u) => u === 'ALL_RELAYS' || relayUrlMatches(relay, u));
    if (!forUs) {
      this.rejectEvent(st, event, 'invalid', 'this request to vanish names a different relay');
      return;
    }
    await this.kernel.ports.events.vanish(st.relayId, event.pubkey, event.created_at);
    this.runtime(st.relayId).seen.add(event.id);
    this.ok(st, event.id, true, '');
    this.kernel.bus.emit('event.deleted', { relayId: st.relayId, ids: [], cause: 'nip62' });
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
    const d = await this.kernel.policy.run('onReq', [filters, this.ctx(st, tier)]);
    if (d.action === 'reject') {
      fail(reason(d.prefix, d.message));
      return null;
    }
    if (d.action !== 'accept') {
      // shadow/hold on reads: serve nothing, silently.
      return { filters: [], maxLimit: limits.maxLimit };
    }
    return { filters, maxLimit: limits.maxLimit };
  }

  private removeSub(st: ConnState, subId: string): void {
    const sub = st.subs.get(subId);
    if (!sub) return;
    sub.abort.abort();
    st.subs.delete(subId);
    this.relays.get(st.relayId)?.index.remove(sub.key);
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
    const sub: Subscription = {
      key: `${st.conn.id}\u0000${subId}`,
      subId,
      subIdJson: JSON.stringify(subId),
      filters: prepared.filters,
      conn: st,
      abort: new AbortController(),
      pending: [],
    };
    st.subs.set(subId, sub);
    this.runtime(st.relayId).index.add(sub);
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
      st.conn.send(`["EVENT",${sub.subIdJson},${JSON.stringify(e)}]`);
      sent.add(e.id);
    }
    st.conn.send(`["EOSE",${sub.subIdJson}]`);
    const pending = sub.pending ?? [];
    sub.pending = null;
    for (const e of pending) if (!sent.has(e.id)) this.deliver(sub, e, JSON.stringify(e));
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
    const count =
      prepared.filters.length === 0 ? 0 : await store.count(st.relayId, prepared.filters);
    const body: { count: number; approximate?: boolean } = { count };
    if (!store.capabilities.exactCount) body.approximate = true;
    this.send(st, ['COUNT', subId, body]);
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
    if (!relayTag || !relayUrlMatches(relay, relayTag))
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
    st.negs.delete(subId);
    if (st.negs.size >= neg.maxSessions)
      return negErr(reason('blocked', `too many sync sessions (max ${neg.maxSessions})`));
    const prepared = await this.prepareRead(st, [rawFilter], negErr);
    if (!prepared) return;
    const filters = prepared.filters.map(({ limit: _l, ...rest }) => {
      const orig = (rawFilter as Filter).limit;
      return (orig !== undefined ? { ...rest, limit: orig } : rest) as Filter;
    });
    const events =
      filters.length === 0
        ? []
        : await this.kernel.ports.events.query(st.relayId, filters, {
            maxLimit: neg.maxRecords + 1,
          });
    if (events.length > neg.maxRecords) return negErr(reason('blocked', 'too many records'));
    const now = this.kernel.ports.clock.now();
    const storage = new NegentropyStorageVector();
    for (const e of events) {
      const exp = expirationOf(e);
      if (exp !== undefined && exp <= now) continue;
      storage.insert(e.created_at, e.id);
    }
    storage.seal();
    const session = new Negentropy(storage, neg.frameSizeLimit);
    let out: string | null;
    try {
      [out] = await session.reconcile(initial);
    } catch (err) {
      return negErr(reason('invalid', err instanceof Error ? err.message : String(err)));
    }
    st.negs.set(subId, session);
    this.send(st, ['NEG-MSG', subId, out ?? '']);
  }

  private async onNegMsg(st: ConnState, subId: string, message: unknown): Promise<void> {
    const negErr = (why: string) => this.send(st, ['NEG-ERR', subId, why]);
    const session = st.negs.get(subId);
    if (!session) return negErr('closed: unknown sync session');
    if (typeof message !== 'string') return negErr(reason('invalid', 'message must be hex'));
    try {
      const [out] = await session.reconcile(message);
      this.send(st, ['NEG-MSG', subId, out ?? '']);
    } catch (err) {
      st.negs.delete(subId);
      negErr(reason('invalid', err instanceof Error ? err.message : String(err)));
    }
  }
}
