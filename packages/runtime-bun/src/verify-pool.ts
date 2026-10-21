// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signature verification worker pool (PLAN §3.5): keeps Schnorr checks off the
 * event loop so 5k ev/s of incoming events do not stall WebSocket I/O.
 *
 * - N Bun Workers (Web `Worker` API), spawned lazily on first use.
 * - Micro-batching: requests are collected into batches of up to `maxBatch`
 *   events; a batch is sent as soon as it is full, else after `maxWaitMs`
 *   (or on the next event-loop turn when a worker is idle). Each worker has at
 *   most `maxInFlight` batches outstanding; when all are busy, events queue
 *   and form larger batches.
 * - Back-pressure: at most `maxQueue` events may wait; beyond that, callers are
 *   verified inline (never dropped, never accepted unchecked).
 * - Crash safety: a worker that errors, exits or stops answering within
 *   `batchTimeoutMs` is replaced; its outstanding events reject with
 *   {@link VerifyUnavailableError} (the relay answers "invalid: could not
 *   verify"), never "valid".
 * - `close()`: verifies what is still queued, waits for in-flight batches
 *   (bounded) and terminates the workers. Later calls run inline.
 */
import {
  type Logger,
  type NostrEvent,
  type SignatureVerifier,
  verifyEventSig,
} from '@beamhop/core';

/** Host → worker: flat `[id, pubkey, sig, …]` triples. */
export interface VerifyRequest {
  seq: number;
  data: string[];
}
/** Worker → host: one byte per event (1 = valid). */
export interface VerifyResponse {
  seq: number;
  ok: Uint8Array;
}

type SigInput = Pick<NostrEvent, 'id' | 'pubkey' | 'sig'>;

/** Worker script next to this file when run from source; the compiled binary overrides it. */
export const DEFAULT_VERIFY_WORKER_URL = new URL('./verify-worker.ts', import.meta.url).href;
let defaultWorkerUrl = DEFAULT_VERIFY_WORKER_URL;

/**
 * Where the verify worker script is. The single binary embeds `verify-worker.ts`
 * as an extra entrypoint and the generated entry calls this with its embedded path.
 */
export function setVerifyWorkerUrl(url: string): void {
  defaultWorkerUrl = url;
}
export function verifyWorkerUrl(): string {
  return defaultWorkerUrl;
}

export class VerifyUnavailableError extends Error {
  constructor(message = 'signature could not be checked') {
    super(message);
    this.name = 'VerifyUnavailableError';
  }
}

/** Default pool size: CPU cores − 1, at least 1. */
export function defaultVerifyWorkers(): number {
  const cores = Number(globalThis.navigator?.hardwareConcurrency) || 2;
  return Math.max(1, cores - 1);
}

export interface VerifyPoolOptions {
  /** Number of worker threads (≥ 1). Default {@link defaultVerifyWorkers}. */
  workers?: number;
  /** Max events per batch (default 64). */
  maxBatch?: number;
  /** Max time a partial batch waits for more events, ms (default 1). */
  maxWaitMs?: number;
  /** Max events waiting for a worker before callers are verified inline (default 8192). */
  maxQueue?: number;
  /** Outstanding batches per worker (default 2: one computing, one ready). */
  maxInFlight?: number;
  /** A batch not answered in this time counts as a worker crash (default 10 s). */
  batchTimeoutMs?: number;
  workerUrl?: string | URL;
  logger?: Logger;
  /** Consecutive crashes (no good answer in between) before giving up and verifying inline (default 5). */
  maxCrashes?: number;
  /** Inline fallback (default `verifyEventSig`). */
  inline?: (e: SigInput) => boolean;
}

export interface VerifyPoolStats {
  workers: number;
  live: number;
  /** True when the threads kept crashing and checks now run on the main thread. */
  broken: boolean;
  queued: number;
  inFlight: number;
  batches: number;
  verified: number;
  inline: number;
  respawns: number;
  failed: number;
}

/** One `verify()` call: answered when all of its events are back. */
interface Req {
  events: readonly SigInput[];
  results: boolean[];
  left: number;
  failed: boolean;
  resolve(r: boolean[]): void;
  reject(err: Error): void;
}

/** A run of consecutive events of one request inside a batch. */
interface Seg {
  req: Req;
  start: number;
  count: number;
}

interface Batch {
  seq: number;
  segs: Seg[];
  count: number;
  timer: ReturnType<typeof setTimeout>;
  settled(): void;
  done: Promise<void>;
}

interface Slot {
  index: number;
  worker: Worker | null;
  inFlight: Map<number, Batch>;
  /** Bumped on respawn so messages from a dead worker are ignored. */
  gen: number;
}

export class VerifyPool implements SignatureVerifier {
  readonly size: number;
  private readonly maxBatch: number;
  private readonly maxWaitMs: number;
  private readonly maxQueue: number;
  private readonly maxInFlight: number;
  private readonly batchTimeoutMs: number;
  private readonly maxCrashes: number;
  private readonly url: string | URL;
  private readonly logger?: Logger;
  private readonly inlineFn: (e: SigInput) => boolean;
  private readonly slots: Slot[];
  /** FIFO of requests; `head`/`offset` mark the next event to send. */
  private queue: Req[] = [];
  private head = 0;
  private offset = 0;
  /** Events waiting for a worker. */
  private queued = 0;
  private seq = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private immediate = false;
  private closed = false;
  /** Crashes since the last good answer; past `maxCrashes` the pool gives up and runs inline. */
  private crashStreak = 0;
  private broken = false;
  private readonly counters = { batches: 0, verified: 0, inline: 0, respawns: 0, failed: 0 };

  constructor(opts: VerifyPoolOptions = {}) {
    this.size = Math.max(1, Math.floor(opts.workers ?? defaultVerifyWorkers()));
    this.maxBatch = Math.max(1, opts.maxBatch ?? 64);
    this.maxWaitMs = Math.max(0, opts.maxWaitMs ?? 1);
    this.maxQueue = Math.max(1, opts.maxQueue ?? 8192);
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? 2);
    this.batchTimeoutMs = opts.batchTimeoutMs ?? 10_000;
    this.maxCrashes = Math.max(1, opts.maxCrashes ?? 5);
    this.url = opts.workerUrl ?? defaultWorkerUrl;
    this.logger = opts.logger;
    // verifyEventSig only reads id, pubkey and sig.
    this.inlineFn = opts.inline ?? (verifyEventSig as (e: SigInput) => boolean);
    this.slots = Array.from({ length: this.size }, (_, index) => ({
      index,
      worker: null,
      inFlight: new Map(),
      gen: 0,
    }));
  }

  verify(events: readonly SigInput[]): Promise<boolean[]> {
    if (events.length === 0) return Promise.resolve([]);
    if (this.closed || this.broken || this.queued + events.length > this.maxQueue) {
      // Back-pressure: do the work here rather than grow an unbounded queue.
      this.counters.inline += events.length;
      return Promise.resolve(events.map((e) => this.inlineFn(e)));
    }
    return new Promise<boolean[]>((resolve, reject) => {
      this.queue.push({
        events,
        results: new Array(events.length),
        left: events.length,
        failed: false,
        resolve,
        reject,
      });
      this.queued += events.length;
      this.schedule();
    });
  }

  stats(): VerifyPoolStats {
    let inFlight = 0;
    let live = 0;
    for (const s of this.slots) {
      if (s.worker) live++;
      for (const b of s.inFlight.values()) inFlight += b.count;
    }
    return {
      workers: this.size,
      live,
      broken: this.broken,
      queued: this.queued,
      inFlight,
      ...this.counters,
    };
  }

  /** Verify what is queued, wait (bounded) for in-flight batches, stop the workers. */
  async close(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.drainInline();
    const pending = this.slots.flatMap((s) => [...s.inFlight.values()].map((b) => b.done));
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(pending),
        new Promise<void>((r) => {
          timer = setTimeout(r, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    for (const s of this.slots)
      this.retire(s, new VerifyUnavailableError('server is shutting down'));
  }

  // ───────────────────────── internals ─────────────────────────

  private schedule(): void {
    if (this.queued >= this.maxBatch) {
      this.flush();
      return;
    }
    if (this.hasCapacity()) {
      // A worker is idle: send on the next turn (collects same-tick arrivals).
      if (!this.immediate) {
        this.immediate = true;
        setImmediate(() => {
          this.immediate = false;
          this.flush();
        });
      }
      return;
    }
    // All workers busy: a returning batch flushes; the timer bounds the wait.
    this.armTimer();
  }

  private armTimer(): void {
    if (this.flushTimer || this.closed || this.maxWaitMs <= 0 || this.queued === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.maxWaitMs);
  }

  private hasCapacity(): boolean {
    return this.slots.some((s) => s.inFlight.size < this.maxInFlight);
  }

  /** Take up to `max` queued events as segments (FIFO). */
  private take(max: number): Seg[] {
    const segs: Seg[] = [];
    let want = max;
    while (want > 0 && this.head < this.queue.length) {
      const req = this.queue[this.head] as Req;
      const count = Math.min(want, req.events.length - this.offset);
      segs.push({ req, start: this.offset, count });
      want -= count;
      this.queued -= count;
      this.offset += count;
      if (this.offset >= req.events.length) {
        this.head++;
        this.offset = 0;
      }
    }
    if (this.head === this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return segs;
  }

  private flush(): void {
    while (this.queued > 0 && !this.closed && !this.broken) {
      const slot = this.pickSlot();
      if (!slot) break;
      this.send(slot, this.take(this.maxBatch));
    }
    this.armTimer();
  }

  /** Least-loaded worker with spare capacity. */
  private pickSlot(): Slot | null {
    let best: Slot | null = null;
    for (const s of this.slots) {
      if (s.inFlight.size >= this.maxInFlight) continue;
      if (!best || s.inFlight.size < best.inFlight.size) best = s;
    }
    return best;
  }

  private spawn(slot: Slot): Worker {
    const gen = ++slot.gen;
    const worker = new Worker(this.url, { smol: true } as WorkerOptions);
    (worker as { unref?: () => void }).unref?.();
    worker.addEventListener('message', (ev: MessageEvent<VerifyResponse>) => {
      if (slot.gen !== gen) return;
      this.onResult(slot, ev.data);
    });
    worker.addEventListener('error', (ev) => {
      if (slot.gen !== gen) return;
      this.crash(slot, (ev as ErrorEvent).message || 'worker error');
    });
    worker.addEventListener('close', () => {
      if (slot.gen !== gen) return;
      this.crash(slot, 'worker exited');
    });
    slot.worker = worker;
    return worker;
  }

  private send(slot: Slot, segs: Seg[]): void {
    let worker = slot.worker;
    try {
      worker ??= this.spawn(slot);
    } catch (err) {
      // Could not start a thread at all: check these here.
      this.logger?.log('error', 'signature checking thread could not start', { err });
      for (const seg of segs) this.inlineSeg(seg);
      return;
    }
    const seq = ++this.seq;
    const data: string[] = [];
    let count = 0;
    for (const { req, start, count: n } of segs) {
      for (let i = start; i < start + n; i++) {
        const e = req.events[i] as SigInput;
        data.push(e.id, e.pubkey, e.sig);
      }
      count += n;
    }
    const timer = setTimeout(() => {
      if (slot.inFlight.has(seq)) this.crash(slot, 'worker stopped answering');
    }, this.batchTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    let settled = () => {};
    const done = new Promise<void>((r) => {
      settled = r;
    });
    slot.inFlight.set(seq, { seq, segs, count, timer, settled, done });
    this.counters.batches++;
    try {
      worker.postMessage({ seq, data } satisfies VerifyRequest);
    } catch {
      this.crash(slot, 'worker rejected the batch');
    }
  }

  private onResult(slot: Slot, res: VerifyResponse): void {
    const batch = slot.inFlight.get(res.seq);
    if (!batch) return;
    slot.inFlight.delete(res.seq);
    clearTimeout(batch.timer);
    this.crashStreak = 0;
    let k = 0;
    for (const { req, start, count } of batch.segs) {
      // Missing byte (malformed reply) → not valid.
      for (let i = start; i < start + count; i++) req.results[i] = res.ok[k++] === 1;
      this.counters.verified += count;
      this.complete(req, count);
    }
    batch.settled();
    if (this.queued > 0) this.flush();
  }

  private complete(req: Req, count: number): void {
    req.left -= count;
    if (req.left === 0 && !req.failed) req.resolve(req.results);
  }

  private inlineSeg({ req, start, count }: Seg): void {
    for (let i = start; i < start + count; i++)
      req.results[i] = this.inlineFn(req.events[i] as SigInput);
    this.counters.inline += count;
    this.complete(req, count);
  }

  /** Check everything still queued on this thread. */
  private drainInline(): void {
    if (this.queued > 0) for (const seg of this.take(this.queued)) this.inlineSeg(seg);
  }

  /** Fail the worker's outstanding events (never as valid) and replace it lazily. */
  private crash(slot: Slot, why: string): void {
    if (!slot.worker) return;
    const lost = [...slot.inFlight.values()].reduce((n, b) => n + b.count, 0);
    this.logger?.log('warn', 'signature checking thread failed; restarting it', {
      worker: slot.index,
      why,
      events: lost,
    });
    this.retire(slot, new VerifyUnavailableError(`signature could not be checked (${why})`));
    if (this.closed) return;
    if (++this.crashStreak >= this.maxCrashes) {
      this.broken = true;
      this.logger?.log(
        'error',
        'signature checking threads keep failing; checking signatures on the main thread',
        { crashes: this.crashStreak },
      );
      // Other threads' in-flight batches still finish; close() stops them.
      this.drainInline();
      return;
    }
    this.counters.respawns++;
    // Respawned on the next send; flush in case events are waiting.
    if (this.queued > 0) this.schedule();
  }

  private retire(slot: Slot, err: Error): void {
    slot.gen++;
    const w = slot.worker;
    slot.worker = null;
    for (const b of slot.inFlight.values()) {
      clearTimeout(b.timer);
      for (const { req, count } of b.segs) {
        this.counters.failed += count;
        if (!req.failed) {
          req.failed = true;
          req.reject(err);
        }
      }
      b.settled();
    }
    slot.inFlight.clear();
    try {
      w?.terminate();
    } catch {
      // already gone
    }
  }
}
