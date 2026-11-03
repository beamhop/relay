import type { BeamhopConfig, Db, Dialect, Logger, Migration } from "@beamhop/sdk";
import { isBun, yieldToEventLoop } from "@beamhop/sdk";
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

/**
 * bun:sqlite binds non-Latin-1 strings as UTF-16, and SQLite reads a leading U+FEFF / U+FFFE there as a byte-order
 * mark: it is dropped (or flips the byte order), so content starting with one came back changed and no longer
 * matched its event id. SQLite consumes only one leading mark, so binding an extra U+FEFF stores the text as is.
 */
const keepLeadingBom = (p: unknown) => {
  if (typeof p !== "string") return p;
  const c = p.charCodeAt(0);
  return c === 0xfeff || c === 0xfffe ? `\ufeff${p}` : p;
};
const bunParams = (params: unknown[] = []) => params.map(keepLeadingBom);

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
      all: (sql, p) => stmt(sql).all(...(bunParams(p) as never[])),
      get: (sql, p) => stmt(sql).get(...(bunParams(p) as never[])) ?? undefined,
      // bun's `changes` is a total_changes() delta (includes trigger side effects); use changes() instead
      run: (sql, p) => {
        stmt(sql).run(...(bunParams(p) as never[]));
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
        // another process (a second instance, `beamhop migrate`) may have applied it since the read above; the
        // sqlite write lock taken by the transaction makes this re-check authoritative
        if (await db.get("SELECT 1 AS x FROM _migrations WHERE namespace = ? AND id = ?", [namespace, m.id])) return;
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

export interface SqliteOptions {
  /** warns (once per transaction) when a transaction is still open after this long; default 5 s */
  txWarnMs?: number;
  /**
   * rolls back a transaction still open after this long and rejects its tx() call; default 60 s. Statements the
   * abandoned transaction issues afterwards reject instead of running outside of it.
   */
  txTimeoutMs?: number;
  /** transactions running longer than this yield a macrotask turn after committing; default 20 ms */
  longTxMs?: number;
  /** close() waits at most this long for queued statements and the open transaction; default 3 s */
  closeWaitMs?: number;
  logger?: Logger;
}

/**
 * WAL pages written before a commit checkpoints (sqlite's default is 1000). A saved event dirties ~15 pages (table,
 * five indexes, tags, FTS), so the default checkpointed, with an fsync, every ~65 events: about half the cost of a
 * save. Checkpointing less often also writes each hot index page back once instead of many times. Measured on 6k
 * events, one transaction each: 167 → 95 µs per save.
 */
export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 10_000;
/** the WAL file is truncated back to this many bytes after a checkpoint (it otherwise keeps its largest size) */
const SQLITE_JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;

export const SQLITE_TX_WARN_MS = 5_000;
export const SQLITE_TX_TIMEOUT_MS = 60_000;
const SQLITE_LONG_TX_MS = 20;
const SQLITE_CLOSE_WAIT_MS = 3_000;

/** Rejection of a statement or tx() issued by a transaction the watchdog already rolled back. */
export class TxAbortedError extends Error {
  constructor(message = "sqlite transaction was rolled back by the watchdog (open too long)") {
    super(message);
    this.name = "TxAbortedError";
  }
}

/** Rejection of a statement issued after the database started closing (work that outlived shutdown). */
export class DbClosedError extends Error {
  constructor(message = "database is closed") {
    super(message);
    this.name = "DbClosedError";
  }
}

class SqliteDb extends BaseDb {
  readonly dialect = "sqlite" as const;
  private chain: Promise<unknown> = Promise.resolve();
  /** Identifies the transaction the current async context belongs to (for nesting). */
  private txContext = new AsyncLocalStorage<object>();
  /** Token of the transaction open on the (single) connection, if any. */
  private openTx: object | null = null;
  /** Tokens of transactions the watchdog rolled back: their late statements must not run outside of them. */
  private abandoned = new WeakSet<object>();
  /** set by close(): new work from outside the open transaction is refused, queued work still runs */
  private closing = false;
  private closed = false;
  constructor(
    private d: SqliteDriver,
    private opts: SqliteOptions = {},
  ) {
    super();
  }
  /**
   * There is one connection: a statement issued from outside the open transaction's async context
   * would run inside it (seeing uncommitted data, and being rolled back with it). Such statements
   * wait until the transaction finishes. Work started inside a transaction that outlives it (fire and
   * forget) keeps a stale token and is treated like any other outside caller, except for a transaction
   * the watchdog rolled back: its statements reject.
   */
  private op<T>(fn: () => T): Promise<T> {
    const ctx = this.txContext.getStore();
    if (ctx !== undefined && this.abandoned.has(ctx)) return Promise.reject(new TxAbortedError());
    if (this.closed || (this.closing && (ctx === undefined || ctx !== this.openTx))) return Promise.reject(new DbClosedError());
    if (this.openTx === null || ctx === this.openTx) {
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
  /**
   * Whether the caller runs in a transaction's async context (the open one, or one that finished or was rolled back
   * by the watchdog). Batching callers (see SqlEventStore.save) must not queue such work behind their own
   * transaction: the open one would wait for itself.
   */
  get inTxContext(): boolean {
    return this.txContext.getStore() !== undefined;
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
    const ctx = this.txContext.getStore();
    if (ctx !== undefined && this.abandoned.has(ctx)) return Promise.reject(new TxAbortedError());
    if (this.openTx !== null && ctx === this.openTx) return fn(this);
    if (this.closing || this.closed) return Promise.reject(new DbClosedError());
    const next = this.chain.then(() => this.runTx(fn));
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * One transaction on the connection. A watchdog bounds how long it may stay open: everything else on the
   * database waits for it, so a transaction awaiting something that never settles (a hung plugin, a network call)
   * would otherwise freeze the relay. After `txTimeoutMs` it is rolled back and the tx() call rejects.
   */
  private runTx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const token = {};
    const warnMs = this.opts.txWarnMs ?? SQLITE_TX_WARN_MS;
    const timeoutMs = this.opts.txTimeoutMs ?? SQLITE_TX_TIMEOUT_MS;
    const started = performance.now();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const warn = setTimeout(
        () => this.opts.logger?.warn("sqlite transaction still open", { ms: Math.round(performance.now() - started) }),
        warnMs,
      );
      const kill = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.abandoned.add(token);
        this.rollback();
        if (this.openTx === token) this.openTx = null;
        this.opts.logger?.error("sqlite transaction rolled back: open too long", { ms: timeoutMs });
        reject(new TxAbortedError(`sqlite transaction rolled back after ${timeoutMs} ms`));
      }, timeoutMs);
      (warn as { unref?: () => void }).unref?.();
      (kill as { unref?: () => void }).unref?.();
      const finish = () => {
        clearTimeout(warn);
        clearTimeout(kill);
        if (this.openTx === token) this.openTx = null;
      };
      void this.txContext.run(token, async () => {
        let result: T;
        try {
          this.d.exec("BEGIN IMMEDIATE");
          this.openTx = token;
          result = await fn(this);
          if (settled) return; // rolled back by the watchdog meanwhile
          this.d.exec("COMMIT");
        } catch (e) {
          if (settled) return;
          if (this.openTx === token) this.rollback();
          settled = true;
          finish();
          reject(e);
          return;
        }
        settled = true;
        finish();
        // a long transaction kept timers and sockets waiting: let them run before the next queued one starts
        if (performance.now() - started > (this.opts.longTxMs ?? SQLITE_LONG_TX_MS)) await yieldToEventLoop();
        resolve(result);
      });
    });
  }

  /** ROLLBACK that never replaces the error being handled (fails e.g. when the transaction is already gone). */
  private rollback() {
    try {
      this.d.exec("ROLLBACK");
    } catch (err) {
      this.opts.logger?.debug("sqlite ROLLBACK failed", { err: String(err) });
    }
  }
  /**
   * Refuses new work, lets what is already queued (and the open transaction) finish for up to `closeWaitMs`, then
   * closes the connection. Later calls reject with DbClosedError instead of a driver error.
   */
  async close() {
    if (this.closing) return;
    this.closing = true;
    const waitMs = this.opts.closeWaitMs ?? SQLITE_CLOSE_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      this.chain.then(() => true),
      new Promise<false>((r) => (timer = setTimeout(() => r(false), waitMs))),
    ]);
    clearTimeout(timer);
    if (!settled) this.opts.logger?.warn("closing the database with work still queued", { waitMs });
    if (this.openTx !== null) this.rollback();
    this.closed = true;
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
/** Longest wait (s) between reconnect attempts while the database is unreachable. */
export const PG_MAX_BACKOFF_S = 2;

