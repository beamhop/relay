// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory reference adapters. They define the expected semantics of every
 * port and are used by unit tests of feature modules. Real adapters must pass
 * the same contract suites (see ./contracts).
 */
import {
  type BlobBody,
  type BlobIndex,
  type BlobMeta,
  type BlobOwnership,
  type BlobStore,
  type ByteRange,
  type Clock,
  type Crypto,
  type DocStore,
  type EventStore,
  type Filter,
  type LogLevel,
  type Logger,
  type MetricPoint,
  type NostrEvent,
  type Ports,
  type PubSub,
  type RelayId,
  type SaveResult,
  type Scheduler,
  type StoreStats,
  type TimeSeriesStore,
  addressOf,
  expirationOf,
  isNewer,
  kindClass,
  matchFilter,
  tagValues,
} from '@beamhop/core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

export function sortEvents(a: NostrEvent, b: NostrEvent): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function searchMatches(search: string, e: NostrEvent): boolean {
  const terms = search
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !t.includes(':'));
  const hay = e.content.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

interface RelayData {
  byId: Map<string, NostrEvent>;
  byAddress: Map<string, NostrEvent>;
  /** Deleted event ids → deleter pubkey. */
  tombIds: Map<string, string>;
  /** Deleted address → deleted-up-to created_at. */
  tombAddr: Map<string, number>;
  /** Vanished pubkey → until. */
  vanished: Map<string, number>;
}

export class MemoryEventStore implements EventStore {
  readonly capabilities = { search: true, exactCount: true };
  private relays = new Map<RelayId, RelayData>();

  async init(): Promise<void> {}

  private data(relayId: RelayId): RelayData {
    let d = this.relays.get(relayId);
    if (!d) {
      d = {
        byId: new Map(),
        byAddress: new Map(),
        tombIds: new Map(),
        tombAddr: new Map(),
        vanished: new Map(),
      };
      this.relays.set(relayId, d);
    }
    return d;
  }

  async save(relayId: RelayId, event: NostrEvent): Promise<SaveResult> {
    const d = this.data(relayId);
    if (d.byId.has(event.id)) return { status: 'duplicate' };
    if (d.tombIds.get(event.id) === event.pubkey) return { status: 'deleted' };
    const vanishedUntil = d.vanished.get(event.pubkey);
    if (vanishedUntil !== undefined && event.created_at <= vanishedUntil)
      return { status: 'deleted' };
    const addr = addressOf(event);
    if (addr) {
      const deletedUpTo = d.tombAddr.get(addr);
      if (deletedUpTo !== undefined && event.created_at <= deletedUpTo)
        return { status: 'deleted' };
      const existing = d.byAddress.get(addr);
      if (existing) {
        if (!isNewer(event, existing)) return { status: 'superseded' };
        d.byId.delete(existing.id);
        d.byAddress.set(addr, event);
        d.byId.set(event.id, event);
        return { status: 'saved', replaced: [existing.id] };
      }
      d.byAddress.set(addr, event);
    }
    d.byId.set(event.id, event);
    return { status: 'saved' };
  }

