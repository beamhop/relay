// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cloudflare D1 executor. D1 has no interactive transactions: atomic work is
 * sent as one `batch()` (executed as a single implicit transaction, one round
 * trip). D1 caps bound parameters at 100 per statement, so list filters are
 * bound as a single JSON parameter (`json_each`) beyond a few values.
 */
import type { SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  Query,
  Row,
  SqlExec,
  Stmt,
  StmtResult,
} from './types.ts';

export const D1_MAX_PARAMS = 100;

export function d1Exec(d1: D1DatabaseLike): SqlExec {
  const dialect = new SQLiteAsyncDialect();
  const bind = (q: Query): D1PreparedStatementLike => {
    const p = d1.prepare(q.sql);
    return q.params.length ? p.bind(...q.params) : p;
  };
  return {
    dialect: 'sqlite',
    driver: 'd1',
    maxParams: D1_MAX_PARAMS,
    inlineListMax: 4,
    compile: (q: SQL): Query => dialect.sqlToQuery(q),
    all: async (q) => (await bind(q).all<Row>()).results ?? [],
    run: async (q) => (await bind(q).run()).meta.changes ?? 0,
    batch: async (stmts: Stmt[]): Promise<StmtResult[]> => {
      if (stmts.length === 0) return [];
      const res = await d1.batch<Row>(stmts.map(bind));
      return res.map((r, i) => {
        const rows = r.results ?? [];
        return { changes: stmts[i]?.returning ? rows.length : (r.meta.changes ?? 0), rows };
      });
    },
    readMany: async (qs) => {
      if (qs.length === 0) return [];
      if (qs.length === 1) return [(await bind(qs[0]!).all<Row>()).results ?? []];
      const res = await d1.batch<Row>(qs.map(bind));
      return res.map((r) => r.results ?? []);
    },
    close: async () => {},
  };
}
