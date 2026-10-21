// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Event store whose writes run on a dedicated SQLite writer thread (opt-in).
 *
 * Reads (`query`, `count`, `getById`, `stats`) use the main thread's connection;
 * every write (`save`, deletions, vanish, retention) is sent to
 * `sqlite-writer-worker.ts`, which owns a second connection to the same file.
 * Saves queued within `windowMs` travel as one message and commit as one
 * transaction. A save resolves after its transaction committed, so a read that
 * starts after that sees it (WAL). Writes keep their order: they are sent, and
 * applied, in the order they were called.
 *
 * Bun only: uses `Worker`. The database must already be migrated.
 */
import type {
  EventStore,
  Filter,
  Logger,
  NostrEvent,
  QueryOptions,
  RelayId,
  SaveResult,
  StoreStats,
} from '@beamhop/core';

export type WriterOp =
  | { op: 'save'; relayId: RelayId; event: NostrEvent }
  | { op: 'applyDeletion'; relayId: RelayId; event: NostrEvent }
  | { op: 'vanish'; relayId: RelayId; pubkey: string; until: number }
  | { op: 'deleteByIds'; relayId: RelayId; ids: string[]; opts?: { tombstone?: boolean } }
  | { op: 'deleteMatching'; relayId: RelayId; filter: Filter }
  | { op: 'deleteExpired'; now: number };

export type WriterRequest =
  | { type: 'open'; seq: number; path: string; pragmas?: Record<string, string | number> }
  | { type: 'ops'; seq: number; ops: WriterOp[] }
  | { type: 'close'; seq: number };

export type WriterReply =
  | { type: 'opened'; seq: number; error?: string }
  | { type: 'done'; seq: number; results: Array<{ ok?: unknown; error?: string }>; error?: string }
  | { type: 'closed'; seq: number };

/** Worker script next to this file when run from source; the compiled binary overrides it. */
export const DEFAULT_WRITER_WORKER_URL = new URL('./sqlite-writer-worker.ts', import.meta.url).href;
let writerWorkerUrl = DEFAULT_WRITER_WORKER_URL;
/** The single binary embeds the worker as an extra entrypoint and calls this. */
export function setSqliteWriterWorkerUrl(url: string): void {
  writerWorkerUrl = url;
}

export interface WorkerEventStoreOptions {
  /** Database file (already migrated). */
  path: string;
  /** Main-thread store used for reads. */
  reader: EventStore;
  /** Collect saves for this long before sending them (0 = end of the current tick). Default 2. */
  windowMs?: number;
  /** Send at once when this many saves are waiting. Default 512. */
  maxBatch?: number;
  pragmas?: Record<string, string | number>;
  logger?: Logger;
  /** Worker script URL (tests). */
  workerUrl?: string;
}

interface Waiting {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class WorkerEventStore implements EventStore {
  readonly capabilities: EventStore['capabilities'];
  private worker: Worker | null = null;
  private seq = 0;
  private readonly inflight = new Map<number, (r: WriterReply) => void>();
  private queue: Array<{ op: WriterOp; w: Waiting }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduled = false;
  private opened: Promise<void> | null = null;
  private failed: Error | null = null;
  private readonly windowMs: number;
  private readonly maxBatch: number;

  constructor(private readonly opts: WorkerEventStoreOptions) {
    this.capabilities = opts.reader.capabilities;
    this.windowMs = Math.max(0, opts.windowMs ?? 2);
    this.maxBatch = Math.max(1, opts.maxBatch ?? 512);
  }

  init(): Promise<void> {
    this.opened ??= this.open();
    return this.opened;
  }

  private async open(): Promise<void> {
    await this.opts.reader.init();
    const worker = new Worker(this.opts.workerUrl ?? writerWorkerUrl);
    this.worker = worker;
    worker.addEventListener('message', (e: MessageEvent<WriterReply>) => {
      const cb = this.inflight.get(e.data.seq);
      if (!cb) return;
      this.inflight.delete(e.data.seq);
      cb(e.data);
    });
    worker.addEventListener('error', (e) => {
      this.fail(new Error((e as ErrorEvent).message || 'database writer thread failed'));
    });
    worker.addEventListener('close', () => {
      if (!this.closing) this.fail(new Error('database writer thread exited'));
    });
    const reply = await this.request({
      type: 'open',
      seq: 0,
      path: this.opts.path,
      ...(this.opts.pragmas ? { pragmas: this.opts.pragmas } : {}),
    });
    if (reply.type === 'opened' && reply.error) throw new Error(reply.error);
  }

