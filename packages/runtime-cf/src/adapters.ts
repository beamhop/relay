// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Storage and blob adapters, loaded by package name so the runtime builds even
 * while those packages evolve. Missing bindings or missing exports fall back to
 * the in-memory reference adapters with a warning (data is then per-isolate and
 * lost on eviction: fine for `wrangler dev`, never for production).
 *
 * Expected exports (integration contract):
 * - `@beamhop/storage-sql`: `createSqlStores({ driver: 'd1', d1: env.DB })` → (Promise of)
 *   `{ events, blobIndex, docs, metrics }` (any subset; missing ones fall back to memory).
 * - `@beamhop/blobs`: `class R2BindingBlobStore` constructed with the R2 bucket binding.
 */
import type {
  BlobIndex,
  BlobStore,
  DocStore,
  EventStore,
  Logger,
  TimeSeriesStore,
} from '@beamhop/core';
import {
  MemoryBlobIndex,
  MemoryBlobStore,
  MemoryDocStore,
  MemoryEventStore,
  MemoryTimeSeries,
} from '@beamhop/testkit/memory';
import type { CfEnv } from './env.ts';

type Namespace = Record<string, unknown>;

export interface AdapterImporters {
  storageSql: () => Promise<Namespace>;
  blobs: () => Promise<Namespace>;
}

export const defaultImporters: AdapterImporters = {
  storageSql: () => import('@beamhop/storage-sql') as Promise<Namespace>,
  blobs: () => import('@beamhop/blobs') as Promise<Namespace>,
};

export interface LoadedStores {
  events: EventStore;
  blobIndex: BlobIndex;
  docs: DocStore;
  metrics: TimeSeriesStore;
  blobs: BlobStore;
  /** Where each store came from, for logs/health. */
  sources: Record<'events' | 'blobIndex' | 'docs' | 'metrics' | 'blobs', 'd1' | 'r2' | 'memory'>;
}

async function tryImport(fn: () => Promise<Namespace>): Promise<Namespace | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function loadStores(
  env: Pick<CfEnv, 'DB' | 'BLOBS'>,
  logger: Logger,
  importers: AdapterImporters = defaultImporters,
): Promise<LoadedStores> {
  let sql: Partial<Pick<LoadedStores, 'events' | 'blobIndex' | 'docs' | 'metrics'>> = {};
  if (env.DB) {
    const ns = await tryImport(importers.storageSql);
    const create = ns?.createSqlStores;
    if (typeof create === 'function') {
      sql = (await create({ driver: 'd1', d1: env.DB })) as typeof sql;
    } else {
      logger.log(
        'warn',
        'Database adapter for D1 is not available; using temporary memory storage',
        {
          technical: '@beamhop/storage-sql does not export createSqlStores',
        },
      );
    }
  } else {
    logger.log('warn', 'No database connected; using temporary memory storage', {
      technical: 'D1 binding "DB" missing',
    });
  }

  let blobs: BlobStore | null = null;
  if (env.BLOBS) {
    const ns = await tryImport(importers.blobs);
    const Ctor = ns?.R2BindingBlobStore;
    if (typeof Ctor === 'function') {
      blobs = new (Ctor as new (bucket: unknown) => BlobStore)(env.BLOBS);
    } else {
      logger.log(
        'warn',
        'File storage adapter for R2 is not available; using temporary memory storage',
        {
          technical: '@beamhop/blobs does not export R2BindingBlobStore',
        },
      );
    }
  } else {
    logger.log('warn', 'No file storage connected; using temporary memory storage', {
      technical: 'R2 binding "BLOBS" missing',
    });
  }

  const pick = <T>(v: T | undefined, fallback: () => T, name: string): [T, 'd1' | 'memory'] => {
    if (v) return [v, 'd1'];
    if (env.DB && Object.keys(sql).length > 0) {
      logger.log('warn', `Storage adapter missing "${name}"; using memory for it`);
    }
    return [fallback(), 'memory'];
  };
  const [events, se] = pick(sql.events, () => new MemoryEventStore(), 'events');
  const [blobIndex, sbi] = pick(sql.blobIndex, () => new MemoryBlobIndex(), 'blobIndex');
  const [docs, sd] = pick(sql.docs, () => new MemoryDocStore(), 'docs');
  const [metrics, sm] = pick(sql.metrics, () => new MemoryTimeSeries(), 'metrics');
  const blobStore = blobs ?? new MemoryBlobStore();

  await Promise.all([
    events.init(),
    blobIndex.init(),
    docs.init(),
    metrics.init(),
    blobStore.init(),
  ]);

  return {
    events,
    blobIndex,
    docs,
    metrics,
    blobs: blobStore,
    sources: {
      events: se,
      blobIndex: sbi,
      docs: sd,
      metrics: sm,
      blobs: blobs ? 'r2' : 'memory',
    },
  };
}
