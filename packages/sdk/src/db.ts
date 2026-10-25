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

/**
 * Multi-row `INSERT … ON CONFLICT (keys) DO UPDATE SET update` (DO NOTHING when `update` is empty), chunked to stay
 * within parameter limits. Rows are written in key order, so concurrent upserts (several instances on one postgres)
 * lock rows in the same order. Keys must be unique within one call.
 */
export async function upsertRows(
  db: Db,
  table: string,
  columns: readonly string[],
  keys: readonly string[],
  update: string,
  rows: unknown[][],
  rowsPerChunk = 200,
): Promise<void> {
  if (!rows.length) return;
  const idx = keys.map((k) => columns.indexOf(k));
  const sorted = [...rows].sort((a, b) => {
    for (const i of idx) {
      const x = a[i] as string | number;
      const y = b[i] as string | number;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  const tail = `ON CONFLICT (${keys.join(", ")}) ${update ? `DO UPDATE SET ${update}` : "DO NOTHING"}`;
  for (let i = 0; i < sorted.length; i += rowsPerChunk) {
    const part = sorted.slice(i, i + rowsPerChunk);
    await db.run(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${part.map(() => tuple).join(", ")} ${tail}`, part.flat());
  }
}