/**
 * Whether a postgres.js error means the connection is gone (closed, reset, refused, or the server terminating the
 * session: SQLSTATE class 08 connection exception, 57P0x shutdown / admin termination).
 */
export function isConnectionLoss(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  return (
    code.startsWith("CONNECTION_") ||
    code === "CONNECT_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code.startsWith("08") ||
    /^57P0[1-3]$/.test(code)
  );
}

/** State of one postgres transaction (see PostgresDb.tx). */
interface PgTxState {
  /** the transaction's connection is gone: nothing may be sent for it any more */
  lost?: unknown;
  /** PoolEvents.closes when the transaction last checked it */
  closes: number;
}

/** Pool-wide events (postgres.js `onclose`), shared by a root PostgresDb and its transactions. */
interface PoolEvents {
  /** connections of the pool closed so far */
  closes: number;
}

/** A promise that never settles (and holds nothing: the chain parked on it is collected with it). */
const parked = <T>() => new Promise<T>(() => {});

class PostgresDb extends BaseDb {
  readonly dialect = "postgres" as const;
  constructor(
    private sql: PgSql,
    private pool: PoolEvents,
    private root = true,
    private txState?: PgTxState,
  ) {
    super();
  }
  /**
   * Runs one statement. Inside a transaction whose connection is lost, nothing more is sent and the call never
   * settles (see tx()).
   */
  private async stmt<T>(send: () => Promise<T>): Promise<T> {
    const st = this.txState;
    if (!st) return send();
    if (st.lost === undefined && st.closes !== this.pool.closes) {
      // a pool connection closed since the last statement, maybe this transaction's. begin() learns it synchronously
      // but rejects through promise jobs that may not have run yet: let them run first
      st.closes = this.pool.closes;
      await new Promise((r) => setImmediate(r));
    }
    if (st.lost !== undefined) return parked();
    try {
      return await send();
    } catch (err) {
      if (!isConnectionLoss(err)) throw err;
      st.lost = err;
      return parked();
    }
  }
  async all<T>(q: string, params?: unknown[]) {
    return this.stmt(async () => (await this.sql.unsafe(toPgPlaceholders(q), normalizeParams(params) as never[])) as unknown as T[]);
  }
  async get<T>(q: string, params?: unknown[]) {
    return (await this.all<T>(q, params))[0];
  }
  async run(q: string, params?: unknown[]) {
    const r = await this.stmt(() => this.sql.unsafe(toPgPlaceholders(q), normalizeParams(params) as never[]));
    return { changes: r.count ?? 0 };
  }
  async exec(q: string) {
    await this.stmt(() => this.sql.unsafe(q).simple());
  }
  /**
   * sql.begin(), made safe for a connection that dies mid transaction (database restart, failover, network cut).
   * begin() then rejects at once, but its callback keeps running: the callback's next statement and begin's own
   * ROLLBACK (sent when the callback settles) still go to that connection object. With its socket gone, postgres.js
   * throws inside a setImmediate, an uncaughtException that shut the whole relay down on a postgres restart; once
   * the pool has reconnected the object for another caller, they would run in that caller's session instead. So
   * once a statement of the transaction failed with a connection loss, or begin() rejected with one, its statements
   * send nothing and never settle: the callback stays parked (and is collected), and begin() never issues the
   * ROLLBACK. tx() itself rejects through begin().
   */
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.root) return fn(this);
    const state: PgTxState = { closes: this.pool.closes };
    try {
      return (await (this.sql as unknown as { begin: (f: (s: PgSql) => Promise<T>) => Promise<T> }).begin((s) =>
        fn(new PostgresDb(s, this.pool, false, state)),
      )) as T;
    } catch (err) {
      if (isConnectionLoss(err)) state.lost ??= err;
      throw err;
    }
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

