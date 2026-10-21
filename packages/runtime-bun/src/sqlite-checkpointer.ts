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
 * This moves them to a worker thread with its own connection, while the main
 * connection runs with `wal_autocheckpoint = 0`:
 * - every `intervalMs` a PASSIVE checkpoint (never blocks the writer or readers);
 * - under constant writes a passive checkpoint never catches up completely, so the
 *   log would only grow. Once it holds `restartFrames` frames the worker runs a
 *   RESTART checkpoint: it copies the few frames the passive runs have not, while
 *   writers wait briefly, and the next commit starts the log from the beginning.
 * If the worker cannot start or stops, `onStopped` is called so the main
 * connection can checkpoint itself again.
 */
import type { Logger } from '@beamhop/core';

export interface SqliteCheckpointerOptions {
  /** How often the worker checkpoints. Default 250 ms. */
  intervalMs?: number;
  /** Log size (frames, ≈ 4 KiB each) that triggers a RESTART checkpoint. Default 8192. */
  restartFrames?: number;
  logger?: Logger;
  /** The worker died unexpectedly (not called after `stop()`). */
  onStopped?: () => void;
}

export interface CheckpointStats {
  /** Checkpoints run. */
  runs: number;
  /** Frames copied into the database file. */
  frames: number;
  /** Runs that could not finish because a writer or reader was busy. */
  busy: number;
  /** RESTART checkpoints that completed (the log starts over). */
  restarts: number;
  /** Frames in the log after the latest run. */
  logFrames: number;
}

export interface SqliteCheckpointer {
  /** Stop the worker (after one last checkpoint). */
  stop(): Promise<void>;
  stats(): CheckpointStats;
}

/** Worker body (inline, so the single binary needs no extra entrypoint). */
const WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
let db = null;
let timer = null;
let restartFrames = 8192;
const stats = { runs: 0, frames: 0, busy: 0, restarts: 0, logFrames: 0 };
function run(mode) {
  const r = db.query('PRAGMA wal_checkpoint(' + mode + ')').get();
  stats.runs++;
  if (!r) return null;
  if (r.busy) stats.busy++;
  if (r.checkpointed > 0) stats.frames += r.checkpointed;
  stats.logFrames = r.log;
  return r;
}
function tick() {
  try {
    const r = run('PASSIVE');
    if (r && r.log >= restartFrames) {
      // Wait a little for the writer's current transaction, not longer.
      db.run('PRAGMA busy_timeout = 100');
      try {
        const x = run('RESTART');
        if (x && !x.busy) stats.restarts++;
      } finally {
        db.run('PRAGMA busy_timeout = 0');
      }
    }
    postMessage({ type: 'tick', stats });
  } catch (err) {
    postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
}
onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    try {
      db = new Database(m.path, { create: false, readwrite: true });
      db.run('PRAGMA busy_timeout = 0');
      restartFrames = m.restartFrames;
      timer = setInterval(tick, m.intervalMs);
      postMessage({ type: 'started' });
    } catch (err) {
      postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  } else if (m.type === 'stop') {
    if (timer) clearInterval(timer);
    if (db) {
      try { run('PASSIVE'); } catch {}
      db.close();
    }
    postMessage({ type: 'stopped', stats });
  }
};
`;

/**
 * Start background checkpoints for the database file at `path`. Returns null
 * when no worker could start (the main connection must then checkpoint itself).
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
  let last: CheckpointStats = { runs: 0, frames: 0, busy: 0, restarts: 0, logFrames: 0 };
  let stopping = false;
  let dead = false;
  const waiters = new Map<string, Array<(m: Record<string, unknown>) => void>>();
  const waitFor = (type: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const list = waiters.get(type) ?? [];
      list.push(resolve);
      waiters.set(type, list);
    });
  const died = (why: string) => {
    if (stopping || dead) return;
    dead = true;
    opts.logger?.log('warn', 'background database checkpoints stopped', { why });
    opts.onStopped?.();
  };
  worker.addEventListener('message', (e: MessageEvent<Record<string, unknown>>) => {
    const m = e.data;
    if (m.stats) last = m.stats as CheckpointStats;
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
  worker.addEventListener('error', (e) => died((e as ErrorEvent).message || 'worker error'));
  worker.addEventListener('close', () => died('worker exited'));

  const started = waitFor('started');
  const failed = waitFor('error');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  worker.postMessage({
    type: 'start',
    path,
    intervalMs: opts.intervalMs ?? 250,
    restartFrames: opts.restartFrames ?? 8192,
  });
  const ok = await Promise.race([
    started.then(() => true),
    failed.then(() => false),
    new Promise<boolean>((r) => {
      timeout = setTimeout(() => r(false), 5000);
    }),
  ]);
  clearTimeout(timeout);
  if (!ok) {
    stopping = true;
    worker.terminate();
    URL.revokeObjectURL(url);
    opts.logger?.log('warn', 'background database checkpoints are off', {
      err: 'worker did not start',
    });
    return null;
  }
  (worker as { unref?: () => void }).unref?.();
  return {
    stats: () => last,
    async stop() {
      if (stopping) return;
      stopping = true;
      if (!dead) {
        const done = waitFor('stopped');
        worker.postMessage({ type: 'stop' });
        await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      }
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
