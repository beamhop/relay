/**
 * SQLite-backed event store (opt-in persistence via bun:sqlite).
 * Implements the same EventStore contract and storage semantics as the
 * in-memory store. Filter matching reuses matchFilter for parity.
 */
import { Database } from "bun:sqlite";
import { compileFilter, matchCompiled } from "../filter.ts";
import type { Filter, NostrEvent } from "../types.ts";
import {
  type AddResult,
  type EventStore,
  dTag,
  replaces,
  sortNewestFirst,
  storageClass,
} from "./store.ts";

interface Row {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string;
  content: string;
  sig: string;
}

export class SqliteEventStore implements EventStore {
  private db: Database;

  /** @param path file path, or ":memory:" for an ephemeral database. */
  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY,
        pubkey      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        kind        INTEGER NOT NULL,
        tags        TEXT NOT NULL,
        content     TEXT NOT NULL,
        sig         TEXT NOT NULL,
        repl_key    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_repl ON events(repl_key) WHERE repl_key IS NOT NULL;
    `);
  }

  add(event: NostrEvent): AddResult {
    if (this.getById(event.id)) return { stored: false, duplicate: true };

    const cls = storageClass(event.kind);
    if (cls === "ephemeral") return { stored: false };

    let replKey: string | null = null;
    if (cls === "replaceable") replKey = `${event.pubkey}:${event.kind}`;
    else if (cls === "addressable") {
      replKey = `${event.pubkey}:${event.kind}:${dTag(event)}`;
    }

    if (replKey !== null) {
      const existing = this.findByReplKey(replKey);
      if (existing) {
        if (!replaces(event, existing)) return { stored: false };
        this.db.query("DELETE FROM events WHERE id = ?").run(existing.id);
        this.insert(event, replKey);
        return { stored: true, replaced: existing };
      }
    }

    this.insert(event, replKey);
    return { stored: true };
  }

  query(filters: Filter[], maxLimit?: number): NostrEvent[] {
    const seen = new Set<string>();
    const result: NostrEvent[] = [];
    for (const filter of filters) {
      const limit = effectiveLimit(filter.limit, maxLimit);
      // Push id/author/kind/since/until + ORDER BY + LIMIT into SQL so the
      // indexes do the work instead of scanning the whole table in JS. Tag
      // filters can't be expressed in SQL here, so when present we fetch
      // ordered candidate rows and apply the tag predicate in JS, stopping once
      // `limit` matches are collected (rows already arrive newest-first).
      const matches = this.queryFilter(filter, limit);
      for (const event of matches) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          result.push(event);
        }
      }
    }
    // Each filter's rows arrive newest-first from SQL; a single filter is
    // already globally ordered, so only re-sort when merging multiple filters.
    return filters.length > 1 ? sortNewestFirst(result) : result;
  }

  /**
   * Fetch the newest-first events matching a single filter, honoring `limit`.
   * Cheap predicates are pushed into SQL; tag predicates (if any) are applied
   * in JS over the ordered candidate stream.
   */
  private queryFilter(filter: Filter, limit: number | undefined): NostrEvent[] {
    const compiled = compileFilter(filter);
    const hasTagFilter = compiled.tags.length > 0;
    const { where, params } = buildWhere(filter);

    // Only the SQL-expressible predicates can bound LIMIT directly. With a tag
    // filter we must over-fetch (no SQL LIMIT) and filter+limit in JS, since
    // rows excluded by the tag predicate would otherwise eat into the LIMIT.
    const sqlLimit = !hasTagFilter && limit !== undefined ? ` LIMIT ${limit}` : "";
    const sql =
      `SELECT * FROM events${where}` +
      ` ORDER BY created_at DESC, id ASC${sqlLimit}`;
    const rows = this.db.query(sql).all(...params) as Row[];

    const out: NostrEvent[] = [];
    for (const row of rows) {
      const event = rowToEvent(row);
      if (hasTagFilter && !matchCompiled(event, compiled)) continue;
      out.push(event);
      if (limit !== undefined && out.length >= limit) break;
    }
    return out;
  }

  getById(id: string): NostrEvent | undefined {
    const row = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as
      | Row
      | null;
    return row ? rowToEvent(row) : undefined;
  }

  size(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM events").get() as {
      c: number;
    };
    return row.c;
  }

  clear(): void {
    this.db.exec("DELETE FROM events;");
  }

  delete(id: string): boolean {
    const res = this.db.query("DELETE FROM events WHERE id = ?").run(id);
    return res.changes > 0;
  }

  deleteByAuthor(pubkey: string, until?: number): number {
    const res =
      until === undefined
        ? this.db.query("DELETE FROM events WHERE pubkey = ?").run(pubkey)
        : this.db
            .query("DELETE FROM events WHERE pubkey = ? AND created_at <= ?")
            .run(pubkey, until);
    return res.changes;
  }

  count(filters: Filter[]): number {
    const seen = new Set<string>();
    for (const filter of filters) {
      const compiled = compileFilter(filter);
      const hasTagFilter = compiled.tags.length > 0;
      const { where, params } = buildWhere(filter);

      if (!hasTagFilter) {
        // No tag predicate: count straight from SQL. Dedup across filters still
        // requires the ids when more than one filter is present; with a single
        // filter we can return COUNT(*) directly.
        if (filters.length === 1) {
          const row = this.db
            .query(`SELECT COUNT(*) AS c FROM events${where}`)
            .get(...params) as { c: number };
          return row.c;
        }
        const rows = this.db
          .query(`SELECT id FROM events${where}`)
          .all(...params) as { id: string }[];
        for (const r of rows) seen.add(r.id);
        continue;
      }

      // Tag predicate present: fetch candidate rows and apply it in JS.
      const rows = this.db
        .query(`SELECT * FROM events${where}`)
        .all(...params) as Row[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        if (matchCompiled(rowToEvent(row), compiled)) seen.add(row.id);
      }
    }
    return seen.size;
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }

  private findByReplKey(replKey: string): NostrEvent | undefined {
    const row = this.db
      .query("SELECT * FROM events WHERE repl_key = ?")
      .get(replKey) as Row | null;
    return row ? rowToEvent(row) : undefined;
  }

  private insert(event: NostrEvent, replKey: string | null): void {
    this.db
      .query(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, repl_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        replKey,
      );
  }
}

/**
 * Build a parameterized SQL `WHERE` clause for the SQL-expressible parts of a
 * filter (ids, authors, kinds, since, until). Tag filters are NOT included —
 * callers apply those in JS. Returns an empty `where` string for an
 * unconstrained filter.
 *
 * Matches {@link matchFilter} semantics exactly, including the edge case that an
 * empty `ids`/`authors`/`kinds` array (e.g. `ids: []`) matches nothing, since
 * `[].includes(x)` is always false (`IN ()` is invalid SQL, so we emit `0`).
 */
type Binding = string | number;

function buildWhere(filter: Filter): { where: string; params: Binding[] } {
  const clauses: string[] = [];
  const params: Binding[] = [];

  const inClause = (column: string, values: readonly Binding[]): void => {
    if (values.length === 0) {
      clauses.push("0"); // matches nothing, mirroring [].includes()
      return;
    }
    clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };

  if (filter.ids) inClause("id", filter.ids);
  if (filter.authors) inClause("pubkey", filter.authors);
  if (filter.kinds) inClause("kind", filter.kinds);
  if (filter.since !== undefined) {
    clauses.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    clauses.push("created_at <= ?");
    params.push(filter.until);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

function rowToEvent(row: Row): NostrEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags) as string[][],
    content: row.content,
    sig: row.sig,
  };
}

function effectiveLimit(
  filterLimit: number | undefined,
  maxLimit: number | undefined,
): number | undefined {
  if (filterLimit === undefined) return maxLimit;
  if (maxLimit === undefined) return filterLimit;
  return Math.min(filterLimit, maxLimit);
}
