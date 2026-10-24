import type { BeamhopConfig, Db, Dialect, Migration } from "@beamhop/sdk";
import { isBun } from "@beamhop/sdk";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

interface SqliteDriver {
  all(sql: string, params: unknown[]): unknown[];
  get(sql: string, params: unknown[]): unknown;
  run(sql: string, params: unknown[]): { changes: number };
  exec(sql: string): void;
  close(): void;
}

const normalizeParams = (params: unknown[] = []) =>
  params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p === undefined ? null : p));

async function openSqlite(path: string): Promise<SqliteDriver> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  if (isBun) {
    const mod = "bun:sqlite";
    const { Database } = (await import(/* @vite-ignore */ mod)) as typeof import("bun:sqlite");
    const db = new Database(path, { create: true, strict: true });
    const cache = new Map<string, ReturnType<typeof db.prepare>>();
    const stmt = (sql: string) => {
      let s = cache.get(sql);
      if (!s) {
        s = db.prepare(sql);
        if (cache.size > 500) cache.clear();
        cache.set(sql, s);
      }
      return s;
    };
    return {
      all: (sql, p) => stmt(sql).all(...(p as never[])),
      get: (sql, p) => stmt(sql).get(...(p as never[])) ?? undefined,
      // bun's `changes` is a total_changes() delta (includes trigger side effects); use changes() instead
      run: (sql, p) => {
        stmt(sql).run(...(p as never[]));
        return { changes: Number((stmt("SELECT changes() AS c").get() as { c: number }).c) };
      },
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    };
  }
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path);
  const cache = new Map<string, import("better-sqlite3").Statement<unknown[]>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare<unknown[]>(sql);
      if (cache.size > 500) cache.clear();
      cache.set(sql, s);
    }
    return s;
  };
  return {
    all: (sql, p) => stmt(sql).all(...p),
    get: (sql, p) => stmt(sql).get(...p),
    run: (sql, p) => {
      const s = stmt(sql);
      if (!s.reader) return { changes: s.run(...p).changes };
      s.all(...p);
      return { changes: 0 };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

abstract class BaseDb implements Db {
  abstract readonly dialect: Dialect;
  abstract all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  abstract get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  abstract run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  abstract exec(sql: string): Promise<void>;
  abstract tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  async migrate(namespace: string, migrations: Migration[]): Promise<void> {
    await this.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (namespace TEXT NOT NULL, id TEXT NOT NULL, applied_at BIGINT NOT NULL, PRIMARY KEY (namespace, id))",
    );
    await this.runMigrations(namespace, migrations);
  }

  protected async runMigrations(namespace: string, migrations: Migration[]): Promise<void> {
    const done = new Set(
      (await this.all<{ id: string }>("SELECT id FROM _migrations WHERE namespace = ?", [namespace])).map((r) => r.id),
    );
    const pending = [...migrations].sort((a, b) => a.id.localeCompare(b.id)).filter((m) => !done.has(m.id));
    for (const m of pending) {
      const sql = typeof m.up === "string" ? m.up : m.up[this.dialect];
      await this.tx(async (db) => {
        await db.exec(sql);
        await db.run("INSERT INTO _migrations (namespace, id, applied_at) VALUES (?, ?, ?)", [
          namespace,
          m.id,
          Math.floor(Date.now() / 1000),
        ]);
      });
    }
  }
}

class SqliteDb extends BaseDb {
  readonly dialect = "sqlite" as const;
  private chain: Promise<unknown> = Promise.resolve();
  /** Identifies the transaction the current async context belongs to (for nesting). */
  private txContext = new AsyncLocalStorage<object>();
  /** Token of the transaction open on the (single) connection, if any. */
  private openTx: object | null = null;
  constructor(private d: SqliteDriver) {
    super();
  }
  /**
   * There is one connection: a statement issued from outside the open transaction's async context
   * would run inside it (seeing uncommitted data, and being rolled back with it). Such statements
   * wait until the transaction finishes. Work started inside a transaction that outlives it (fire and
   * forget) keeps a stale token and is treated like any other outside caller.
   */
  private op<T>(fn: () => T): Promise<T> {
    if (this.openTx === null || this.txContext.getStore() === this.openTx) {
      try {
        return Promise.resolve(fn());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }
  all<T>(sql: string, params?: unknown[]) {
    return this.op(() => this.d.all(sql, normalizeParams(params)) as T[]);
  }
  get<T>(sql: string, params?: unknown[]) {
    return this.op(() => (this.d.get(sql, normalizeParams(params)) ?? undefined) as T | undefined);
  }
  run(sql: string, params?: unknown[]) {
    return this.op(() => this.d.run(sql, normalizeParams(params)));
  }
  exec(sql: string) {
    return this.op(() => {
      this.d.exec(sql);
    });
  }
  /**
   * Transactions are serialized; tx() calls made from within the open transaction's async context
   * reuse it (concurrent unrelated callers wait their turn).
   */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.openTx !== null && this.txContext.getStore() === this.openTx) return fn(this);
    const next = this.chain.then(() => {
      const token = {};
      return this.txContext.run(token, async () => {
        this.d.exec("BEGIN IMMEDIATE");
        this.openTx = token;
        try {
          const r = await fn(this);
          this.d.exec("COMMIT");
          return r;
        } catch (e) {
          this.d.exec("ROLLBACK");
          throw e;
        } finally {
          this.openTx = null;
        }
      });
    });
    this.chain = next.catch(() => {});
    return next;
  }
  async close() {
    this.d.close();
  }
}

/** Rewrites `?` placeholders (outside quotes) to $1..$n */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  let out = "";
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "?") out += `$${++i}`;
    else out += ch;
  }
  return out;
}