  async query(
    relayId: RelayId,
    filters: Filter[],
    opts?: { maxLimit?: number },
  ): Promise<NostrEvent[]> {
    const d = this.data(relayId);
    const all = [...d.byId.values()].sort(sortEvents);
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      let limit = f.limit ?? Number.POSITIVE_INFINITY;
      if (opts?.maxLimit !== undefined) limit = Math.min(limit, opts.maxLimit);
      let n = 0;
      for (const e of all) {
        if (n >= limit) break;
        if (!matchFilter(f, e)) continue;
        if (f.search && !searchMatches(f.search, e)) continue;
        out.set(e.id, e);
        n++;
      }
    }
    return [...out.values()].sort(sortEvents);
  }

  async count(relayId: RelayId, filters: Filter[]): Promise<number> {
    const stripped = filters.map(({ limit: _l, ...rest }) => rest as Filter);
    return (await this.query(relayId, stripped)).length;
  }

  async getById(relayId: RelayId, id: string): Promise<NostrEvent | null> {
    return this.data(relayId).byId.get(id) ?? null;
  }

  async applyDeletion(relayId: RelayId, deletion: NostrEvent): Promise<string[]> {
    const d = this.data(relayId);
    const deleted: string[] = [];
    for (const id of tagValues(deletion, 'e')) {
      const e = d.byId.get(id);
      if (e && e.pubkey !== deletion.pubkey) continue;
      if (e && e.kind === 5) continue;
      d.tombIds.set(id, deletion.pubkey);
      if (e) {
        d.byId.delete(id);
        const addr = addressOf(e);
        if (addr && d.byAddress.get(addr)?.id === id) d.byAddress.delete(addr);
        deleted.push(id);
      }
    }
    for (const a of tagValues(deletion, 'a')) {
      const [, pk] = a.split(':');
      if (pk !== deletion.pubkey) continue;
      const prev = d.tombAddr.get(a) ?? 0;
      d.tombAddr.set(a, Math.max(prev, deletion.created_at));
      const e = d.byAddress.get(a);
      if (e && e.created_at <= deletion.created_at) {
        d.byAddress.delete(a);
        d.byId.delete(e.id);
        deleted.push(e.id);
      }
    }
    return deleted;
  }

  async vanish(relayId: RelayId, pubkey: string, until: number): Promise<number> {
    const d = this.data(relayId);
    d.vanished.set(pubkey, Math.max(d.vanished.get(pubkey) ?? 0, until));
    let n = 0;
    for (const e of [...d.byId.values()]) {
      if (e.pubkey === pubkey && e.created_at <= until) {
        d.byId.delete(e.id);
        const addr = addressOf(e);
        if (addr && d.byAddress.get(addr)?.id === e.id) d.byAddress.delete(addr);
        n++;
      }
    }
    return n;
  }

  async deleteByIds(
    relayId: RelayId,
    ids: string[],
    opts?: { tombstone?: boolean },
  ): Promise<number> {
    const d = this.data(relayId);
    let n = 0;
    for (const id of ids) {
      const e = d.byId.get(id);
      if (!e) continue;
      d.byId.delete(id);
      const addr = addressOf(e);
      if (addr && d.byAddress.get(addr)?.id === id) d.byAddress.delete(addr);
      if (opts?.tombstone) d.tombIds.set(id, e.pubkey);
      n++;
    }
    return n;
  }

  async deleteMatching(relayId: RelayId, filter: Filter): Promise<number> {
    const { limit: _l, ...f } = filter;
    const ids = (await this.query(relayId, [f as Filter])).map((e) => e.id);
    return this.deleteByIds(relayId, ids);
  }

  async deleteExpired(now: number): Promise<number> {
    let n = 0;
    for (const [relayId, d] of this.relays) {
      const ids = [...d.byId.values()]
        .filter((e) => {
          const exp = expirationOf(e);
          return exp !== undefined && exp <= now;
        })
        .map((e) => e.id);
      n += await this.deleteByIds(relayId, ids);
    }
    return n;
  }

  async stats(relayId?: RelayId): Promise<StoreStats> {
    const list = relayId ? [this.data(relayId)] : [...this.relays.values()];
    let events = 0;
    let bytes = 0;
    let oldest: number | undefined;
    let newest: number | undefined;
    for (const d of list) {
      for (const e of d.byId.values()) {
        events++;
        bytes += JSON.stringify(e).length;
        oldest = oldest === undefined ? e.created_at : Math.min(oldest, e.created_at);
        newest = newest === undefined ? e.created_at : Math.max(newest, e.created_at);
      }
    }
    return { events, bytes, oldest, newest };
  }

  async close(): Promise<void> {}
}

