import type { DatabaseTarget, Db, Logger, NamespaceMigrations, TableProgress } from "@beamhop/sdk";
import type { SqliteOptions } from "./db";

/**
 * Copying a whole Beamhop database to another one (any dialect pair). Used by the runtime switcher and by
 * `beamhop db copy`. CONTRACT STUB: implemented on the transfer branch.
 */

export interface TransferOptions {
  logger: Logger;
  /** rows per read page / insert batch; default 1000 */
  batchRows?: number;
  signal?: AbortSignal;
  onProgress?(tables: TableProgress[]): void;
}

export interface DatabaseInspection {
  serverVersion: string;
  /** user tables (excluding sqlite internals and FTS shadow tables), with row counts */
  tables: { name: string; rows: number }[];
  /** bytes, when cheap to know (sqlite file size incl. WAL, pg_database_size) */
  sizeBytes?: number;
}

export interface VerifyReport {
  ok: boolean;
  tables: { table: string; sourceRows: number; targetRows: number; ok: boolean; detail?: string }[];
}

/** Opens (creating when needed) the database a target describes. The caller closes it. */
export async function openDatabase(_target: DatabaseTarget, _sqlite?: SqliteOptions): Promise<Db> {
  throw new Error("not implemented");
}

export async function inspectDatabase(_db: Db): Promise<DatabaseInspection> {
  throw new Error("not implemented");
}

/** Drops every table (and FTS / sequences / triggers) in the database. */
export async function wipeDatabase(_db: Db): Promise<void> {
  throw new Error("not implemented");
}

/** Applies every namespace's migrations to `target`, so its schema is native to its dialect. */
export async function prepareSchema(_target: Db, _namespaces: NamespaceMigrations[]): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Copies every table from `source` to `target` (schema already prepared, target otherwise empty).
 * bulkCopy() runs while the source is live; finalCopy() runs with writes paused and brings the target fully up to
 * date (rows added/changed/deleted since); verify() compares the two.
 */
export class DatabaseCopier {
  constructor(
    readonly source: Db,
    readonly target: Db,
    readonly opts: TransferOptions,
  ) {}
  progress(): TableProgress[] {
    return [];
  }
  async bulkCopy(): Promise<void> {
    throw new Error("not implemented");
  }
  async finalCopy(): Promise<void> {
    throw new Error("not implemented");
  }
  async verify(): Promise<VerifyReport> {
    throw new Error("not implemented");
  }
}
