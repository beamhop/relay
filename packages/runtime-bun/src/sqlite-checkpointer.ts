// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Background WAL checkpoints for the bun:sqlite database.
 *
 * In WAL mode every commit appends pages to the write-ahead log; a checkpoint
 * copies them back into the database file and syncs it. SQLite runs that
 * checkpoint inside the commit that crosses `wal_autocheckpoint`, i.e. on the
 * thread that writes, which is the server's main thread. As the database grows
 * those checkpoints touch more pages and dominate the cost of accepting posts.
 *
 * This moves them to a worker thread with its own connection: it runs a PASSIVE
 * checkpoint every `intervalMs` (PASSIVE never blocks the writer or readers).
 * The main connection keeps a high `wal_autocheckpoint` as a safety net, so the
 * log stays bounded even if the worker stops.
 */
import type { Logger } from '@beamhop/core';

/** Pages: safety-net auto-checkpoint on the main connection (≈ 80 MB of log at 4 KiB). */
export const BACKGROUND_CHECKPOINT_SAFETY_PAGES = 20_000;

export interface SqliteCheckpointerOptions {
  /** How often the worker checkpoints. Default 250 ms. */
  intervalMs?: number;
  logger?: Logger;
}

export interface SqliteCheckpointer {
  /** Stop the worker (after one last checkpoint). */
  stop(): Promise<void>;
  /** Checkpoints run, frames copied, and busy (skipped) runs so far. */
  stats(): { runs: number; frames: number; busy: number; logFrames: number };
}

/** Worker body (kept inline so the single binary needs no extra entrypoint). */
const WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
let db = null;
let timer = null;
const stats = { runs: 0, frames: 0, busy: 0, logFrames: 0 };
function checkpoint() {
  try {
    const r = db.query('PRAGMA wal_checkpoint(PASSIVE)').get();
    stats.runs++;
    if (r) {
      if (r.busy) stats.busy++;
      stats.logFrames = r.log;
      stats.frames += r.checkpointed;
    }
    postMessage({ type: 'tick', stats });
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
}
onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    db = new Database(m.path);
    db.run('PRAGMA busy_timeout = 0');
    timer = setInterval(checkpoint, m.intervalMs);
    postMessage({ type: 'started' });
  } else if (m.type === 'stats') {
    postMessage({ type: 'stats', stats });
  } else if (m.type === 'stop') {
    if (timer) clearInterval(timer);
    if (db) {
      checkpoint();
      db.close();
    }
    postMessage({ type: 'stopped', stats });
  }
};
`;

/**
 * Start background checkpoints for the database file at `path`. Returns null
 * (and the main connection keeps checkpointing itself) when no worker can start.
 */
export async function startSqliteCheckpointer(
  path: string,
  opts: SqliteCheckpointerOptions = {},
): Promise<SqliteCheckpointer | null> {
  let worker: Worker;
  let url: string;
  try {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
    worker = new Worker(url);
  } catch (err) {
    opts.logger?.log('warn', 'background database checkpoints are off', { err: String(err) });
    return null;
  }
  let last = { runs: 0, frames: 0, busy: 0, logFrames: 0 };
  const waiters = new Map<string, Array<(m: Record<string, unknown>) => void>>();
  const waitFor = (type: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const list = waiters.get(type) ?? [];
      list.push(resolve);
      waiters.set(type, list);
    });
  worker.addEventListener('message', (e: MessageEvent<Record<string, unknown>>) => {
    const m = e.data;
    if (m.stats) last = m.stats as typeof last;
    if (m.type === 'error')
      opts.logger?.log('warn', 'background database checkpoint failed', {
        message: String(m.message),
      });
    const list = waiters.get(String(m.type));
    if (list) {
      waiters.delete(String(m.type));
      for (const fn of list) fn(m);
    }
  });
  worker.addEventListener('error', (e) => {
    opts.logger?.log('warn', 'background database checkpoint thread failed', {
      message: (e as ErrorEvent).message,
    });
  });
  const started = waitFor('started');
  worker.postMessage({ type: 'start', path, intervalMs: opts.intervalMs ?? 250 });
  const ok = await Promise.race([
    started.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
  ]);
  if (!ok) {
    worker.terminate();
    URL.revokeObjectURL(url);
    opts.logger?.log('warn', 'background database checkpoints are off', {
      err: 'worker did not start',
    });
    return null;
  }
  (worker as { unref?: () => void }).unref?.();
  let stopped = false;
  return {
    stats: () => last,
    async stop() {
      if (stopped) return;
      stopped = true;
      const done = waitFor('stopped');
      worker.postMessage({ type: 'stop' });
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