async function collect(data: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  const chunks: Uint8Array[] = [];
  const reader = data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export { collect as collectStream };

export class MemoryBlobStore implements BlobStore {
  readonly kind = 'memory';
  private blobs = new Map<string, { meta: BlobMeta; data: Uint8Array }>();
  async init(): Promise<void> {}
  async put(meta: BlobMeta, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    if (this.blobs.has(meta.sha256)) return;
    this.blobs.set(meta.sha256, { meta, data: await collect(data) });
  }
  async get(hash: string, range?: ByteRange): Promise<BlobBody | null> {
    const b = this.blobs.get(hash);
    if (!b) return null;
    const bytes = range ? b.data.slice(range.start, range.end + 1) : b.data;
    return {
      ...b.meta,
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  }
  async head(hash: string): Promise<BlobMeta | null> {
    return this.blobs.get(hash)?.meta ?? null;
  }
  async delete(hash: string): Promise<boolean> {
    return this.blobs.delete(hash);
  }
  async list(opts?: { cursor?: string; limit?: number }) {
    const keys = [...this.blobs.keys()].sort().filter((k) => !opts?.cursor || k > opts.cursor);
    const limit = opts?.limit ?? 100;
    const page = keys.slice(0, limit);
    return {
      items: page.map((k) => this.blobs.get(k)!.meta),
      cursor: keys.length > limit ? page[page.length - 1] : undefined,
    };
  }
}

export class MemoryBlobIndex implements BlobIndex {
  private rows: BlobOwnership[] = [];
  async init(): Promise<void> {}
  async addOwner(o: BlobOwnership): Promise<void> {
    const i = this.rows.findIndex(
      (r) => r.relayId === o.relayId && r.sha256 === o.sha256 && r.pubkey === o.pubkey,
    );
    if (i >= 0) this.rows[i] = o;
    else this.rows.push(o);
  }
  async removeOwner(relayId: RelayId, hash: string, pubkey: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(r.relayId === relayId && r.sha256 === hash && r.pubkey === pubkey),
    );
    return this.rows.length < before;
  }
  async owners(relayId: RelayId, hash: string) {
    return this.rows.filter((r) => r.relayId === relayId && r.sha256 === hash);
  }
  async listByOwner(
    relayId: RelayId,
    pubkey: string,
    opts?: { since?: number; until?: number; limit?: number },
  ) {
    return this.rows
      .filter(
        (r) =>
          r.relayId === relayId &&
          r.pubkey === pubkey &&
          (opts?.since === undefined || r.uploadedAt >= opts.since) &&
          (opts?.until === undefined || r.uploadedAt <= opts.until),
      )
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
      .slice(0, opts?.limit ?? 1000);
  }
  async list(relayId: RelayId, opts?: { cursor?: string; limit?: number }) {
    const rows = this.rows
      .filter((r) => r.relayId === relayId)
      .sort((a, b) => (a.sha256 + a.pubkey).localeCompare(b.sha256 + b.pubkey))
      .filter((r) => !opts?.cursor || r.sha256 + r.pubkey > opts.cursor);
    const limit = opts?.limit ?? 100;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      cursor: rows.length > limit && last ? last.sha256 + last.pubkey : undefined,
    };
  }
  async usage(relayId: RelayId, pubkey: string) {
    return this.rows
      .filter((r) => r.relayId === relayId && r.pubkey === pubkey)
      .reduce((n, r) => n + r.size, 0);
  }
  async refCount(hash: string) {
    return this.rows.filter((r) => r.sha256 === hash).length;
  }
  async expired(now: number, limit: number) {
    return this.rows.filter((r) => r.expiresAt !== undefined && r.expiresAt <= now).slice(0, limit);
  }
}

export class MemoryDocStore implements DocStore {
  private cols = new Map<string, Map<string, string>>();
  async init(): Promise<void> {}
  private col(name: string) {
    let c = this.cols.get(name);
    if (!c) {
      c = new Map();
      this.cols.set(name, c);
    }
    return c;
  }
  async get<T>(collection: string, key: string): Promise<T | null> {
    const v = this.col(collection).get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async put<T>(collection: string, key: string, value: T): Promise<void> {
    this.col(collection).set(key, JSON.stringify(value));
  }
  async delete(collection: string, key: string): Promise<boolean> {
    return this.col(collection).delete(key);
  }
  async list<T>(
    collection: string,
    opts?: { prefix?: string; cursor?: string; limit?: number; reverse?: boolean },
  ) {
    let keys = [...this.col(collection).keys()]
      .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
      .sort();
    if (opts?.reverse) keys.reverse();
    if (opts?.cursor)
      keys = keys.filter((k) => (opts.reverse ? k < opts.cursor! : k > opts.cursor!));
    const limit = opts?.limit ?? 100;
    const page = keys.slice(0, limit);
    return {
      items: page.map((key) => ({ key, value: JSON.parse(this.col(collection).get(key)!) as T })),
      cursor: keys.length > limit ? page[page.length - 1] : undefined,
    };
  }
  async cas<T>(collection: string, key: string, expected: T | null, next: T): Promise<boolean> {
    const cur = this.col(collection).get(key);
    const expectedStr = expected === null ? undefined : JSON.stringify(expected);
    if (cur !== expectedStr) return false;
    this.col(collection).set(key, JSON.stringify(next));
    return true;
  }
}

export class MemoryTimeSeries implements TimeSeriesStore {
  points: MetricPoint[] = [];
  async init(): Promise<void> {}
  async record(points: MetricPoint[]): Promise<void> {
    this.points.push(...points);
  }
  async range(q: Parameters<TimeSeriesStore['range']>[0]) {
    const buckets = new Map<number, number[]>();
    for (const p of this.points) {
      if (p.metric !== q.metric || p.t < q.from || p.t > q.to) continue;
      if (q.labels && Object.entries(q.labels).some(([k, v]) => p.labels[k] !== v)) continue;
      const b = Math.floor(p.t / q.stepSeconds) * q.stepSeconds;
      let arr = buckets.get(b);
      if (!arr) {
        arr = [];
        buckets.set(b, arr);
      }
      arr.push(p.v);
    }
    const agg = (vs: number[]) => {
      switch (q.agg) {
        case 'sum':
          return vs.reduce((a, b) => a + b, 0);
        case 'avg':
          return vs.reduce((a, b) => a + b, 0) / vs.length;
        case 'max':
          return Math.max(...vs);
        case 'min':
          return Math.min(...vs);
        case 'last':
          return vs[vs.length - 1] as number;
      }
    };
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, vs]) => ({ t, v: agg(vs) }));
  }
  async prune(before: number): Promise<number> {
    const n = this.points.length;
    this.points = this.points.filter((p) => p.t >= before);
    return n - this.points.length;
  }
}

