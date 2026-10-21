// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SQL EventStore (bun:sqlite, D1, Postgres).
 *
 * Write path: one conditional `INSERT … SELECT … WHERE NOT EXISTS(tombstone |
 * newer version) ON CONFLICT DO NOTHING`, plus (for replaceable/addressable)
 * one `DELETE … RETURNING` of older versions. Tag rows and the FTS index are
 * maintained by triggers, so a save is at most two statements, sent as one
 * atomic batch (D1/Postgres) or grouped with other saves into a single
 * transaction (bun:sqlite group commit). Status (`duplicate`/`deleted`/
 * `superseded`) is only classified when the insert did not happen.
 *
 * Read path: one indexed query per filter (per-filter `limit`, NIP-01 order),
 * all filters in one round trip, merged and deduplicated in memory. Event rows
 * carry their tags as JSON: no N+1.
 */
import {
  type EventStore,
  type Filter,
  type NostrEvent,
  type QueryOptions,
  type RelayId,
  type SaveResult,
  type StoreStats,
  addressOf,
  expirationOf,
  tagFilterEntries,
  tagValues,
} from '@beamhop/core';
import { type SQL, sql } from 'drizzle-orm';
import {
  type Prepared,
  type Query,
  type Row,
  type SqlExec,
  type Stmt,
  prepare,
} from './exec/types.ts';
import { chunk, inList, json, jsonValues, num, param, ph, truthy } from './sql-util.ts';

export interface GroupCommitOptions {
  /** Group concurrent saves into one transaction (sync drivers only). Default true. */
  enabled?: boolean;
  /** Flush when this many saves are queued. Default 512. */
  maxSize?: number;
  /** Wait this long for more saves before committing (0 = end of current tick). Default 0. */
  windowMs?: number;
}

export interface SqlEventStoreOptions {
  /** Per-filter cap when neither `filter.limit` nor `opts.maxLimit` is given. Default 5000. */
  defaultLimit?: number;
  /** Rows deleted per statement in bulk deletes (keeps D1 statements short). Default 2000. */
  deleteChunk?: number;
  groupCommit?: GroupCommitOptions;
  /** Called by `init()` (the factory passes a memoized `migrate()`). */
  ready?: () => Promise<void>;
  /** Unix seconds, for tombstone bookkeeping. */
  now?: () => number;
}

const COLS = sql.raw('id, pubkey, created_at, kind, tags, content, sig');
const ORDER = sql.raw('ORDER BY created_at DESC, id ASC');

function rowToEvent(r: Row): NostrEvent {
  return {
    id: r.id as string,
    pubkey: r.pubkey as string,
    created_at: num(r.created_at),
    kind: num(r.kind),
    tags: json<string[][]>(r.tags),
    content: r.content as string,
    sig: r.sig as string,
  };
}

export function sortEvents(a: NostrEvent, b: NostrEvent): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** NIP-50: plain terms only; `key:value` extensions are ignored. */
function searchTerms(search: string): string[] {
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !t.includes(':'));
}

interface Pending {
  relayId: RelayId;
  event: NostrEvent;
  resolve: (r: SaveResult) => void;
  reject: (e: unknown) => void;
}

interface Saves {
  insert: Prepared;
  insertAddr: Prepared;
  deleteOlder: Prepared;
  classify: Prepared;
  lock: Prepared;
}

export class SqlEventStore implements EventStore {
  readonly capabilities = { search: true, exactCount: true };
  private readonly defaultLimit: number;
  private readonly deleteChunk: number;
  private readonly now: () => number;
  private readonly groupCommit: Required<GroupCommitOptions>;
  private readonly s: Saves;
  private queue: Pending[] = [];
  private scheduled = false;

  constructor(
    private readonly x: SqlExec,
    private readonly opts: SqlEventStoreOptions = {},
  ) {
    this.defaultLimit = opts.defaultLimit ?? 5000;
    this.deleteChunk = opts.deleteChunk ?? 2000;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.groupCommit = {
      enabled: opts.groupCommit?.enabled ?? true,
      maxSize: opts.groupCommit?.maxSize ?? 512,
      windowMs: opts.groupCommit?.windowMs ?? 0,
    };
    this.s = this.compileSaves();
  }

