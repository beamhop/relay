// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Default port wiring for Bun. Storage comes from `@beamhop/storage-sql`
 * (`createSqlStores`) and blobs from `@beamhop/blobs`, both loaded by dynamic import
 * so this package never hard-depends on them. Anything unavailable falls back to the
 * in-memory reference adapters with a loud warning (data will NOT survive a restart).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BeamhopConfig,
  BlobIndex,
  BlobStore,
  DocStore,
  EventStore,
  Logger,
  MediaProcessor,
  Ports,
  TimeSeriesStore,
} from '@beamhop/core';
import {
  MemoryBlobIndex,
  MemoryBlobStore,
  MemoryDocStore,
  MemoryEventStore,
  MemoryTimeSeries,
} from '@beamhop/testkit';
import type { DataLayout } from './config.ts';
import { BunCrypto, BunScheduler, InProcessPubSub, systemClock } from './ports.ts';
import { sharpLoader } from './sharp.ts';
import { startSqliteCheckpointer } from './sqlite-checkpointer.ts';
import { WorkerEventStore } from './sqlite-writer.ts';

export interface SqlStores {
  events: EventStore;
  blobIndex: BlobIndex;
  docs: DocStore;
  metrics: TimeSeriesStore;
  /** storage-sql executor (offered to modules as `storage.sql`, e.g. lifecycle backups). */
  exec?: unknown;
  /** SQLite database file, when the factory opened one. */
  file?: string;
  close?: () => Promise<void> | void;
}

/** Shape the runtime expects from `@beamhop/storage-sql`. */
export type CreateSqlStores = (opts: {
  driver: BeamhopConfig['storage']['driver'];
  url?: string;
  dataDir: string;
  logger: Logger;
  /** SQLite pragma overrides. */
  pragmas?: Record<string, string | number>;
  /** Event store options (group commit). */
  events?: { groupCommit?: { enabled?: boolean; maxSize?: number; windowMs?: number } };
}) => Promise<Partial<SqlStores>> | Partial<SqlStores>;

/**
 * SQLite group commit window: saves arriving within this many milliseconds share one
 * transaction. Each commit rewrites the touched index pages into the log, so fewer,
 * larger commits are much cheaper; 2 ms adds at most that much to an OK.
 */
export const SQLITE_COMMIT_WINDOW_MS = 2;

/** Shape the runtime expects from `@beamhop/blobs`. */
export type CreateBlobStore = (
  opts: BeamhopConfig['blobStorage'] & { dataDir: string; logger: Logger },
) => Promise<BlobStore> | BlobStore;

export interface StorageLoaders {
  /** Override module loading (tests). Return undefined to simulate "not installed". */
  importSql?: () => Promise<{ createSqlStores?: CreateSqlStores } | undefined>;
  importBlobs?: () => Promise<
    { createBlobStore?: CreateBlobStore; createBlobStoreFromConfig?: CreateBlobStore } | undefined
  >;
  importMedia?: () => Promise<{ createBunMediaProcessor?: CreateMediaProcessor } | undefined>;
  /** Run SQLite checkpoints on a background thread (default true; see sqlite-checkpointer.ts). */
  backgroundCheckpoint?: boolean;
  /**
   * Event writes on a dedicated SQLite writer thread (sqlite-writer.ts). Default: off,
   * or on with env `BEAMHOP_SQLITE_WRITER_THREAD=1`.
   */
  writerThread?: boolean;
}

/** Shape the runtime expects from `@beamhop/media/bun` (sharp + ffmpeg composite). */
export type CreateMediaProcessor = (opts: {
  logger?: Logger;
  /** sharp loader for binaries shipping sharp next to them (see sharp.ts). */
  sharp?: { load?: () => Promise<unknown> };
}) => Promise<{ processor?: MediaProcessor }>;

function writerThreadFromEnv(): boolean {
  const v = process.env.BEAMHOP_SQLITE_WRITER_THREAD;
  return v === '1' || v === 'true';
}

/** SQLite's own default (pages); used again when no background checkpointer runs. */
const DEFAULT_WAL_AUTOCHECKPOINT = 1000;

