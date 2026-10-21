// SPDX-License-Identifier: AGPL-3.0-or-later
/** SQL TimeSeriesStore: raw points, bucketed + aggregated in SQL at read time. */
import type { MetricPoint, TimeSeriesStore } from '@beamhop/core';
import { type SQL, sql } from 'drizzle-orm';
import type { SqlExec, Stmt } from './exec/types.ts';
import { chunk, num } from './sql-util.ts';

type RangeQuery = Parameters<TimeSeriesStore['range']>[0];

/** Canonical label JSON (sorted keys) so equal label sets compare equal. */
export function canonicalLabels(labels: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const k of Object.keys(labels).sort()) out[k] = labels[k] as string;
  return JSON.stringify(out);
}

const AGG: Record<Exclude<RangeQuery['agg'], 'last'>, string> = {
  sum: 'SUM',
  avg: 'AVG',
  max: 'MAX',
  min: 'MIN',
};

export class SqlTimeSeries implements TimeSeriesStore {
  constructor(
    private readonly x: SqlExec,
    private readonly opts: { ready?: () => Promise<void>; recordChunk?: number } = {},
  ) {}

  async init(): Promise<void> {
    await this.opts.ready?.();
  }

  async record(points: MetricPoint[]): Promise<void> {
    if (points.length === 0) return;
    const x = this.x;
    // Each chunk is ONE statement with ONE JSON parameter (D1-safe).
    const stmts: Stmt[] = chunk(points, this.opts.recordChunk ?? 500).map((c) => {
      const payload = JSON.stringify(c.map((p) => [p.metric, canonicalLabels(p.labels), p.t, p.v]));
      return x.compile(
        x.dialect === 'pg'
          ? sql`INSERT INTO metrics (metric, labels, t, v)
              SELECT p->>0, (p->>1)::jsonb, (p->>2)::bigint, (p->>3)::float8
              FROM jsonb_array_elements(${payload}::jsonb) AS p`
          : sql`INSERT INTO metrics (metric, labels, t, v)
              SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                CAST(json_extract(value, '$[2]') AS INTEGER), json_extract(value, '$[3]')
              FROM json_each(${payload})`,
      );
    });
    await x.batch(stmts);
  }

  async range(q: RangeQuery): Promise<Array<{ t: number; v: number }>> {
    const x = this.x;
    const step = sql.raw(String(Math.max(1, Math.floor(q.stepSeconds))));
    const parts: SQL[] = [sql`metric = ${q.metric}`, sql`t >= ${q.from}`, sql`t <= ${q.to}`];
    if (q.labels && Object.keys(q.labels).length) {
      if (x.dialect === 'pg') {
        parts.push(sql`labels @> ${JSON.stringify(q.labels)}::jsonb`);
      } else {
        for (const [k, v] of Object.entries(q.labels)) {
          parts.push(sql`json_extract(labels, ${`$."${k.replace(/"/g, '\\"')}"`}) = ${v}`);
        }
      }
    }
    const where = sql.join(parts, sql` AND `);
    const bucket = sql`(t / ${step}) * ${step}`;
    const query =
      q.agg === 'last'
        ? sql`SELECT b, v FROM (
            SELECT ${bucket} AS b, v, ROW_NUMBER() OVER (PARTITION BY ${bucket} ORDER BY t DESC, seq DESC) AS rn
            FROM metrics WHERE ${where}) AS x WHERE rn = 1 ORDER BY b`
        : sql`SELECT ${bucket} AS b, ${sql.raw(AGG[q.agg])}(v) AS v FROM metrics WHERE ${where}
            GROUP BY ${bucket} ORDER BY b`;
    const rows = await x.all(x.compile(query));
    return rows.map((r) => ({ t: num(r.b), v: num(r.v) }));
  }

  async prune(before: number): Promise<number> {
    return this.x.run(this.x.compile(sql`DELETE FROM metrics WHERE t < ${before}`));
  }
}
