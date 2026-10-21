// SPDX-License-Identifier: AGPL-3.0-or-later
/** SQL DocStore: JSON documents keyed by (collection, key). */
import type { DocStore } from '@beamhop/core';
import { type SQL, sql } from 'drizzle-orm';
import type { SqlExec } from './exec/types.ts';
import { param } from './sql-util.ts';

/** Greater than any valid string with the same prefix (bytewise / "C" collation). */
const MAX_CHAR = '\u{10FFFF}';

export class SqlDocStore implements DocStore {
  constructor(
    private readonly x: SqlExec,
    private readonly opts: { ready?: () => Promise<void>; nowMs?: () => number } = {},
  ) {}

  async init(): Promise<void> {
    await this.opts.ready?.();
  }

  private now(): number {
    return this.opts.nowMs?.() ?? Date.now();
  }

  /** Value column as JSON text on every dialect (Postgres stores jsonb). */
  private get valueText(): SQL {
    return sql.raw(this.x.dialect === 'pg' ? 'value::text' : 'value');
  }

  private jsonParam(value: unknown): SQL {
    return param(this.x, JSON.stringify(value ?? null), 'jsonb');
  }

  async get<T = unknown>(collection: string, key: string): Promise<T | null> {
    const rows = await this.x.all(
      this.x.compile(
        sql`SELECT ${this.valueText} AS value FROM docs WHERE collection = ${collection} AND key = ${key}`,
      ),
    );
    const v = rows[0]?.value;
    return v === undefined ? null : (JSON.parse(v as string) as T);
  }

  async put<T = unknown>(collection: string, key: string, value: T): Promise<void> {
    await this.x.run(
      this.x.compile(
        sql`INSERT INTO docs (collection, key, value, updated_at)
          VALUES (${collection}, ${key}, ${this.jsonParam(value)}, ${this.now()})
          ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ),
    );
  }

  async delete(collection: string, key: string): Promise<boolean> {
    const n = await this.x.run(
      this.x.compile(sql`DELETE FROM docs WHERE collection = ${collection} AND key = ${key}`),
    );
    return n > 0;
  }

  async list<T = unknown>(
    collection: string,
    opts?: { prefix?: string; cursor?: string; limit?: number; reverse?: boolean },
  ): Promise<{ items: Array<{ key: string; value: T }>; cursor?: string }> {
    const limit = Math.max(0, opts?.limit ?? 100);
    const parts: SQL[] = [sql`collection = ${collection}`];
    if (opts?.prefix) {
      parts.push(sql`key >= ${opts.prefix}`, sql`key < ${opts.prefix + MAX_CHAR}`);
    }
    if (opts?.cursor !== undefined) {
      parts.push(opts.reverse ? sql`key < ${opts.cursor}` : sql`key > ${opts.cursor}`);
    }
    const dir = sql.raw(opts?.reverse ? 'DESC' : 'ASC');
    const rows = await this.x.all(
      this.x.compile(
        sql`SELECT key, ${this.valueText} AS value FROM docs WHERE ${sql.join(parts, sql` AND `)}
          ORDER BY key ${dir} LIMIT ${limit + 1}`,
      ),
    );
    const page = rows.slice(0, limit);
    const items = page.map((r) => ({
      key: r.key as string,
      value: JSON.parse(r.value as string) as T,
    }));
    const last = items[items.length - 1];
    return { items, cursor: rows.length > limit && last ? last.key : undefined };
  }

  async cas<T = unknown>(
    collection: string,
    key: string,
    expected: T | null,
    next: T,
  ): Promise<boolean> {
    const x = this.x;
    if (expected === null) {
      const n = await x.run(
        x.compile(
          sql`INSERT INTO docs (collection, key, value, updated_at)
            VALUES (${collection}, ${key}, ${this.jsonParam(next)}, ${this.now()})
            ON CONFLICT (collection, key) DO NOTHING`,
        ),
      );
      return n > 0;
    }
    const n = await x.run(
      x.compile(
        sql`UPDATE docs SET value = ${this.jsonParam(next)}, updated_at = ${this.now()}
          WHERE collection = ${collection} AND key = ${key} AND value = ${this.jsonParam(expected)}`,
      ),
    );
    return n > 0;
  }
}