  private get batching(): boolean {
    return this.groupCommit.enabled && this.x.sync !== undefined;
  }

  async init(): Promise<void> {
    await this.opts.ready?.();
  }

  // ───────────────────────────── write path ─────────────────────────────

  private compileSaves(): Saves {
    const x = this.x;
    const P = sql.placeholder;
    const pg = x.dialect === 'pg';
    const addrIdx = this.hint('events_relay_address_idx');
    const notTombstoned = sql`NOT EXISTS (SELECT 1 FROM tombstones WHERE relay_id = ${P('r')} AND type = 'e' AND target = ${P('id')} AND pubkey = ${P('pk')})
      AND NOT EXISTS (SELECT 1 FROM tombstones WHERE relay_id = ${P('r')} AND type = 'p' AND target = ${P('pk')} AND pubkey = ${P('pk')} AND until >= ${P('ca')})`;
    const addrOk = sql`NOT EXISTS (SELECT 1 FROM tombstones WHERE relay_id = ${P('r')} AND type = 'a' AND target = ${P('addr')} AND pubkey = ${P('pk')} AND until >= ${P('ca')})
      AND NOT EXISTS (SELECT 1 FROM events${addrIdx} WHERE relay_id = ${P('r')} AND address = ${P('addr')} AND (created_at > ${P('ca')} OR (created_at = ${P('ca')} AND id < ${P('id')})))`;
    const insert = (
      withAddr: boolean,
    ) => sql`INSERT INTO events (relay_id, id, pubkey, created_at, kind, tags, content, sig, address, expires_at)
      SELECT ${ph(x, 'r', 'text')}, ${ph(x, 'id', 'text')}, ${ph(x, 'pk', 'text')}, ${ph(x, 'ca', 'bigint')}, ${ph(x, 'k', 'bigint')},
        ${ph(x, 'tags', pg ? 'jsonb' : 'text')}, ${ph(x, 'content', 'text')}, ${ph(x, 'sig', 'text')}, ${ph(x, 'addr', 'text')}, ${ph(x, 'exp', 'bigint')}
      WHERE ${notTombstoned}${withAddr ? sql` AND ${addrOk}` : sql``}
      ON CONFLICT DO NOTHING`;
    return {
      insert: prepare(x, insert(false)),
      insertAddr: prepare(x, insert(true)),
      deleteOlder: prepare(
        x,
        sql`DELETE FROM events${addrIdx} WHERE relay_id = ${P('r')} AND address = ${P('addr')} AND id <> ${P('id')}
          AND (created_at < ${P('ca')} OR (created_at = ${P('ca')} AND id > ${P('id')}))
          AND EXISTS (SELECT 1 FROM events e2 WHERE e2.id = ${P('id')} AND e2.relay_id = ${P('r')})
          RETURNING id`,
      ),
      classify: prepare(
        x,
        sql`SELECT
          (SELECT COUNT(*) FROM events WHERE id = ${P('id')} AND relay_id = ${P('r')}) AS dup,
          (SELECT COUNT(*) FROM tombstones WHERE relay_id = ${P('r')} AND type = 'e' AND target = ${P('id')} AND pubkey = ${P('pk')}) AS tid,
          (SELECT COUNT(*) FROM tombstones WHERE relay_id = ${P('r')} AND type = 'p' AND target = ${P('pk')} AND pubkey = ${P('pk')} AND until >= ${P('ca')}) AS tp,
          (SELECT COUNT(*) FROM tombstones WHERE relay_id = ${P('r')} AND type = 'a' AND target = ${P('addr')} AND pubkey = ${P('pk')} AND until >= ${P('ca')}) AS ta`,
      ),
      lock: prepare(x, sql`SELECT pg_advisory_xact_lock(hashtextextended(${P('lockKey')}, 0))`),
    };
  }

  private values(relayId: RelayId, e: NostrEvent): Record<string, unknown> {
    const addr = addressOf(e) ?? null;
    return {
      r: relayId,
      id: e.id,
      pk: e.pubkey,
      ca: e.created_at,
      k: e.kind,
      tags: JSON.stringify(e.tags),
      content: e.content,
      sig: e.sig,
      addr,
      exp: expirationOf(e) ?? null,
      lockKey: `${relayId}\n${addr ?? ''}`,
    };
  }