export async function createDb(config: Pick<BeamhopConfig, "database">, sqliteOpts: SqliteOptions = {}): Promise<Db> {
  const { driver, sqlitePath, postgresUrl } = config.database;
  if (driver === "postgres") {
    if (!postgresUrl) throw new Error("database.postgresUrl is required for postgres driver");
    const { default: postgres } = await import("postgres");
    const pool: PoolEvents = { closes: 0 };
    const sql = postgres(postgresUrl, {
      max: 20,
      onnotice: () => {},
      onclose: () => void pool.closes++,
      // reconnect delay after failed attempts: postgres.js grows it to 20 s, which kept writes stalled that long after
      // the database came back from a restart
      backoff: (attempts: number) => (0.5 + Math.random() / 2) * Math.min(3 ** attempts / 100, PG_MAX_BACKOFF_S),
      connection: {
        statement_timeout: PG_STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout: PG_IDLE_IN_TX_TIMEOUT_MS,
      },
      // int8 (COUNT(*), BIGINT timestamps, BIGSERIAL) → JS number instead of string
      types: { int8: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } },
    });
    return new PostgresDb(sql, pool);
  }
  const d = await openSqlite(sqlitePath);
  d.exec(
    `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}; PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT};`,
  );
  return new SqliteDb(d, sqliteOpts);
}

/** Convenience for tests: in-memory SQLite. */
export const createMemoryDb = (opts: SqliteOptions = {}) => createDb({ database: { driver: "sqlite", sqlitePath: ":memory:" } }, opts);