  private closing = false;

  /** Writer thread is gone: refuse queued and later writes (never silently drop them). */
  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    this.opts.logger?.log('error', 'database writer thread failed', { err: err.message });
    for (const cb of this.inflight.values())
      cb({ type: 'done', seq: -1, results: [], error: err.message });
    this.inflight.clear();
    const q = this.queue;
    this.queue = [];
    for (const { w } of q) w.reject(err);
  }

  private request(m: WriterRequest): Promise<WriterReply> {
    if (this.failed) return Promise.reject(this.failed);
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('database writer is not open'));
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.inflight.set(seq, resolve);
      worker.postMessage({ ...m, seq });
    });
  }

  /** Queue a write; saves wait for the window, anything else sends the queue now. */
  private write<T>(op: WriterOp): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ op, w: { resolve: resolve as (v: unknown) => void, reject } });
      if (op.op !== 'save' || this.queue.length >= this.maxBatch) this.flush();
      else if (!this.scheduled) {
        this.scheduled = true;
        if (this.windowMs > 0) this.timer = setTimeout(() => this.flush(), this.windowMs);
        else queueMicrotask(() => this.flush());
      }
    });
  }

  /** Send queued writes now. */
  flush(): void {
    this.scheduled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const sent = this.opened
      ? this.opened.then(() => this.request({ type: 'ops', seq: 0, ops: batch.map((b) => b.op) }))
      : Promise.reject(new Error('database writer is not open'));
    sent.then(
      (reply) => {
        if (reply.type !== 'done') return;
        batch.forEach((b, i) => {
          const r = reply.results[i];
          if (!r) b.w.reject(new Error(reply.error ?? 'database write failed'));
          else if (r.error !== undefined) b.w.reject(new Error(r.error));
          else b.w.resolve(r.ok);
        });
      },
      (err) => {
        for (const b of batch) b.w.reject(err);
      },
    );
  }

  save(relayId: RelayId, event: NostrEvent): Promise<SaveResult> {
    return this.write({ op: 'save', relayId, event });
  }
  applyDeletion(relayId: RelayId, deletion: NostrEvent): Promise<string[]> {
    return this.write({ op: 'applyDeletion', relayId, event: deletion });
  }
  vanish(relayId: RelayId, pubkey: string, until: number): Promise<number> {
    return this.write({ op: 'vanish', relayId, pubkey, until });
  }
  deleteByIds(relayId: RelayId, ids: string[], opts?: { tombstone?: boolean }): Promise<number> {
    return this.write({ op: 'deleteByIds', relayId, ids, ...(opts ? { opts } : {}) });
  }
  deleteMatching(relayId: RelayId, filter: Filter): Promise<number> {
    return this.write({ op: 'deleteMatching', relayId, filter });
  }
  deleteExpired(now: number): Promise<number> {
    return this.write({ op: 'deleteExpired', now });
  }

  query(relayId: RelayId, filters: Filter[], opts?: QueryOptions): Promise<NostrEvent[]> {
    return this.opts.reader.query(relayId, filters, opts);
  }
  count(relayId: RelayId, filters: Filter[]): Promise<number> {
    return this.opts.reader.count(relayId, filters);
  }
  getById(relayId: RelayId, id: string): Promise<NostrEvent | null> {
    return this.opts.reader.getById(relayId, id);
  }
  async stats(relayId?: RelayId): Promise<StoreStats> {
    await this.drain();
    return this.opts.reader.stats(relayId);
  }

  /** Wait until every write issued so far has been applied. */
  private async drain(): Promise<void> {
    if (this.failed || !this.worker) return;
    this.flush();
    if (this.inflight.size === 0) return;
    await this.request({ type: 'ops', seq: 0, ops: [] });
  }

  /** Stop the writer thread (after applying queued writes); the reader stays open. */
  async stopWriter(): Promise<void> {
    if (!this.worker) return;
    await this.drain().catch(() => {});
    this.closing = true;
    if (!this.failed) {
      await Promise.race([
        this.request({ type: 'close', seq: 0 }),
        new Promise((r) => setTimeout(r, 5000)),
      ]).catch(() => {});
    }
    this.worker.terminate();
    this.worker = null;
  }

  async close(): Promise<void> {
    await this.stopWriter();
    await this.opts.reader.close();
  }
}