  private classified(row: Row | undefined): SaveResult {
    if (row && truthy(row.dup)) return { status: 'duplicate' };
    if (row && (truthy(row.tid) || truthy(row.tp) || truthy(row.ta))) return { status: 'deleted' };
    return { status: 'superseded' };
  }

  private savedResult(replacedRows: Row[]): SaveResult {
    return replacedRows.length
      ? { status: 'saved', replaced: replacedRows.map((r) => r.id as string) }
      : { status: 'saved' };
  }

  save(relayId: RelayId, event: NostrEvent): Promise<SaveResult> {
    if (!this.batching) return this.saveAsync(relayId, event);
    return new Promise<SaveResult>((resolve, reject) => {
      this.queue.push({ relayId, event, resolve, reject });
      if (this.queue.length >= this.groupCommit.maxSize) {
        this.flush();
      } else if (!this.scheduled) {
        this.scheduled = true;
        if (this.groupCommit.windowMs > 0)
          setTimeout(() => this.flush(), this.groupCommit.windowMs);
        else queueMicrotask(() => this.flush());
      }
    });
  }

  /** Commit queued saves now (group commit). Called before every other operation. */
  flush(): void {
    this.scheduled = false;
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    const sync = this.x.sync!;
    let results: SaveResult[];
    try {
      results = sync.transaction(() => items.map((it) => this.saveSync(it.relayId, it.event)));
    } catch {
      // Isolate the failing save(s): retry one transaction per event.
      for (const it of items) {
        try {
          it.resolve(sync.transaction(() => this.saveSync(it.relayId, it.event)));
        } catch (err) {
          it.reject(err);
        }
      }
      return;
    }
    items.forEach((it, i) => it.resolve(results[i]!));
  }

  private saveSync(relayId: RelayId, e: NostrEvent): SaveResult {
    const sync = this.x.sync!;
    const v = this.values(relayId, e);
    const inserted = sync.run((v.addr ? this.s.insertAddr : this.s.insert).bind(v));
    if (inserted > 0) {
      if (!v.addr) return { status: 'saved' };
      return this.savedResult(sync.stmt({ ...this.s.deleteOlder.bind(v), returning: true }).rows);
    }
    return this.classified(sync.all(this.s.classify.bind(v))[0]);
  }

  private async saveAsync(relayId: RelayId, e: NostrEvent): Promise<SaveResult> {
    const v = this.values(relayId, e);
    const stmts: Stmt[] = [];
    const lockFirst = this.x.dialect === 'pg' && v.addr !== null;
    if (lockFirst) stmts.push({ ...this.s.lock.bind(v), returning: true });
    stmts.push((v.addr ? this.s.insertAddr : this.s.insert).bind(v));
    if (v.addr) stmts.push({ ...this.s.deleteOlder.bind(v), returning: true });
    const res = await this.x.batch(stmts);
    const ins = res[lockFirst ? 1 : 0]!;
    if (ins.changes > 0)
      return v.addr ? this.savedResult(res[res.length - 1]!.rows) : { status: 'saved' };
    return this.classified((await this.x.all(this.s.classify.bind(v)))[0]);
  }

  // ───────────────────────────── read path ─────────────────────────────

  /** SQLite index hint (`INDEXED BY`); Postgres plans from statistics. */
  private hint(index: string): SQL {
    return this.x.dialect === 'sqlite' ? sql.raw(` INDEXED BY ${index}`) : sql``;
  }

  /**
   * Deterministic plans on SQLite: a fresh database has no ANALYZE statistics
   * and every index starts with relay_id, so the planner cannot tell a
   * selective `authors` filter from a full scan. Pick the index by shape:
   * ids > tags (drive from the tag PK, then look up by id) > authors > kinds
   * > time (search-only filters walk time order, probing an FTS bloom filter).
   */
  private filterHint(f: Filter): SQL {
    if (this.x.dialect !== 'sqlite') return sql``;
    if (f.ids || tagFilterEntries(f).length) return this.hint('events_id_relay_uq');
    if (f.authors) return this.hint('events_relay_pubkey_created_idx');
    if (f.kinds) return this.hint('events_relay_kind_created_idx');
    return this.hint('events_relay_created_idx');
  }

