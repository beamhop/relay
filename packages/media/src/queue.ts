// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Small in-process work queue with a concurrency limit and backpressure.
 * `push` never blocks or throws: jobs start on a later microtask, so uploads
 * are never slowed by media work. When the queue is full, `normal` jobs are
 * dropped (and counted); `high` jobs (abuse scans) are always accepted.
 * Jobs with the same `key` are coalesced while queued or running.
 */

export type Priority = 'high' | 'normal';

export interface QueueStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  dropped: number;
  concurrency: number;
  maxQueued: number;
}

export interface PushResult {
  accepted: boolean;
  /** Settles (never rejects) when the job finished; resolves immediately if dropped. */
  done: Promise<void>;
}

interface Job {
  key?: string;
  run: () => Promise<void>;
  done: Promise<void>;
  resolve: () => void;
}

export interface WorkQueueOptions {
  concurrency?: number;
  maxQueued?: number;
  onError?: (err: unknown, key?: string) => void;
}

export class WorkQueue {
  private readonly high: Job[] = [];
  private readonly normal: Job[] = [];
  private readonly byKey = new Map<string, Job>();
  private running = 0;
  private done = 0;
  private failed = 0;
  private dropped = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  concurrency: number;
  maxQueued: number;

  constructor(private readonly opts: WorkQueueOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.maxQueued = Math.max(0, opts.maxQueued ?? 100);
  }

  get depth(): number {
    return this.high.length + this.normal.length;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  stats(): QueueStats {
    return {
      queued: this.depth,
      running: this.running,
      done: this.done,
      failed: this.failed,
      dropped: this.dropped,
      concurrency: this.concurrency,
      maxQueued: this.maxQueued,
    };
  }

  push(run: () => Promise<void>, o: { priority?: Priority; key?: string } = {}): PushResult {
    if (o.key) {
      const existing = this.byKey.get(o.key);
      if (existing) return { accepted: true, done: existing.done };
    }
    const priority = o.priority ?? 'normal';
    if (this.closed || (priority === 'normal' && this.depth >= this.maxQueued)) {
      this.dropped++;
      return { accepted: false, done: Promise.resolve() };
    }
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const job: Job = { key: o.key, run, done, resolve };
    if (o.key) this.byKey.set(o.key, job);
    (priority === 'high' ? this.high : this.normal).push(job);
    queueMicrotask(() => this.pump());
    return { accepted: true, done };
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const job = this.high.shift() ?? this.normal.shift();
      if (!job) break;
      this.running++;
      void (async () => {
        try {
          await job.run();
          this.done++;
        } catch (err) {
          this.failed++;
          try {
            this.opts.onError?.(err, job.key);
          } catch {
            // error reporting must never break the queue
          }
        } finally {
          this.running--;
          if (job.key && this.byKey.get(job.key) === job) this.byKey.delete(job.key);
          job.resolve();
          this.pump();
          if (this.running === 0 && this.depth === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const w of waiters) w();
          }
        }
      })();
    }
  }

  /** Resolves when nothing is queued or running. */
  onIdle(): Promise<void> {
    if (this.running === 0 && this.depth === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** Stop accepting jobs; queued jobs still run. */
  close(): void {
    this.closed = true;
  }
}
