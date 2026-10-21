// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Logical table dump / restore over the storage-sql executor (structural type,
 * so this package does not depend on storage-sql). Works on bun:sqlite, D1
 * (inside Workers) and Postgres.
 *
 * Derived tables are never dumped or written: `tags` and the FTS5 index are
 * rebuilt by triggers when `events` rows are inserted. The migrations ledger is
 * dumped (for compatibility checks) but never restored.
 */

export type Row = Record<string, unknown>;
export interface SqlQuery {
  sql: string;
  params: unknown[];
}

export interface SqlExecLike {
  readonly dialect: 'sqlite' | 'pg';
  readonly driver: string;
  all(q: SqlQuery): Promise<Row[]>;
  run(q: SqlQuery): Promise<number>;
  batch(stmts: Array<SqlQuery & { returning?: boolean }>): Promise<unknown[]>;
  readonly sync?: {
    all(q: SqlQuery): Row[];
    run(q: SqlQuery): number;
    transaction<T>(fn: () => T): T;
  };
}

export const MIGRATIONS_TABLE = '__beamhop_migrations';
/** Never restored (derived by triggers, or bookkeeping of the live schema). */
const NEVER_RESTORE = new Set(['tags', MIGRATIONS_TABLE, 'd1_migrations', 'sqlite_sequence']);

const q = (sql: string, params: unknown[] = []): SqlQuery => ({ sql, params });
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Base tables worth dumping, in a stable order (`events` first so triggers see it). */
export async function listTables(x: SqlExecLike): Promise<string[]> {
  let names: string[];
  if (x.dialect === 'pg') {
    const rows = await x.all(
      q(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
      ),
    );
    names = rows.map((r) => String(r.name));
  } else {
    const rows = await x.all(
      q("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"),
    );
    const virtual = rows
      .filter((r) => /^\s*CREATE\s+VIRTUAL/i.test(String(r.sql ?? '')))
      .map((r) => String(r.name));
    names = rows
      .map((r) => String(r.name))
      .filter(
        (n) =>
          !n.startsWith('sqlite_') &&
          !n.startsWith('_cf_') &&
          !virtual.includes(n) &&
          !virtual.some((v) => n.startsWith(`${v}_`)),
      );
  }
  names = names.filter((n) => n !== 'tags' && n !== 'd1_migrations');
  return names.sort((a, b) => (a === 'events' ? -1 : b === 'events' ? 1 : a.localeCompare(b)));
}

export async function tableColumns(x: SqlExecLike, table: string): Promise<string[]> {
  if (x.dialect === 'pg') {
    const rows = await x.all(
      q(
        `SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      ),
    );
    return rows.map((r) => String(r.name));
  }
  const rows = await x.all(q('SELECT name FROM pragma_table_info(?)', [table]));
  return rows.map((r) => String(r.name));
}

export async function countRows(x: SqlExecLike, table: string): Promise<number> {
  const rows = await x.all(q(`SELECT COUNT(*) AS n FROM ${ident(table)}`));
  return Number(rows[0]?.n ?? 0);
}

// ── value encoding (JSON-safe) ──

function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $bytes: toB64(v) };
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.getTime();
  return v;
}

export function decodeValue(v: unknown, dialect: 'sqlite' | 'pg'): unknown {
  if (v && typeof v === 'object') {
    const b = (v as { $bytes?: unknown }).$bytes;
    if (typeof b === 'string' && Object.keys(v).length === 1) return fromB64(b);
    // Postgres jsonb columns come back parsed; send them back as JSON text.
    return JSON.stringify(v);
  }
  if (typeof v === 'boolean' && dialect === 'sqlite') return v ? 1 : 0;
  return v;
}

export function encodeRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = encodeValue(v);
  return out;
}

export interface TableDump {
  table: string;
  rows: Row[];
}

/**
 * Read every table. On bun:sqlite the reads share one transaction, so the dump
 * is a consistent snapshot even while the relay keeps writing.
 */
export async function dumpTables(
  x: SqlExecLike,
  opts: { exclude?: string[] } = {},
): Promise<TableDump[]> {
  const tables = (await listTables(x)).filter((t) => !opts.exclude?.includes(t));
  const sync = x.sync;
  if (sync) {
    return sync.transaction(() =>
      tables.map((table) => ({
        table,
        rows: sync.all(q(`SELECT * FROM ${ident(table)}`)).map(encodeRow),
      })),
    );
  }
  const out: TableDump[] = [];
  for (const table of tables) {
    out.push({ table, rows: (await x.all(q(`SELECT * FROM ${ident(table)}`))).map(encodeRow) });
  }
  return out;
}

/** Where restored rows come from (NDJSON in the archive, or a SQLite snapshot file). */
export interface TableSource {
  tables(): string[];
  rows(table: string): Iterable<Row>;
}

export interface RestoreTablesResult {
  tables: Record<string, number>;
  skipped: string[];
}

/**
 * Replace the contents of every live table that the source has. Columns are
 * matched by name (columns added by later migrations keep their defaults).
 * bun:sqlite: one transaction. Other drivers: chunked batches (not atomic).
 */
export async function restoreTables(
  x: SqlExecLike,
  source: TableSource,
  opts: { exclude?: string[] } = {},
): Promise<RestoreTablesResult> {
  const live = new Set(await listTables(x));
  const plan: Array<{ table: string; cols: string[] }> = [];
  const skipped: string[] = [];
  for (const table of source.tables()) {
    if (NEVER_RESTORE.has(table) || opts.exclude?.includes(table)) continue;
    if (!live.has(table)) {
      skipped.push(table);
      continue;
    }
    plan.push({ table, cols: await tableColumns(x, table) });
  }
  plan.sort((a, b) =>
    a.table === 'events' ? -1 : b.table === 'events' ? 1 : a.table.localeCompare(b.table),
  );

  const statements = function* (): Generator<SqlQuery> {
    for (const { table, cols } of plan) {
      yield q(`DELETE FROM ${ident(table)}`);
      for (const row of source.rows(table)) {
        const names = cols.filter((c) => c in row);
        if (!names.length) continue;
        const ph = names.map((_, i) => (x.dialect === 'pg' ? `$${i + 1}` : '?')).join(', ');
        yield q(
          `INSERT INTO ${ident(table)} (${names.map(ident).join(', ')}) VALUES (${ph})`,
          names.map((c) => decodeValue(row[c], x.dialect)),
        );
      }
    }
  };

  const sync = x.sync;
  if (sync) {
    sync.transaction(() => {
      for (const s of statements()) sync.run(s);
    });
  } else {
    let chunk: SqlQuery[] = [];
    for (const s of statements()) {
      chunk.push(s);
      if (chunk.length >= 200) {
        await x.batch(chunk);
        chunk = [];
      }
    }
    if (chunk.length) await x.batch(chunk);
  }
  const tables: Record<string, number> = {};
  for (const { table } of plan) tables[table] = await countRows(x, table);
  return { tables, skipped };
}

/** Applied migration ids (`module/tag`) of the live schema. */
export async function appliedMigrations(x: SqlExecLike): Promise<string[]> {
  try {
    const rows = await x.all(q(`SELECT module, tag FROM ${MIGRATIONS_TABLE}`));
    return rows.map((r) => `${r.module}/${r.tag}`).sort();
  } catch {
    return [];
  }
}