  /** WHERE clause for a filter, or null when it can match nothing. */
  private where(relayId: RelayId, f: Filter): SQL | null {
    const x = this.x;
    const parts: SQL[] = [sql`relay_id = ${relayId}`];
    if (f.ids) {
      if (f.ids.length === 0) return null;
      parts.push(inList(x, 'id', f.ids));
    }
    if (f.authors) {
      if (f.authors.length === 0) return null;
      parts.push(inList(x, 'pubkey', f.authors));
    }
    if (f.kinds) {
      if (f.kinds.length === 0) return null;
      parts.push(inList(x, 'kind', f.kinds, 'int'));
    }
    if (f.since !== undefined) parts.push(sql`created_at >= ${f.since}`);
    if (f.until !== undefined) parts.push(sql`created_at <= ${f.until}`);
    for (const [name, values] of tagFilterEntries(f)) {
      if (values.length === 0) return null;
      const range = sql.join(
        [
          f.since !== undefined ? sql` AND created_at >= ${f.since}` : undefined,
          f.until !== undefined ? sql` AND created_at <= ${f.until}` : undefined,
        ].filter((s): s is SQL => s !== undefined),
      );
      parts.push(
        sql`id IN (SELECT event_id FROM tags WHERE relay_id = ${relayId} AND name = ${name} AND ${inList(x, 'value', values)}${range})`,
      );
    }
    if (f.search) {
      const s = this.searchCondition(f.search);
      if (s) parts.push(s);
    }
    return sql.join(parts, sql` AND `);
  }

  private searchCondition(search: string): SQL | null {
    const terms = searchTerms(search);
    if (this.x.dialect === 'pg') {
      const pieces = terms.flatMap((t) => t.split(/[^\p{L}\p{N}]+/u)).filter(Boolean);
      if (pieces.length === 0) return null;
      return sql`search @@ to_tsquery('simple', ${pieces.map((p) => `${p}:*`).join(' & ')})`;
    }
    if (terms.length === 0) return null;
    const q = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
    return sql`seq IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ${q})`;
  }

  private effectiveLimit(f: Filter, opts?: QueryOptions): number {
    if (f.limit === undefined && opts?.maxLimit === undefined) return this.defaultLimit;
    return Math.min(
      f.limit ?? Number.POSITIVE_INFINITY,
      opts?.maxLimit ?? Number.POSITIVE_INFINITY,
    );
  }

  async query(relayId: RelayId, filters: Filter[], opts?: QueryOptions): Promise<NostrEvent[]> {
    this.flushIfBatching();
    const qs: Query[] = [];
    for (const f of filters) {
      const limit = this.effectiveLimit(f, opts);
      if (limit <= 0) continue;
      const cond = this.where(relayId, f);
      if (!cond) continue;
      qs.push(
        this.x.compile(
          sql`SELECT ${COLS} FROM events${this.filterHint(f)} WHERE ${cond} ${ORDER} LIMIT ${limit}`,
        ),
      );
    }
    if (qs.length === 0) return [];
    opts?.signal?.throwIfAborted();
    const results = await this.x.readMany(qs);
    opts?.signal?.throwIfAborted();
    if (results.length === 1) return results[0]!.map(rowToEvent);
    const byId = new Map<string, NostrEvent>();
    for (const rows of results) {
      for (const r of rows) if (!byId.has(r.id as string)) byId.set(r.id as string, rowToEvent(r));
    }
    return [...byId.values()].sort(sortEvents);
  }

  async count(relayId: RelayId, filters: Filter[]): Promise<number> {
    this.flushIfBatching();
    const conds = filters
      .map((f) => {
        const c = this.where(relayId, f);
        return c ? sql`${this.filterHint(f)} WHERE ${c}` : null;
      })
      .filter((c): c is SQL => c !== null);
    if (conds.length === 0) return 0;
    if (conds.length === 1) {
      const rows = await this.x.all(
        this.x.compile(sql`SELECT COUNT(*) AS n FROM events${conds[0]}`),
      );
      return num(rows[0]?.n ?? 0);
    }
    const union = this.x.compile(
      sql`SELECT COUNT(*) AS n FROM (${sql.join(
        conds.map((c) => sql`SELECT seq FROM events${c}`),
        sql` UNION `,
      )}) AS u`,
    );
    if (union.params.length <= this.x.maxParams) {
      return num((await this.x.all(union))[0]?.n ?? 0);
    }
    // Too many bound parameters for one statement (D1): union in memory.
    const seqs = new Set<number>();
    const res = await this.x.readMany(
      conds.map((c) => this.x.compile(sql`SELECT seq FROM events${c}`)),
    );
    for (const rows of res) for (const r of rows) seqs.add(num(r.seq));
    return seqs.size;
  }

