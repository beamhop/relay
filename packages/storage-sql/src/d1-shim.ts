// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * D1-compatible shim over bun:sqlite, for running D1 code paths in CI without
 * Cloudflare. Mirrors the D1 client API (`prepare/bind/first/all/run/raw/batch/exec`)
 * and enforces D1 behaviours that bite in production:
 * - max 100 bound parameters per statement,
 * - no `BEGIN`/`COMMIT`/`SAVEPOINT` (use `batch()`, which is atomic),
 * - `undefined` / bigint / object bindings rejected; booleans bound as 0/1,
 * - `first(col)` throws on a missing column.
 * Bun-only (imports bun:sqlite); exported as `@beamhop/storage-sql/d1-shim`.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike, Row } from './exec/types.ts';

export interface D1ShimOptions {
  maxParams?: number;
}

const TX_RE = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const READ_RE = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/i;

class D1Error extends Error {
  constructor(msg: string) {
    super(`D1_ERROR: ${msg}`);
    this.name = 'D1Error';
  }
}

function convert(v: unknown): SQLQueryBindings {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new D1Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value '${String(v)}'`);
}

export class D1ShimStatement implements D1PreparedStatementLike {
  constructor(
    private readonly shim: D1Shim,
    readonly query: string,
    readonly params: SQLQueryBindings[] = [],
  ) {
    if (TX_RE.test(query)) {
      throw new D1Error(
        'To execute a transaction, please use the state.storage.transaction() or db.batch() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.',
      );
    }
  }

  bind(...values: unknown[]): D1ShimStatement {
    return new D1ShimStatement(this.shim, this.query, values.map(convert));
  }

  /** Execute and return a D1Result. */
  execute(): D1ResultLike<Row> {
    return this.shim.execute(this.query, this.params);
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = this.execute().results[0];
    if (!row) return null;
    if (colName === undefined) return row as T;
    if (!(colName in row)) throw new D1Error(`D1_COLUMN_NOTFOUND: Column not found (${colName})`);
    return row[colName] as T;
  }

  async all<T = Row>(): Promise<D1ResultLike<T>> {
    return this.execute() as unknown as D1ResultLike<T>;
  }

  async run<T = Row>(): Promise<D1ResultLike<T>> {
    return this.execute() as unknown as D1ResultLike<T>;
  }

  async raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const st = this.shim.db.prepare(this.query);
    try {
      const rows = st.values(...this.params) as unknown[][];
      const out = opts?.columnNames ? [st.columnNames as unknown[], ...rows] : rows;
      return out as T[];
    } finally {
      st.finalize();
    }
  }
}

export class D1Shim implements D1DatabaseLike {
  readonly maxParams: number;
  /** Statements executed (for tests asserting round trips). */
  statements = 0;
  batches = 0;

  constructor(
    readonly db: Database = new Database(':memory:'),
    opts: D1ShimOptions = {},
  ) {
    this.maxParams = opts.maxParams ?? 100;
    // D1 enforces foreign keys.
    db.run('PRAGMA foreign_keys = ON');
  }

  prepare(query: string): D1ShimStatement {
    return new D1ShimStatement(this, query);
  }

  execute(query: string, params: SQLQueryBindings[]): D1ResultLike<Row> {
    if (params.length > this.maxParams) {
      throw new D1Error(`too many SQL variables at offset 0: SQLITE_ERROR (${params.length})`);
    }
    this.statements++;
    const started = performance.now();
    const st = this.db.prepare(query);
    try {
      let results: Row[] = [];
      let changes = 0;
      let lastRowId = 0;
      if (st.columnNames.length > 0) {
        results = st.all(...params) as Row[];
        if (!READ_RE.test(query)) {
          // DML … RETURNING: report its own change count.
          changes = (this.db.query('SELECT changes() AS c').get() as { c: number }).c;
        }
      } else {
        const r = st.run(...params);
        changes = r.changes;
        lastRowId = Number(r.lastInsertRowid);
      }
      return {
        results,
        success: true,
        meta: {
          changes,
          last_row_id: lastRowId,
          changed_db: changes > 0,
          duration: performance.now() - started,
          rows_read: results.length,
          rows_written: changes,
        },
      };
    } finally {
      st.finalize();
    }
  }

  async batch<T = Row>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    this.batches++;
    const stmts = statements.map((s) => {
      if (!(s instanceof D1ShimStatement))
        throw new D1Error('batch() needs statements from this database');
      return s;
    });
    return this.db.transaction(() =>
      stmts.map((s) => s.execute()),
    )() as unknown as D1ResultLike<T>[];
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    const lines = query
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const l of lines) this.db.run(l);
    return { count: lines.length, duration: performance.now() - started };
  }
}