async function setWalAutocheckpoint(exec: unknown, pages: number): Promise<void> {
  const x = exec as { run?: (q: { sql: string; params: unknown[] }) => Promise<unknown> };
  await x?.run?.({ sql: `PRAGMA wal_autocheckpoint = ${pages}`, params: [] });
}

async function tryImport<T>(load: () => Promise<unknown>): Promise<T | undefined> {
  try {
    return (await load()) as T;
  } catch {
    return undefined;
  }
}

export interface DefaultPortsResult {
  ports: Ports;
  scheduler: BunScheduler;
  crypto: BunCrypto;
  /** Which ports fell back to memory. */
  memoryFallbacks: string[];
  /** SQL access for modules (`kernel.provide('storage.sql', …)`), when SQL storage is open. */
  sql?: { exec: unknown; path?: string; url?: string };
  close(): Promise<void>;
}

/** Long-lived secret for the daily IP salt; persisted so hashes are stable across restarts. */
export function loadOrCreateSecret(layout: DataLayout, name = 'ip-salt.key'): Uint8Array {
  const path = join(layout.secretsDir, name);
  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return new Uint8Array(Buffer.from(hex, 'hex'));
  }
  const secret = crypto.getRandomValues(new Uint8Array(32));
  writeFileSync(path, Buffer.from(secret).toString('hex'), { mode: 0o600 });
  return secret;
}