type PgSql = import("postgres").Sql;

/** Postgres per-statement limit: a runaway query (e.g. a broad search) can't pin a pool connection forever. */
export const PG_STATEMENT_TIMEOUT_MS = 30_000;
/** Postgres limit for a transaction left open without activity (its locks block other writers). */
export const PG_IDLE_IN_TX_TIMEOUT_MS = 60_000;
class PostgresDb extends BaseDb {
  readonly dialect = "postgres" as const;
  constructor(private sql: PgSql, private root = true) {
    super();
  }
  async all<T>(q: string, params?: unknown[]) {
    return (await this.sql.unsafe(toPgPlaceholders(q), normalizeParams(params) as never[])) as unknown as T[];
  }
  async get<T>(q: string, params?: unknown[]) {
    return (await this.all<T>(q, params))[0];
  }
  async run(q: string, params?: unknown[]) {
    const r = await this.sql.unsafe(toPgPlaceholders(q), normalizeParams(params) as never[]);
    return { changes: r.count ?? 0 };
  }
  async exec(q: string) {
    await this.sql.unsafe(q).simple();
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.root) return fn(this);
    return (await (this.sql as unknown as { begin: (f: (s: PgSql) => Promise<T>) => Promise<T> }).begin((s) =>
      fn(new PostgresDb(s, false)),
    )) as T;
  }
  async close() {
    if (this.root) await this.sql.end({ timeout: 5 });
  }
  /**
   * Holds a transaction-scoped advisory lock for the whole run, so instances starting together (or
   * `beamhop migrate` during startup) don't apply the same migration twice. All pending migrations of
   * the namespace commit together.
   */
  override async migrate(namespace: string, migrations: Migration[]): Promise<void> {
    if (!this.root) return super.migrate(namespace, migrations);
    await this.tx(async (db) => {
      const tx = db as PostgresDb;
      // migrations (and waiting for another instance's) may legitimately outlast the statement timeout
      await tx.exec("SET LOCAL statement_timeout = 0");
      await tx.run("SELECT pg_advisory_xact_lock(hashtextextended('beamhop:migrate', 0))");
      await tx.exec(
        "CREATE TABLE IF NOT EXISTS _migrations (namespace TEXT NOT NULL, id TEXT NOT NULL, applied_at BIGINT NOT NULL, PRIMARY KEY (namespace, id))",
      );
      // tables created before applied_at was BIGINT (int4 overflows in 2038)
      const col = await tx.get<{ data_type: string }>(
        "SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '_migrations' AND column_name = 'applied_at'",
      );
      if (col?.data_type === "integer") await tx.exec("ALTER TABLE _migrations ALTER COLUMN applied_at TYPE BIGINT");
      await tx.runMigrations(namespace, migrations);
    });
  }
}

export async function createDb(config: Pick<BeamhopConfig, "database">): Promise<Db> {
  const { driver, sqlitePath, postgresUrl } = config.database;
  if (driver === "postgres") {
    if (!postgresUrl) throw new Error("database.postgresUrl is required for postgres driver");
    const { default: postgres } = await import("postgres");
    const sql = postgres(postgresUrl, {
      max: 20,
      onnotice: () => {},
      connection: {
        statement_timeout: PG_STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout: PG_IDLE_IN_TX_TIMEOUT_MS,
      },
      // int8 (COUNT(*), BIGINT timestamps, BIGSERIAL) → JS number instead of string
      types: { int8: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } },
    });
    return new PostgresDb(sql);
  }
  const d = await openSqlite(sqlitePath);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return new SqliteDb(d);
}

/** Convenience for tests: in-memory SQLite. */
export const createMemoryDb = () => createDb({ database: { driver: "sqlite", sqlitePath: ":memory:" } });