  async getById(relayId: RelayId, id: string): Promise<NostrEvent | null> {
    this.flushIfBatching();
    const rows = await this.x.all(
      this.x.compile(sql`SELECT ${COLS} FROM events WHERE id = ${id} AND relay_id = ${relayId}`),
    );
    return rows[0] ? rowToEvent(rows[0]) : null;
  }

  // ───────────────────────────── deletes ─────────────────────────────

  private upsertTombstone(
    relayId: RelayId,
    type: 'a' | 'p',
    target: string,
    pubkey: string,
    until: number,
  ): Stmt {
    const x = this.x;
    const greatest = sql.raw(x.dialect === 'pg' ? 'GREATEST' : 'max');
    return x.compile(
      sql`INSERT INTO tombstones (relay_id, type, target, pubkey, until, created_at)
        VALUES (${relayId}, ${type}, ${target}, ${pubkey}, ${param(x, until, 'bigint')}, ${param(x, this.now(), 'bigint')})
        ON CONFLICT (relay_id, type, target, pubkey) DO UPDATE SET until = ${greatest}(tombstones.until, excluded.until)`,
    );
  }

  async applyDeletion(relayId: RelayId, deletion: NostrEvent): Promise<string[]> {
    this.flushIfBatching();
    const x = this.x;
    const pk = deletion.pubkey;
    const ids = [...new Set(tagValues(deletion, 'e'))];
    const addrs = [...new Set(tagValues(deletion, 'a'))].filter((a) => a.split(':')[1] === pk);

    const existing = new Map<string, { pubkey: string; kind: number }>();
    if (ids.length) {
      const res = await x.readMany(
        chunk(ids, 1000).map((c) =>
          x.compile(
            sql`SELECT id, pubkey, kind FROM events WHERE relay_id = ${relayId} AND ${inList(x, 'id', c)}`,
          ),
        ),
      );
      for (const rows of res) {
        for (const r of rows) {
          existing.set(r.id as string, { pubkey: r.pubkey as string, kind: num(r.kind) });
        }
      }
    }
    // Only the author may delete; deletion requests themselves are not deletable.
    const tombIds = ids.filter((id) => {
      const e = existing.get(id);
      return !e || (e.pubkey === pk && e.kind !== 5);
    });

    const stmts: Stmt[] = [];
    const now = this.now();
    for (const c of chunk(tombIds, 1000)) {
      stmts.push(
        x.compile(
          sql`INSERT INTO tombstones (relay_id, type, target, pubkey, until, created_at)
            SELECT ${param(x, relayId, 'text')}, 'e', v.value, ${param(x, pk, 'text')}, 0, ${param(x, now, 'bigint')}
            FROM (${jsonValues(x, c)}) AS v WHERE true
            ON CONFLICT DO NOTHING`,
        ),
      );
      stmts.push({
        ...x.compile(
          sql`DELETE FROM events WHERE relay_id = ${relayId} AND pubkey = ${pk} AND kind <> 5
            AND id IN (${jsonValues(x, c)}) RETURNING id`,
        ),
        returning: true,
      });
    }
    for (const a of addrs) {
      stmts.push(this.upsertTombstone(relayId, 'a', a, pk, deletion.created_at));
      stmts.push({
        ...x.compile(
          sql`DELETE FROM events${this.hint('events_relay_address_idx')} WHERE relay_id = ${relayId} AND address = ${a}
            AND created_at <= ${deletion.created_at} RETURNING id`,
        ),
        returning: true,
      });
    }
    if (stmts.length === 0) return [];
    const res = await x.batch(stmts);
    const deleted = new Set<string>();
    for (const r of res) for (const row of r.rows) deleted.add(row.id as string);
    return [...deleted];
  }

