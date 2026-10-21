// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin execution layer under the stores. Queries are written once with
 * Drizzle's `sql` template and compiled by the Drizzle dialect of the driver
 * (`?` for SQLite/D1, `$n` for Postgres); drivers only execute compiled text.
 */
import { type SQL, fillPlaceholders } from 'drizzle-orm';

export type Row = Record<string, unknown>;
export type Dialect = 'sqlite' | 'pg';
export type DriverName = 'sqlite' | 'd1' | 'postgres';

export interface Query {
  sql: string;
  params: unknown[];
}

export interface Stmt extends Query {
  /** Statement returns rows (SELECT or `RETURNING`). */
  returning?: boolean;
}

export interface StmtResult {
  changes: number;
  rows: Row[];
}

/** Synchronous access for in-process drivers (bun:sqlite) — enables group commit. */
export interface SyncExec {
  all(q: Query): Row[];
  run(q: Query): number;
  stmt(s: Stmt): StmtResult;
  transaction<T>(fn: () => T): T;
}

export interface SqlExec {
  readonly dialect: Dialect;
  readonly driver: DriverName;
  /** Max bound parameters per statement (D1: 100). */
  readonly maxParams: number;
  /** Lists longer than this are bound as one JSON parameter instead of `IN (?, ?, …)`. */
  readonly inlineListMax: number;
  compile(q: SQL): Query;
  all(q: Query): Promise<Row[]>;
  run(q: Query): Promise<number>;
  /** Execute statements atomically (transaction, or D1 batch). */
  batch(stmts: Stmt[]): Promise<StmtResult[]>;
  /** Several reads, in one round trip where the driver allows it. */
  readMany(qs: Query[]): Promise<Row[][]>;
  readonly sync?: SyncExec;
  close(): Promise<void>;
}

/** A statement compiled once with `sql.placeholder()`s, bound per call. */
export interface Prepared {
  bind(values: Record<string, unknown>): Query;
}

export function prepare(exec: SqlExec, q: SQL): Prepared {
  const compiled = exec.compile(q);
  return {
    bind: (values) => ({ sql: compiled.sql, params: fillPlaceholders(compiled.params, values) }),
  };
}

// ── Minimal structural D1 types (avoid a hard dependency on workers-types) ──

export interface D1ResultLike<T = Row> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number; [k: string]: unknown };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Row>(colName?: string): Promise<T | null>;
  all<T = Row>(): Promise<D1ResultLike<T>>;
  run<T = Row>(): Promise<D1ResultLike<T>>;
  raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = Row>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}
