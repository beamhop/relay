// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * bun:sqlite executor. Only the *type* of `Database` is imported, so this file
 * stays importable from runtime-agnostic code; the factory constructs the
 * Database lazily on Bun.
 */
import type { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import type { SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { Query, Row, SqlExec, Stmt, StmtResult, SyncExec } from './types.ts';

/** Tuned for a single-writer relay ingesting thousands of events per second. */
export const DEFAULT_SQLITE_PRAGMAS: Record<string, string | number> = {
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  temp_store: 'MEMORY',
  cache_size: -65536, // 64 MiB
  mmap_size: 268435456, // 256 MiB
  busy_timeout: 5000,
  wal_autocheckpoint: 1000,
  journal_size_limit: 67108864,
  foreign_keys: 'OFF',
};

export interface BunSqliteExecOptions {
  pragmas?: Record<string, string | number>;
  /** Prepared-statement cache size (dynamic filter SQL varies). */
  statementCache?: number;
  /** Close the Database on `close()` (true when the factory opened it). */
  owned?: boolean;
}

type Bindings = SQLQueryBindings[];

export function bunSqliteExec(db: Database, opts: BunSqliteExecOptions = {}): SqlExec {
  const pragmas = { ...DEFAULT_SQLITE_PRAGMAS, ...opts.pragmas };
  for (const [k, v] of Object.entries(pragmas)) db.run(`PRAGMA ${k} = ${v}`);
  try {
    db.run('PRAGMA optimize = 0x10002');
  } catch {
    // Older SQLite without the 0x10000 flag: harmless.
  }

  const dialect = new SQLiteSyncDialect();
  const cacheMax = opts.statementCache ?? 512;
  const cache = new Map<string, Statement>();
  const stmtFor = (sql: string): Statement => {
    let s = cache.get(sql);
    if (s) {
      // LRU touch.
      cache.delete(sql);
      cache.set(sql, s);
      return s;
    }
    s = db.prepare(sql);
    cache.set(sql, s);
    if (cache.size > cacheMax) {
      const oldest = cache.keys().next().value as string;
      cache.get(oldest)?.finalize();
      cache.delete(oldest);
    }
    return s;
  };

  const sync: SyncExec = {
    all: (q) => stmtFor(q.sql).all(...(q.params as Bindings)) as Row[],
    run: (q) => stmtFor(q.sql).run(...(q.params as Bindings)).changes,
    stmt: (s: Stmt): StmtResult => {
      const st = stmtFor(s.sql);
      if (s.returning) {
        const rows = st.all(...(s.params as Bindings)) as Row[];
        return { changes: rows.length, rows };
      }
      return { changes: st.run(...(s.params as Bindings)).changes, rows: [] };
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };

  let closed = false;
  return {
    dialect: 'sqlite',
    driver: 'sqlite',
    maxParams: 32766,
    inlineListMax: 256,
    compile: (q: SQL): Query => dialect.sqlToQuery(q),
    all: async (q) => sync.all(q),
    run: async (q) => sync.run(q),
    batch: async (stmts) => sync.transaction(() => stmts.map((s) => sync.stmt(s))),
    readMany: async (qs) => qs.map((q) => sync.all(q)),
    sync,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        db.run('PRAGMA optimize');
      } catch {
        // ignore
      }
      for (const s of cache.values()) s.finalize();
      cache.clear();
      if (opts.owned) db.close();
    },
  };
}
