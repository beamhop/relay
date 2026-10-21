// SPDX-License-Identifier: AGPL-3.0-or-later
// Drizzle-based EventStore/BlobIndex/DocStore/TimeSeries for bun:sqlite, D1, Postgres.
// Runtime-agnostic entry: the D1 shim (bun-only) lives at `@beamhop/storage-sql/d1-shim`.
export * from './factory.ts';
export * from './events.ts';
export * from './blob-index.ts';
export * from './docs.ts';
export { GroupCommitter } from './group-commit.ts';
export * from './metrics.ts';
export * from './migrate.ts';
export * from './exec/types.ts';
export {
  bunSqliteExec,
  DEFAULT_SQLITE_PRAGMAS,
  type BunSqliteExecOptions,
} from './exec/bun-sqlite.ts';
export { d1Exec, D1_MAX_PARAMS } from './exec/d1.ts';
export { postgresExec, type PgClient, type PostgresExecOptions } from './exec/postgres.ts';
export * as sqliteSchema from './schema/sqlite.ts';
export * as pgSchema from './schema/pg.ts';
