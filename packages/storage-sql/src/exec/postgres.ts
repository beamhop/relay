// SPDX-License-Identifier: AGPL-3.0-or-later
/** Postgres executor over the `postgres` (postgres.js) driver. */
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import type { Query, Row, SqlExec, Stmt, StmtResult } from './types.ts';

export type PgClient = postgres.Sql;
type Params = postgres.ParameterOrJSON<never>[];

export interface PostgresExecOptions {
  /** End the client on `close()` (true when the factory created it). */
  owned?: boolean;
}

export function postgresExec(client: PgClient, opts: PostgresExecOptions = {}): SqlExec {
  const dialect = new PgDialect();
  const exec = async (c: PgClient | postgres.TransactionSql, s: Stmt): Promise<StmtResult> => {
    const res = await c.unsafe(s.sql, s.params as Params);
    const rows = [...res] as Row[];
    return { changes: s.returning ? rows.length : (res.count ?? 0), rows };
  };
  return {
    dialect: 'pg',
    driver: 'postgres',
    maxParams: 65534,
    inlineListMax: 0,
    compile: (q: SQL): Query => dialect.sqlToQuery(q),
    all: async (q) => (await exec(client, { ...q, returning: true })).rows,
    run: async (q) => (await exec(client, q)).changes,
    batch: async (stmts) => {
      if (stmts.length === 0) return [];
      if (stmts.length === 1) return [await exec(client, stmts[0]!)];
      const out: StmtResult[] = [];
      await client.begin(async (tx) => {
        for (const s of stmts) out.push(await exec(tx, s));
      });
      return out;
    },
    readMany: (qs) => Promise.all(qs.map(async (q) => (await exec(client, q)).rows)),
    close: async () => {
      if (opts.owned) await client.end({ timeout: 5 });
    },
  };
}
