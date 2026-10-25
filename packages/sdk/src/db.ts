export type Dialect = "sqlite" | "postgres";

export interface Migration {
  /** unique, sortable id within the namespace, e.g. "001_init" */
  id: string;
  /** SQL string (portable) or per-dialect SQL. Multiple statements allowed. */
  up: string | { sqlite: string; postgres: string };
}

/**
 * Thin async SQL abstraction shared by every package and plugin.
 * Always write placeholders as `?` — the postgres adapter rewrites them to $1..$n.
 * JSON columns: store as TEXT and JSON.stringify/parse yourself (portable).
 * Booleans: store as INTEGER 0/1 (portable). Timestamps: INTEGER unix seconds.
 */
export interface Db {
  readonly dialect: Dialect;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Applies pending migrations for a namespace (tracked in `_migrations` table). */
  migrate(namespace: string, migrations: Migration[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Resolves on a timer turn, after timers already due and pending socket I/O got to run (a `setImmediate` callback
 * may run before due timers on Bun). Bulk jobs on SQLite, whose statements run synchronously on the event loop,
 * await this between batches so a long job doesn't stall the relay. Costs ~1 ms per call.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
