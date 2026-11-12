import type { Db, Dialect, Migration } from "./db";

/**
 * Switching the database (SQLite ⇄ Postgres) while the server runs.
 *
 * The Db every package holds is a switchable wrapper. While a switch is in its final phase, writes are paused: a
 * write waits a short while and then rejects with {@link DbSwitchingError}. Reads keep working. Components that
 * cache state read from the database register {@link DbSwitchHooks} callbacks to flush before the final copy and
 * reload after the switch.
 */

/** Where a database lives. */
export interface DatabaseTarget {
  driver: Dialect;
  /** absolute path (driver "sqlite") */
  sqlitePath?: string;
  /** connection URL (driver "postgres") */
  postgresUrl?: string;
}

/** Rejection of a write issued while a database switch has writes paused. Retryable. */
export class DbSwitchingError extends Error {
  readonly code = "db_switching" as const;
  /** seconds a client should wait before retrying */
  readonly retryAfterSec: number;
  constructor(message = "database switch in progress, try again shortly", retryAfterSec = 5) {
    super(message);
    this.name = "DbSwitchingError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** Works across package copies (instanceof can fail when two copies of the sdk are loaded). */
export const isDbSwitchingError = (err: unknown): err is DbSwitchingError =>
  err instanceof Error && (err as { code?: unknown }).code === "db_switching";

/** "normal": everything flows. "paused": writes wait / reject with DbSwitchingError, reads flow. */
export type DbWritePhase = "normal" | "paused";

export interface DbSwappedEvent {
  from: Dialect;
  to: Dialect;
}

/**
 * Registration point for components that cache database-derived state. Available as `stores.dbSwitch` (optional:
 * absent on stores that cannot switch, e.g. some test doubles). Every register function returns an unregister.
 */
export interface DbSwitchHooks {
  readonly phase: DbWritePhase;
  /**
   * Writes are already paused; the final copy is about to run. Flush in-memory buffered writes (activity counters,
   * queued rows) to the database now. Awaited, in registration order; a throw aborts the switch (old db stays).
   */
  onBeforeFinalCopy(fn: () => void | Promise<void>, name?: string): () => void;
  /**
   * The wrapper now points at the new database; writes are still paused. Drop caches / reload state / recompute
   * dialect-dependent choices. Awaited, in registration order; a throw aborts the switch: the wrapper is pointed
   * back at the old database and every hook runs again with from/to reversed.
   */
  onSwapped(fn: (e: DbSwappedEvent) => void | Promise<void>, name?: string): () => void;
  /** Phase changes (pause / resume). Not awaited. */
  onPhase(fn: (phase: DbWritePhase) => void): () => void;
}

/** One namespace's migrations, as passed to `Db.migrate` (recorded so a new database can be given the same schema). */
export interface NamespaceMigrations {
  namespace: string;
  migrations: Migration[];
}

/** The switchable wrapper (implemented in @beamhop/storage). */
export interface SwitchableDb extends Db, DbSwitchHooks {
  /** the database currently behind the wrapper */
  readonly current: Db;
  /** every `migrate()` call made through the wrapper since startup, latest list per namespace */
  registeredMigrations(): NamespaceMigrations[];
  /** Stop new writes; resolves once in-flight writes and transactions have finished. Idempotent. */
  pauseWrites(): Promise<void>;
  /** Let writes flow again (waiting writes proceed). */
  resumeWrites(): void;
  /** Runs the onBeforeFinalCopy hooks. Must be paused. */
  runBeforeFinalCopy(): Promise<void>;
  /**
   * Must be paused. Points the wrapper at `next` and runs the onSwapped hooks. If a hook throws, points back at the
   * previous database, re-runs the hooks with from/to reversed, and rethrows. Returns the previous database (not
   * closed: the caller owns it).
   */
  swap(next: Db): Promise<Db>;
}

// ----- persisted state (data/database.json) -----

/** A database left behind by a switch, kept as a rollback point until an admin deletes it. */
export interface DatabaseRollbackPoint {
  id: string;
  target: DatabaseTarget;
  /** unix seconds */
  frozenAt: number;
  /** what replaced it */
  replacedBy: Dialect;
}

/** Contents of the database state file. It overrides `config.database` at boot; environment variables still win. */
export interface DatabaseStateFile {
  version: 1;
  current: DatabaseTarget;
  rollbacks: DatabaseRollbackPoint[];
  /** unix seconds of the last switch */
  switchedAt?: number;
}

// ----- the switcher service (orchestrator), exposed to the admin API -----

export type DatabaseSwitchPhase =
  | "preflight"
  | "schema"
  | "bulk_copy"
  | "pausing"
  | "final_copy"
  | "verify"
  | "switching"
  | "persist"
  | "done"
  | "failed"
  | "cancelled";

export interface TableProgress {
  table: string;
  /** source rows (estimate during bulk copy) */
  total: number;
  copied: number;
  done: boolean;
}

export interface DatabaseSwitchJobView {
  id: string;
  from: DatabaseTarget & { postgresUrl?: string /* redacted */ };
  to: DatabaseTarget & { postgresUrl?: string /* redacted */ };
  phase: DatabaseSwitchPhase;
  startedAt: number;
  finishedAt?: number;
  tables: TableProgress[];
  /** how long writes have been (or were) paused, ms */
  pausedMs?: number;
  /** human-readable failure reason (phase "failed") */
  error?: string;
  /** cancel is only possible before writes pause */
  cancellable: boolean;
  actor: string;
}

export interface DatabaseTestResult {
  ok: boolean;
  /** could connect / open */
  reachable: boolean;
  /** e.g. "PostgreSQL 17.2" / "SQLite 3.46.0" */
  serverVersion?: string;
  /** no Beamhop tables (and no other tables) found */
  empty: boolean;
  existingTables: { name: string; rows: number }[];
  /** the same database the server already uses */
  sameAsCurrent: boolean;
  errors: string[];
}

export interface DatabaseInstanceInfo {
  id: string;
  /** unix seconds of last heartbeat */
  seenAt: number;
  host?: string;
  self: boolean;
}

export interface DatabaseStatus {
  current: DatabaseTarget & { postgresUrl?: string /* redacted */ };
  /** bytes, when known */
  sizeBytes?: number;
  tables: { name: string; rows: number }[];
  /** env vars pin the database driver/location: switching is disabled */
  envPinned: boolean;
  /** env provides a postgres URL to prefill (redacted) */
  envPostgresUrl?: string;
  instances: DatabaseInstanceInfo[];
  rollbacks: (DatabaseRollbackPoint & { target: DatabaseTarget & { postgresUrl?: string /* redacted */ } })[];
  /** the running / last switch job */
  job?: DatabaseSwitchJobView;
  /** why switching is unavailable right now, if it is */
  blockedReason?: string;
}

export interface DatabaseSwitchRequest {
  target: DatabaseTarget;
  /** required when the target is not empty: must equal {@link WIPE_CONFIRM_PHRASE} */
  wipeConfirm?: string;
}

export const WIPE_CONFIRM_PHRASE = "wipe target database";
export const DELETE_ROLLBACK_CONFIRM_PHRASE = "delete old database";

export interface DatabaseSwitcher {
  status(): Promise<DatabaseStatus>;
  test(target: DatabaseTarget): Promise<DatabaseTestResult>;
  /** Starts a background job (one at a time). Throws (with a message for the admin) when blocked. */
  start(req: DatabaseSwitchRequest, actor: string): Promise<DatabaseSwitchJobView>;
  job(id: string): DatabaseSwitchJobView | undefined;
  /** true when cancelled (only before writes pause) */
  cancel(id: string): boolean;
  /** Deletes a frozen old database (SQLite file + WAL/SHM, or every table on the Postgres side). */
  deleteRollback(id: string, confirm: string, actor: string): Promise<void>;
}
