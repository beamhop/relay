// SPDX-License-Identifier: AGPL-3.0-or-later
/** SQL DocStore: JSON documents keyed by (collection, key). */
import type { DocStore } from '@beamhop/core';
import { type SQL, sql } from 'drizzle-orm';
import { type Prepared, type Query, type SqlExec, prepare } from './exec/types.ts';
import type { GroupCommitter } from './group-commit.ts';
import { ph } from './sql-util.ts';

/** Greater than any valid string with the same prefix (bytewise / "C" collation). */
const MAX_CHAR = '\u{10FFFF}';

export interface SqlDocStoreOptions {
  ready?: () => Promise<void>;
  nowMs?: () => number;
  /**
   * Group committer shared with the event store (sync drivers): writes queued in
   * the same tick share one transaction; reads commit queued writes first.
   */
  committer?: GroupCommitter | null;
}

interface DocStatements {
  get: Prepared;
  put: Prepared;
  insertNew: Prepared;
  update: Prepared;
  delete: Prepared;
}

export class SqlDocStore implements DocStore {
  private readonly committer: GroupCommitter | null;
  /** Doc writes queued in the committer (reads commit them first; event saves need not). */
  private queued = 0;
  private stmts: DocStatements | null = null;

  constructor(
    private readonly x: SqlExec,
    private readonly opts: SqlDocStoreOptions = {},
  ) {
    this.committer = x.sync && opts.committer ? opts.committer : null;
  }

  /** Statements compiled once (placeholders bound per call). */
  private get s(): DocStatements {
    if (this.stmts) return this.stmts;
    const P = sql.placeholder;
    const v = (name: string) => ph(this.x, name, 'jsonb');
    this.stmts = {
      get: prepare(
        this.x,
        sql`SELECT ${this.valueText} AS value FROM docs WHERE collection = ${P('c')} AND key = ${P('k')}`,
      ),
      put: prepare(
        this.x,
        sql`INSERT INTO docs (collection, key, value, updated_at)
          VALUES (${P('c')}, ${P('k')}, ${v('v')}, ${P('t')})
          ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ),
      insertNew: prepare(
        this.x,
        sql`INSERT INTO docs (collection, key, value, updated_at)
          VALUES (${P('c')}, ${P('k')}, ${v('v')}, ${P('t')})
          ON CONFLICT (collection, key) DO NOTHING`,
      ),
      update: prepare(
        this.x,
        sql`UPDATE docs SET value = ${v('v')}, updated_at = ${P('t')}
          WHERE collection = ${P('c')} AND key = ${P('k')} AND value = ${v('e')}`,
      ),
      delete: prepare(
        this.x,
        sql`DELETE FROM docs WHERE collection = ${P('c')} AND key = ${P('k')}`,
      ),
    };
    return this.stmts;
  }

  /** Run a write: grouped into the shared transaction when there is a committer. */
  private write(q: Query): Promise<number> {
    const c = this.committer;
    if (!c) return this.x.run(q);
    const sync = this.x.sync!;
    this.queued++;
    return c
      .enqueue(() => sync.run(q))
      .finally(() => {
        this.queued--;
      });
  }

  /** Commit queued doc writes before a read (read-your-writes even before they resolve). */
  private settle(): void {
    if (this.queued > 0) this.committer?.flush();
  }

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

  async get<T = unknown>(collection: string, key: string): Promise<T | null> {
    this.settle();
    const rows = await this.x.all(this.s.get.bind({ c: collection, k: key }));
    const v = rows[0]?.value;
    return v === undefined ? null : (JSON.parse(v as string) as T);
  }

  async put<T = unknown>(collection: string, key: string, value: T): Promise<void> {
    const v = JSON.stringify(value ?? null);
    await this.write(this.s.put.bind({ c: collection, k: key, v, t: this.now() }));
  }

  async delete(collection: string, key: string): Promise<boolean> {
    return (await this.write(this.s.delete.bind({ c: collection, k: key }))) > 0;
  }

  async list<T = unknown>(
    collection: string,
    opts?: { prefix?: string; cursor?: string; limit?: number; reverse?: boolean },
  ): Promise<{ items: Array<{ key: string; value: T }>; cursor?: string }> {
    this.settle();
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
    const t = this.now();
    const v = JSON.stringify(next ?? null);
    if (expected === null)
      return (await this.write(this.s.insertNew.bind({ c: collection, k: key, v, t }))) > 0;
    const e = JSON.stringify(expected ?? null);
    return (await this.write(this.s.update.bind({ c: collection, k: key, v, e, t }))) > 0;
  }
}
