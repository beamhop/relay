// SPDX-License-Identifier: AGPL-3.0-or-later
/** Dialect-aware SQL fragments built on Drizzle's `sql` template. */
import { type SQL, sql } from 'drizzle-orm';
import type { SqlExec } from './exec/types.ts';

export type PgType = 'text' | 'bigint' | 'jsonb' | 'float8';

/** A bound parameter; on Postgres explicitly cast (needed inside INSERT … SELECT). */
export function param(x: SqlExec, v: unknown, type: PgType): SQL {
  return x.dialect === 'pg' ? sql`${v}::${sql.raw(type)}` : sql`${v}`;
}

/** A placeholder (for statements compiled once), cast on Postgres. */
export function ph(x: SqlExec, name: string, type: PgType): SQL {
  const p = sql.placeholder(name);
  return x.dialect === 'pg' ? sql`${p}::${sql.raw(type)}` : sql`${p}`;
}

/**
 * Subquery yielding one `value` column from a list bound as ONE JSON parameter.
 * Keeps statements under D1's 100-parameter cap regardless of list size.
 */
export function jsonValues(x: SqlExec, values: ReadonlyArray<string | number>): SQL {
  const json = JSON.stringify(values);
  return x.dialect === 'pg'
    ? sql`SELECT jsonb_array_elements_text(${json}::jsonb) AS value`
    : sql`SELECT value FROM json_each(${json})`;
}

/** `col IN (…)` choosing inline parameters or a single JSON parameter. */
export function inList(
  x: SqlExec,
  col: string,
  values: ReadonlyArray<string | number>,
  type: 'text' | 'int' = 'text',
): SQL {
  const c = sql.raw(col);
  if (values.length === 1) return sql`${c} = ${values[0]}`;
  if (x.dialect === 'pg') {
    const json = JSON.stringify(values);
    return type === 'int'
      ? sql`${c} = ANY(ARRAY(SELECT (jsonb_array_elements_text(${json}::jsonb))::bigint))`
      : sql`${c} = ANY(ARRAY(SELECT jsonb_array_elements_text(${json}::jsonb)))`;
  }
  if (values.length <= x.inlineListMax) {
    return sql`${c} IN (${sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    )})`;
  }
  return sql`${c} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

export const truthy = (v: unknown): boolean => v === true || num(v) > 0;

/** Parse a JSON column (TEXT on SQLite, possibly pre-parsed jsonb on Postgres). */
export function json<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}