  /** Delete matching events in bounded chunks (D1 CPU/time limits, WAL growth). */
  private async deleteWhere(cond: SQL, hint: SQL = sql``): Promise<number> {
    let total = 0;
    for (;;) {
      // RETURNING: driver "changes" may include rows touched by triggers.
      const [res] = await this.x.batch([
        {
          ...this.x.compile(
            sql`DELETE FROM events WHERE seq IN (SELECT seq FROM events${hint} WHERE ${cond} LIMIT ${this.deleteChunk}) RETURNING seq`,
          ),
          returning: true,
        },
      ]);
      const n = res?.rows.length ?? 0;
      total += n;
      if (n < this.deleteChunk) return total;
    }
  }

  async vanish(relayId: RelayId, pubkey: string, until: number): Promise<number> {
    this.flushIfBatching();
    await this.x.batch([this.upsertTombstone(relayId, 'p', pubkey, pubkey, until)]);
    return this.deleteWhere(
      sql`relay_id = ${relayId} AND pubkey = ${pubkey} AND created_at <= ${until}`,
      this.hint('events_relay_pubkey_created_idx'),
    );
  }

  async deleteByIds(
    relayId: RelayId,
    ids: string[],
    opts?: { tombstone?: boolean },
  ): Promise<number> {
    this.flushIfBatching();
    const x = this.x;
    const unique = [...new Set(ids)];
    if (unique.length === 0) return 0;
    const stmts: Stmt[] = [];
    const now = this.now();
    for (const c of chunk(unique, 1000)) {
      if (opts?.tombstone) {
        stmts.push(
          x.compile(
            sql`INSERT INTO tombstones (relay_id, type, target, pubkey, until, created_at)
              SELECT relay_id, 'e', id, pubkey, 0, ${param(x, now, 'bigint')} FROM events
              WHERE relay_id = ${relayId} AND id IN (${jsonValues(x, c)})
              ON CONFLICT DO NOTHING`,
          ),
        );
      }
      stmts.push({
        ...x.compile(
          sql`DELETE FROM events WHERE relay_id = ${relayId} AND id IN (${jsonValues(x, c)}) RETURNING seq`,
        ),
        returning: true,
      });
    }
    const res = await x.batch(stmts);
    let n = 0;
    res.forEach((r, i) => {
      if (!opts?.tombstone || i % 2 === 1) n += r.changes;
    });
    return n;
  }

  async deleteMatching(relayId: RelayId, filter: Filter): Promise<number> {
    this.flushIfBatching();
    const { limit: _limit, ...rest } = filter;
    const cond = this.where(relayId, rest as Filter);
    return cond ? this.deleteWhere(cond, this.filterHint(rest as Filter)) : 0;
  }

  async deleteExpired(now: number): Promise<number> {
    this.flushIfBatching();
    return this.deleteWhere(
      sql`expires_at IS NOT NULL AND expires_at <= ${now}`,
      this.hint('events_expires_idx'),
    );
  }

  async stats(relayId?: RelayId): Promise<StoreStats> {
    this.flushIfBatching();
    const size =
      this.x.dialect === 'pg'
        ? sql.raw('octet_length(content) + octet_length(tags::text)')
        : sql.raw('length(content) + length(tags)');
    const where = relayId === undefined ? sql`` : sql`WHERE relay_id = ${relayId}`;
    const rows = await this.x.all(
      this.x.compile(
        sql`SELECT COUNT(*) AS n, COALESCE(SUM(${size} + 290), 0) AS b, MIN(created_at) AS lo, MAX(created_at) AS hi FROM events ${where}`,
      ),
    );
    const r = rows[0] ?? {};
    return {
      events: num(r.n ?? 0),
      bytes: num(r.b ?? 0),
      oldest: r.lo === null || r.lo === undefined ? undefined : num(r.lo),
      newest: r.hi === null || r.hi === undefined ? undefined : num(r.hi),
    };
  }

  async close(): Promise<void> {
    this.flushIfBatching();
  }

  private flushIfBatching(): void {
    if (this.batching && this.queue.length) this.flush();
  }
}
