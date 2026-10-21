// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Group commit for synchronous drivers (bun:sqlite): writes queued in the same
 * tick (or window) run in one transaction, so a burst of N writes costs one
 * commit instead of N. One committer is shared by every store on a connection
 * (events, docs), so their writes land in the same transaction.
 *
 * Reads call `flush()` first, so they always see earlier writes.
 */
import type { SyncExec } from './exec/types.ts';

export interface GroupCommitOptions {
  /** Group concurrent writes into one transaction (sync drivers only). Default true. */
  enabled?: boolean;
  /** Flush when this many writes are queued. Default 512. */
  maxSize?: number;
  /** Wait this long for more writes before committing (0 = end of current tick). Default 0. */
  windowMs?: number;
}

interface Item {
  run: () => unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class GroupCommitter {
  readonly maxSize: number;
  readonly windowMs: number;
  private queue: Item[] = [];
  private scheduled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sync: SyncExec,
    opts: GroupCommitOptions = {},
  ) {
    this.maxSize = Math.max(1, opts.maxSize ?? 512);
    this.windowMs = Math.max(0, opts.windowMs ?? 0);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Queue `fn` (synchronous statements only); resolves with its result after the commit. */
  enqueue<T>(fn: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: fn, resolve: resolve as (v: unknown) => void, reject });
      if (this.queue.length >= this.maxSize) {
        this.flush();
      } else if (!this.scheduled) {
        this.scheduled = true;
        if (this.windowMs > 0) {
          this.timer = setTimeout(() => this.flush(), this.windowMs);
          (this.timer as { unref?: () => void }).unref?.();
        } else queueMicrotask(() => this.flush());
      }
    });
  }

  /** Commit queued writes now. */
  flush(): void {
    this.scheduled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    let results: unknown[];
    try {
      results = this.sync.transaction(() => items.map((it) => it.run()));
    } catch {
      // Isolate the failing write(s): retry one transaction per item.
      for (const it of items) {
        try {
          it.resolve(this.sync.transaction(() => it.run()));
        } catch (err) {
          it.reject(err);
        }
      }
      return;
    }
    items.forEach((it, i) => it.resolve(results[i]));
  }
}
