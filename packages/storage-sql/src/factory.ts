// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `createSqlStores()` — one call wires EventStore, BlobIndex, DocStore and
 * TimeSeriesStore on a single connection for the chosen driver.
 *
 * Runtime-agnostic: `bun:sqlite` is loaded with a non-literal dynamic import
 * only when the sqlite driver opens a path itself, so Worker bundles that use
 * D1 never see it.
 */
import type { Database } from 'bun:sqlite';
import type { Logger } from '@beamhop/core';
import { SqlBlobIndex } from './blob-index.ts';
import { SqlDocStore } from './docs.ts';
import { SqlEventStore, type SqlEventStoreOptions } from './events.ts';
import { bunSqliteExec } from './exec/bun-sqlite.ts';
import { d1Exec } from './exec/d1.ts';
import { type PgClient, postgresExec } from './exec/postgres.ts';
import type { D1DatabaseLike, SqlExec } from './exec/types.ts';
import { SqlTimeSeries } from './metrics.ts';
import { type MigrateResult, migrate } from './migrate.ts';

interface CommonOptions {
  /** Connection URL: Postgres URL, or a SQLite path / `file:` / `sqlite:` URL. */
  url?: string;
  /** Node data directory; SQLite defaults to `${dataDir}/db/beamhop.sqlite`. */
  dataDir?: string;
  /** Optional logger (migrations applied are logged at info). */
  logger?: Logger;
  /** Run registered migrations on first `init()` of any store. Default true. */
  migrate?: boolean;
  events?: Omit<SqlEventStoreOptions, 'ready'>;
}

export interface SqliteStoresOptions extends CommonOptions {
  driver: 'sqlite';
  /** File path or `:memory:`. Precedence: database > path > url > dataDir > `:memory:`. */
  path?: string;
  /** Bring your own bun:sqlite Database (not closed by `close()`). */
  database?: Database;
  /** Overrides for DEFAULT_SQLITE_PRAGMAS. */
  pragmas?: Record<string, string | number>;
}

export interface D1StoresOptions extends CommonOptions {
  driver: 'd1';
  /** The D1 binding (`env.DB`). Either `d1` or `database`. */
  d1?: D1DatabaseLike;
  database?: D1DatabaseLike;
}

export interface PostgresStoresOptions extends CommonOptions {
  driver: 'postgres';
  /** Bring your own postgres.js client (not ended by `close()`). */
  client?: PgClient;
  /** Pool size when the factory creates the client. Default 10. */
  max?: number;
}

export type CreateSqlStoresOptions = SqliteStoresOptions | D1StoresOptions | PostgresStoresOptions;

export interface SqlStores {
  events: SqlEventStore;
  blobIndex: SqlBlobIndex;
  docs: SqlDocStore;
  metrics: SqlTimeSeries;
  /** Low-level executor (for modules that bring their own registered tables). */
  exec: SqlExec;
  /** Apply registered migrations now (idempotent). */
  migrate(): Promise<MigrateResult>;
  close(): Promise<void>;
}

function sqlitePath(opts: SqliteStoresOptions): string {
  if (opts.path) return opts.path;
  if (opts.url) return opts.url.replace(/^(sqlite|file):(\/\/)?/, '');
  if (opts.dataDir) return `${opts.dataDir.replace(/\/+$/, '')}/db/beamhop.sqlite`;
  return ':memory:';
}

async function openExec(opts: CreateSqlStoresOptions): Promise<SqlExec> {
  switch (opts.driver) {
    case 'sqlite': {
      if (opts.database) return bunSqliteExec(opts.database, { pragmas: opts.pragmas });
      const spec = 'bun:sqlite';
      const { Database: Db } = (await import(spec)) as typeof import('bun:sqlite');
      const path = sqlitePath(opts);
      if (path !== ':memory:' && path.includes('/')) {
        const fsSpec = 'node:fs';
        const fs = (await import(fsSpec)) as typeof import('node:fs');
        fs.mkdirSync(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
      }
      const db = new Db(path, { create: true });
      return bunSqliteExec(db, { pragmas: opts.pragmas, owned: true });
    }
    case 'd1': {
      const db = opts.d1 ?? opts.database;
      if (!db) throw new Error('storage-sql: d1 driver needs the D1 binding as `d1`');
      return d1Exec(db);
    }
    case 'postgres': {
      if (opts.client) return postgresExec(opts.client);
      if (!opts.url) throw new Error('storage-sql: postgres driver needs `url` or `client`');
      // Non-literal specifier: keeps postgres.js out of Worker bundles.
      const pgSpec = 'postgres';
      const { default: postgres } = (await import(pgSpec)) as {
        default: typeof import('postgres');
      };
      const client = postgres(opts.url, { max: opts.max ?? 10, onnotice: () => {} });
      return postgresExec(client, { owned: true });
    }
  }
}

/** Build all SQL-backed stores over an existing executor. */
export function storesFromExec(x: SqlExec, opts: CommonOptions = {}): SqlStores {
  let pending: Promise<MigrateResult> | undefined;
  const runMigrate = () => {
    pending ??= migrate(x)
      .then((r) => {
        if (r.applied.length)
          opts.logger?.log('info', 'storage migrations applied', { applied: r.applied });
        return r;
      })
      .catch((err) => {
        pending = undefined;
        throw err;
      });
    return pending;
  };
  const ready = opts.migrate === false ? async () => {} : async () => void (await runMigrate());
  const events = new SqlEventStore(x, { ...opts.events, ready });
  return {
    events,
    blobIndex: new SqlBlobIndex(x, { ready }),
    docs: new SqlDocStore(x, { ready }),
    metrics: new SqlTimeSeries(x, { ready }),
    exec: x,
    migrate: () => {
      pending = undefined;
      return runMigrate();
    },
    close: async () => {
      await events.close();
      await x.close();
    },
  };
}

export async function createSqlStores(opts: CreateSqlStoresOptions): Promise<SqlStores> {
  return storesFromExec(await openExec(opts), opts);
}