export class MemoryPubSub implements PubSub {
  private subs = new Map<string, Set<(m: unknown) => void>>();
  async publish(channel: string, message: unknown): Promise<void> {
    for (const h of this.subs.get(channel) ?? []) h(message);
  }
  subscribe(channel: string, handler: (m: unknown) => void): () => void {
    let s = this.subs.get(channel);
    if (!s) {
      s = new Set();
      this.subs.set(channel, s);
    }
    s.add(handler);
    return () => s?.delete(handler);
  }
}

/** Manual scheduler: tests call `tick(name)` or `tickAll()`. */
export class ManualScheduler implements Scheduler {
  jobs = new Map<string, { interval: number; fn: () => Promise<void> }>();
  every(name: string, intervalSeconds: number, fn: () => Promise<void>): void {
    this.jobs.set(name, { interval: intervalSeconds, fn });
  }
  cancel(name: string): void {
    this.jobs.delete(name);
  }
  async tick(name: string): Promise<void> {
    await this.jobs.get(name)?.fn();
  }
  async tickAll(): Promise<void> {
    for (const j of this.jobs.values()) await j.fn();
  }
}

export class FakeClock implements Clock {
  constructor(public ms = 1_700_000_000_000) {}
  now(): number {
    return Math.floor(this.ms / 1000);
  }
  nowMs(): number {
    return this.ms;
  }
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

export class MemoryLogger implements Logger {
  constructor(
    public lines: Array<{ level: LogLevel; msg: string; fields?: Record<string, unknown> }> = [],
    private base: Record<string, unknown> = {},
  ) {}
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    this.lines.push({ level, msg, fields: { ...this.base, ...fields } });
  }
  child(fields: Record<string, unknown>): Logger {
    return new MemoryLogger(this.lines, { ...this.base, ...fields });
  }
}

export const testCrypto: Crypto = {
  async sha256Hex(data) {
    return bytesToHex(sha256(data));
  },
  randomHex(n) {
    return bytesToHex(randomBytes(n));
  },
  hashIp(ip) {
    return bytesToHex(sha256(new TextEncoder().encode(`test-salt:${ip}`))).slice(0, 16);
  },
};

export function memoryPorts(overrides: Partial<Ports> = {}): Ports & {
  clock: FakeClock;
  scheduler: ManualScheduler;
  logger: MemoryLogger;
} {
  return {
    events: new MemoryEventStore(),
    blobs: new MemoryBlobStore(),
    blobIndex: new MemoryBlobIndex(),
    docs: new MemoryDocStore(),
    metrics: new MemoryTimeSeries(),
    pubsub: new MemoryPubSub(),
    scheduler: new ManualScheduler(),
    clock: new FakeClock(),
    logger: new MemoryLogger(),
    crypto: testCrypto,
    ...overrides,
  } as Ports & { clock: FakeClock; scheduler: ManualScheduler; logger: MemoryLogger };
}

export { kindClass };
