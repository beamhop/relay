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

export interface SqlStores {
  events: EventStore;
  blobIndex: BlobIndex;
  docs: DocStore;
  metrics: TimeSeriesStore;
  close?: () => Promise<void> | void;
}

/** Shape the runtime expects from `@beamhop/storage-sql`. */
export type CreateSqlStores = (opts: {
  driver: BeamhopConfig['storage']['driver'];
  url?: string;
  dataDir: string;
  logger: Logger;
}) => Promise<Partial<SqlStores>> | Partial<SqlStores>;

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
        sql = await mod.createSqlStores({
          driver: config.storage.driver,
          url: config.storage.url,
          dataDir: layout.root,
          logger: logger.child({ component: 'storage' }),
        });
        if (sql.close) closers.push(sql.close.bind(sql));
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
  const events = orMemory('events', sql.events, () => new MemoryEventStore());
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
  };
  return {
    ports,
    scheduler,
    crypto: bunCrypto,
    memoryFallbacks,
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