export async function createDefaultPorts(
  config: BeamhopConfig,
  layout: DataLayout,
  logger: Logger,
  loaders: StorageLoaders = {},
): Promise<DefaultPortsResult> {
  const memoryFallbacks: string[] = [];
  const closers: Array<() => Promise<void> | void> = [];
  const warn = (what: string, why: string) => {
    memoryFallbacks.push(what);
    logger.log(
      'warn',
      `!!! ${what}: using IN-MEMORY storage — data will be LOST on restart (${why}) !!!`,
      { port: what },
    );
  };

  let sql: Partial<SqlStores> = {};
  if (config.storage.driver !== 'memory') {
    const mod = await (loaders.importSql?.() ??
      tryImport<{ createSqlStores?: CreateSqlStores }>(() => import('@beamhop/storage-sql')));
    if (typeof mod?.createSqlStores === 'function') {
      try {
        const sqlite = config.storage.driver === 'sqlite';
        const background = sqlite && loaders.backgroundCheckpoint !== false;
        sql = await mod.createSqlStores({
          driver: config.storage.driver,
          url: config.storage.url,
          dataDir: layout.root,
          logger: logger.child({ component: 'storage' }),
          ...(sqlite ? { events: { groupCommit: { windowMs: SQLITE_COMMIT_WINDOW_MS } } } : {}),
          // Checkpoints run on a background thread (below), not inside commits here.
          ...(background ? { pragmas: { wal_autocheckpoint: 0 } } : {}),
        });
        if (sql.close) closers.push(sql.close.bind(sql));
        if (background) {
          const exec = sql.exec;
          const selfCheckpoint = () =>
            setWalAutocheckpoint(exec, DEFAULT_WAL_AUTOCHECKPOINT).catch(() => {});
          const cp = sql.file
            ? await startSqliteCheckpointer(sql.file, {
                logger: logger.child({ component: 'storage' }),
                onStopped: () => void selfCheckpoint(),
              })
            : null;
          // Stopped before the database closes (closers run in order).
          if (cp) closers.unshift(() => cp.stop());
          else await selfCheckpoint();
        }
      } catch (err) {
        logger.log('error', 'database could not be opened', { err });
        sql = {};
      }
    }
  }
  const why =
    config.storage.driver === 'memory'
      ? 'storage.driver is "memory"'
      : '@beamhop/storage-sql is not available';
  const orMemory = <T>(name: string, got: T | undefined, make: () => T): T => {
    if (got) return got;
    warn(name, why);
    return make();
  };
  let events = orMemory('events', sql.events, () => new MemoryEventStore());
  const sqlEvents = events;
  if (sql.events && sql.file && (loaders.writerThread ?? writerThreadFromEnv())) {
    // Opt-in prototype: event writes on a dedicated SQLite writer thread (reads stay
    // here). Measured slower than the default under the load test; see
    // docs/performance.md. Runs from source only (not embedded in the single binary).
    const threaded = new WorkerEventStore({
      path: sql.file,
      reader: sql.events,
      windowMs: SQLITE_COMMIT_WINDOW_MS,
      logger: logger.child({ component: 'storage' }),
    });
    try {
      await threaded.init();
      events = threaded;
      logger.log('info', 'database writes run on a separate thread', {});
    } catch (err) {
      await threaded.stopWriter().catch(() => {});
      logger.log('warn', 'database writer thread could not start; writing here', {
        err: String(err),
      });
    }
  }
  const blobIndex = orMemory('blobIndex', sql.blobIndex, () => new MemoryBlobIndex());
  const docs = orMemory('docs', sql.docs, () => new MemoryDocStore());
  const metrics = orMemory('metrics', sql.metrics, () => new MemoryTimeSeries());

  let blobs: BlobStore | undefined;
  if (config.blobStorage.driver !== 'memory') {
    const mod = await (loaders.importBlobs?.() ??
      tryImport<{ createBlobStore?: CreateBlobStore; createBlobStoreFromConfig?: CreateBlobStore }>(
        () => import('@beamhop/blobs'),
      ));
    const factory = mod?.createBlobStore ?? mod?.createBlobStoreFromConfig;
    if (typeof factory === 'function') {
      try {
        blobs = await factory({
          ...config.blobStorage,
          dataDir: layout.root,
          logger: logger.child({ component: 'blobs' }),
        });
      } catch (err) {
        logger.log('error', 'blob storage could not be opened', { err });
      }
    }
  }
  if (!blobs) {
    warn(
      'blobs',
      config.blobStorage.driver === 'memory'
        ? 'blobStorage.driver is "memory"'
        : '@beamhop/blobs is not available',
    );
    blobs = new MemoryBlobStore();
  }

  for (const store of [events, blobIndex, docs, metrics, blobs]) await store.init();

  // Optional media tools (sharp / ffmpeg); absent → no `ports.media`, media health explains.
  let media: MediaProcessor | undefined;
  const mediaMod = await (loaders.importMedia?.() ??
    tryImport<{ createBunMediaProcessor?: CreateMediaProcessor }>(
      () => import('@beamhop/media/bun'),
    ));
  if (typeof mediaMod?.createBunMediaProcessor === 'function') {
    const loadSharp = sharpLoader();
    if (loadSharp) logger.log('info', 'loading sharp from outside the binary', {});
    try {
      media = (
        await mediaMod.createBunMediaProcessor({
          logger: logger.child({ component: 'media' }),
          ...(loadSharp ? { sharp: { load: loadSharp } } : {}),
        })
      ).processor;
    } catch (err) {
      logger.log('warn', 'media tools could not be loaded', { err });
    }
  }

  const scheduler = new BunScheduler({ logger: logger.child({ component: 'scheduler' }) });
  const bunCrypto = new BunCrypto({
    secret: loadOrCreateSecret(layout),
    clock: systemClock,
    ipLogging: config.privacy.ipLogging,
  });
  const ports: Ports = {
    events,
    blobs,
    blobIndex,
    docs,
    metrics,
    pubsub: new InProcessPubSub(logger),
    scheduler,
    clock: systemClock,
    logger,
    crypto: bunCrypto,
    ...(media ? { media } : {}),
  };
  return {
    ports,
    scheduler,
    crypto: bunCrypto,
    memoryFallbacks,
    ...(sql.exec && sql.events === sqlEvents
      ? {
          sql: {
            exec: sql.exec,
            ...(config.storage.driver === 'sqlite'
              ? { path: config.storage.url ?? layout.sqlitePath }
              : config.storage.url
                ? { url: config.storage.url }
                : {}),
          },
        }
      : {}),
    async close() {
      await scheduler.stop();
      try {
        await events.close();
      } catch (err) {
        logger.log('warn', 'error closing event store', { err });
      }
      for (const c of closers) {
        try {
          await c();
        } catch (err) {
          logger.log('warn', 'error closing storage', { err });
        }
      }
    },
  };
}
