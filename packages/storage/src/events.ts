import type {
  Db,
  EventStore,
  EventStoreStats,
  Filter,
  Logger,
  NostrEvent,
  QueryOptions,
  SaveResult,
} from "@beamhop/sdk";
import { getDTag, isAddressable, isEphemeral, isReplaceable, nowSec } from "@beamhop/sdk";
import { escapeLike, greatest, inList, insertRows, isUniqueViolation, parseJson, toNum } from "./sql";

/** Tag values longer than this are not indexed (and thus not matchable by `#x` filters). */
export const MAX_INDEXED_TAG_VALUE = 1024;

const EVENT_COLUMNS = "e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig";
const SINGLE_LETTER = /^[a-zA-Z]$/;

interface EventRow {
  id: string;
  pubkey: string;
  created_at: number | string;
  kind: number | string;
  tags: string;
  content: string;
  sig: string;
}

interface BuiltFilter {
  join: string;
  conds: string[];
  params: unknown[];
  /** extra ORDER BY prefix (relevance) and its params, appended after WHERE params */
  rank?: { sql: string; params: unknown[] };
  /** true when the filter constrains nothing (matches every event) */
  unconstrained: boolean;
}

interface BuildOptions {
  now: number;
  includeExpired?: boolean;
}

export interface EventStoreOptions {
  /** sqlite: FTS5 table available (otherwise search falls back to LIKE) */
  fts: boolean;
}

const rowToEvent = (r: EventRow): NostrEvent => ({
  id: r.id,
  pubkey: r.pubkey,
  created_at: Number(r.created_at),
  kind: Number(r.kind),
  tags: parseJson<string[][]>(r.tags, []),
  content: r.content,
  sig: r.sig,
});

export const compareEvents = (a: NostrEvent, b: NostrEvent) =>
  b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const EXTENSION_TOKEN = /^[a-zA-Z_-]+:[^/\s]/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Splits a NIP-50 search string into plain terms / quoted phrases, dropping `key:value`
 * extensions (domain:, language:, include:spam, …) and tokens without any word characters.
 */
export function parseSearch(search: string): { terms: string[]; phrases: boolean[] } {
  const terms: string[] = [];
  const phrases: boolean[] = [];
  for (const tok of search.match(/"[^"]*"|\S+/g) ?? []) {
    const quoted = tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"');
    if (!quoted && EXTENSION_TOKEN.test(tok)) continue;
    const text = (quoted ? tok.slice(1, -1) : tok).replace(/"/g, " ").trim();
    if (!text || !HAS_WORD_CHAR.test(text)) continue;
    terms.push(text);
    phrases.push(quoted);
  }
  return { terms, phrases };
}

/** FTS5 MATCH expression: every term quoted (no operator injection), AND-ed, last term prefix-matched. */
export function toFts5Query(terms: string[]): string {
  return terms.map((t, i) => `"${t.replace(/"/g, '""')}"${i === terms.length - 1 && !/\s/.test(t) ? "*" : ""}`).join(" ");
}

/** websearch_to_tsquery input: phrases kept quoted, other terms plain (operators already stripped). */
const toWebsearch = (terms: string[], phrases: boolean[]) =>
  terms.map((t, i) => (phrases[i] ? `"${t}"` : t.replace(/^[-]+/, "").replace(/\bor\b/gi, ""))).join(" ");

export class SqlEventStore implements EventStore {
  private initialized = false;

  constructor(
    private db: Db,
    private logger: Logger,
    private opts: EventStoreOptions,
  ) {}

  /** Schema is created by createStores(); init() refreshes planner stats on sqlite. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.db.dialect === "sqlite") {
      try {
        await this.db.exec("PRAGMA optimize=0x10002");
      } catch (err) {
        this.logger.debug("PRAGMA optimize failed", { err: String(err) });
      }
    }
  }

  // ------------------------------------------------------------------ write

  /**
   * Stores an event honoring NIP-01 replaceable/addressable semantics and NIP-09 tombstones.
   * Ephemeral kinds (20000-29999) are never persisted: the call is a no-op returning "saved"
   * (callers are expected to handle ephemeral events before reaching the store).
   */
  async save(event: NostrEvent): Promise<SaveResult> {
    if (isEphemeral(event.kind)) return { status: "saved", message: "ephemeral event not stored" };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.tx((tx) => this.saveIn(tx, event));
      } catch (err) {
        // Concurrent writers (postgres) can race on the id / replaceable unique indexes: re-evaluate.
        if (isUniqueViolation(err) && attempt < 3) continue;
        throw err;
      }
    }
  }

  private async saveIn(tx: Db, event: NostrEvent): Promise<SaveResult> {
    if (await tx.get("SELECT 1 AS x FROM events WHERE id = ?", [event.id])) {
      return { status: "duplicate", message: "duplicate: already have this event" };
    }
    if (
      event.kind !== 5 &&
      (await tx.get("SELECT 1 AS x FROM deleted_events WHERE pubkey = ? AND ref = ?", [event.pubkey, event.id]))
    ) {
      return { status: "deleted", message: "blocked: this event has been deleted" };
    }

    const replaceable = isReplaceable(event.kind);
    const addressable = isAddressable(event.kind);
    const dTag = addressable ? getDTag(event) : replaceable ? "" : null;
    let status: SaveResult["status"] = "saved";

    if (dTag !== null) {
      const coordinate = `${event.kind}:${event.pubkey}:${dTag}`;
      if (
        await tx.get("SELECT 1 AS x FROM deleted_events WHERE pubkey = ? AND ref = ? AND deleted_at >= ?", [
          event.pubkey,
          coordinate,
          event.created_at,
        ])
      ) {
        return { status: "deleted", message: "blocked: this event has been deleted" };
      }
      const prev = await tx.get<{ seq: number; id: string; created_at: number }>(
        "SELECT seq, id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ?",
        [event.pubkey, event.kind, dTag],
      );
      if (prev) {
        const prevAt = Number(prev.created_at);
        if (prevAt > event.created_at || (prevAt === event.created_at && prev.id < event.id)) {
          return { status: "stale", message: "duplicate: have a newer version of this event" };
        }
        await tx.run("DELETE FROM events WHERE seq = ?", [prev.seq]);
        status = "replaced";
      }
    }

    const row = await tx.get<{ seq: number }>(
      "INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, d_tag, expiration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
      [
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        dTag,
        expirationOf(event),
      ],
    );
    const seq = Number(row!.seq);
    const tagRows = indexableTags(event).map(([name, value]) => [seq, name, value, event.created_at]);
    if (tagRows.length) await insertRows(tx, "INSERT INTO event_tags (event_seq, name, value, created_at)", 4, tagRows);
    return { status };
  }

  // ------------------------------------------------------------------ read

  async query(filters: Filter[], opts: QueryOptions = {}): Promise<NostrEvent[]> {
    const now = nowSec();
    const seen = new Set<string>();
    const out: NostrEvent[] = [];
    for (const filter of filters) {
      if (opts.signal?.aborted) break;
      let limit = filter.limit;
      if (opts.maxLimit !== undefined) limit = Math.min(limit ?? opts.maxLimit, opts.maxLimit);
      if (limit !== undefined && limit <= 0) continue;
      const b = this.build(filter, { now });
      if (!b) continue;
      const params = [...b.params, ...(b.rank?.params ?? [])];
      let sql = `SELECT ${EVENT_COLUMNS} FROM events e${b.join}${where(b.conds)} ORDER BY ${b.rank ? `${b.rank.sql}, ` : ""}e.created_at DESC, e.id ASC`;
      if (limit !== undefined) {
        sql += " LIMIT ?";
        params.push(Math.floor(limit));
      }
      for (const r of await this.db.all<EventRow>(sql, params)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(rowToEvent(r));
      }
    }
    return out.sort(compareEvents);
  }

  async count(filters: Filter[]): Promise<number> {
    const now = nowSec();
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const filter of filters) {
      const b = this.build(filter, { now });
      if (!b) continue;
      parts.push(`SELECT e.seq FROM events e${b.join}${where(b.conds)}`);
      params.push(...b.params);
    }
    if (!parts.length) return 0;
    const sql =
      parts.length === 1
        ? `SELECT COUNT(*) AS n FROM (${parts[0]}) c`
        : `SELECT COUNT(*) AS n FROM (${parts.join(" UNION ")}) c`;
    return toNum((await this.db.get<{ n: number }>(sql, params))?.n);
  }

  async getById(id: string): Promise<NostrEvent | undefined> {
    const r = await this.db.get<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = ?`, [id]);
    return r ? rowToEvent(r) : undefined;
  }

  async queryIdsForSync(filter: Filter): Promise<{ id: string; created_at: number }[]> {
    const b = this.build({ ...filter, search: undefined }, { now: nowSec() });
    if (!b) return [];
    const params = [...b.params];
    let sql = `SELECT e.id, e.created_at FROM events e${b.join}${where(b.conds)} ORDER BY e.created_at ASC, e.id ASC`;
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(Math.max(0, Math.floor(filter.limit)));
    }
    const rows = await this.db.all<{ id: string; created_at: number }>(sql, params);
    return rows.map((r) => ({ id: r.id, created_at: Number(r.created_at) }));
  }

  // ------------------------------------------------------------------ delete

  async applyDeletion(deletion: NostrEvent): Promise<number> {
    if (deletion.kind !== 5) return 0;
    const ids = new Set<string>();
    const coords = new Map<string, { kind: number; d: string }>();
    for (const t of deletion.tags) {
      if (t[0] === "e" && typeof t[1] === "string" && t[1] && t[1] !== deletion.id) ids.add(t[1]);
      else if (t[0] === "a" && typeof t[1] === "string") {
        const c = parseCoordinate(t[1]);
        // never act on other pubkeys' coordinates
        if (c && c.pubkey === deletion.pubkey) coords.set(`${c.kind}:${c.pubkey}:${c.d}`, c);
      }
    }
    if (!ids.size && !coords.size) return 0;

    return this.db.tx(async (tx) => {
      let deleted = 0;
      const idList = [...ids];
      for (let i = 0; i < idList.length; i += 500) {
        const part = idList.slice(i, i + 500);
        const inl = inList(tx.dialect, "id", part);
        const r = await tx.run(`DELETE FROM events WHERE pubkey = ? AND kind <> 5 AND ${inl.sql}`, [deletion.pubkey, ...inl.params]);
        deleted += r.changes;
      }
      for (const { kind, d } of coords.values()) {
        const r = await tx.run("DELETE FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ? AND created_at <= ?", [
          deletion.pubkey,
          kind,
          d,
          deletion.created_at,
        ]);
        deleted += r.changes;
      }
      const tombstones = [...idList, ...coords.keys()].map((ref) => [deletion.pubkey, ref, deletion.created_at, deletion.id]);
      await insertRows(
        tx,
        "INSERT INTO deleted_events (pubkey, ref, deleted_at, deletion_id)",
        4,
        tombstones,
        `ON CONFLICT (pubkey, ref) DO UPDATE SET deleted_at = ${greatest(tx.dialect, "deleted_events.deleted_at", "excluded.deleted_at")}, deletion_id = excluded.deletion_id`,
      );
      return deleted;
    });
  }

  async deleteByIds(ids: string[]): Promise<number> {
    const unique = [...new Set(ids)];
    if (!unique.length) return 0;
    return this.db.tx(async (tx) => {
      let deleted = 0;
      for (let i = 0; i < unique.length; i += 500) {
        const inl = inList(tx.dialect, "id", unique.slice(i, i + 500));
        deleted += (await tx.run(`DELETE FROM events WHERE ${inl.sql}`, inl.params)).changes;
      }
      return deleted;
    });
  }

  /**
   * Admin bulk delete. Each filter's `limit` (if any) bounds the number of newest matches removed.
   * Filters without any constraint are rejected to avoid accidentally wiping the database.
   */
  async deleteByFilter(filters: Filter[]): Promise<number> {
    const now = nowSec();
    const built = filters.map((f) => ({ f, b: this.build(f, { now, includeExpired: true }) }));
    if (built.some(({ b }) => b?.unconstrained)) throw new Error("deleteByFilter: refusing to delete with an empty filter");
    return this.db.tx(async (tx) => {
      let deleted = 0;
      for (const { f, b } of built) {
        if (!b) continue;
        if (f.limit !== undefined && f.limit <= 0) continue;
        const params = [...b.params];
        let sub = `SELECT e.seq FROM events e${b.join}${where(b.conds)}`;
        if (f.limit !== undefined) {
          sub += " ORDER BY e.created_at DESC LIMIT ?";
          params.push(Math.floor(f.limit));
        }
        deleted += (await tx.run(`DELETE FROM events WHERE seq IN (${sub})`, params)).changes;
      }
      return deleted;
    });
  }

  async deleteByPubkey(pubkey: string): Promise<number> {
    return this.db.tx(async (tx) => (await tx.run("DELETE FROM events WHERE pubkey = ?", [pubkey])).changes);
  }

  async purgeExpired(now: number): Promise<number> {
    return this.db.tx(
      async (tx) => (await tx.run("DELETE FROM events WHERE expiration IS NOT NULL AND expiration < ?", [now])).changes,
    );
  }

  async stats(): Promise<EventStoreStats> {
    const total = toNum((await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events"))?.n);
    const byKind = (
      await this.db.all<{ kind: number; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC, kind ASC",
      )
    ).map((r) => ({ kind: Number(r.kind), count: Number(r.n) }));
    let sizeBytes = 0;
    try {
      const row =
        this.db.dialect === "sqlite"
          ? await this.db.get<{ size: number }>(
              "SELECT p.page_count * s.page_size AS size FROM pragma_page_count() p, pragma_page_size() s",
            )
          : await this.db.get<{ size: number }>(
              "SELECT pg_total_relation_size('events') + pg_total_relation_size('event_tags') AS size",
            );
      sizeBytes = toNum(row?.size);
    } catch (err) {
      this.logger.debug("size query failed", { err: String(err) });
    }
    return { total, byKind, sizeBytes };
  }

  // ------------------------------------------------------------------ filter → SQL

  /** Returns null when the filter can never match (e.g. empty id list). */
  private build(filter: Filter, o: BuildOptions): BuiltFilter | null {
    const dialect = this.db.dialect;
    const conds: string[] = [];
    const params: unknown[] = [];
    let join = "";
    let rank: BuiltFilter["rank"];
    const add = (c: { sql: string; params: unknown[] }) => {
      conds.push(c.sql);
      params.push(...c.params);
    };

    if (filter.ids) {
      const ids = strings(filter.ids);
      if (!ids.length) return null;
      add(inList(dialect, "e.id", ids));
    }
    if (filter.authors) {
      const authors = strings(filter.authors);
      if (!authors.length) return null;
      add(inList(dialect, "e.pubkey", authors));
    }
    if (filter.kinds) {
      const kinds = [...new Set(filter.kinds.filter((k) => Number.isInteger(k)))];
      if (!kinds.length) return null;
      add(inList(dialect, "e.kind", kinds, "int"));
    }
    if (typeof filter.since === "number") add({ sql: "e.created_at >= ?", params: [Math.floor(filter.since)] });
    if (typeof filter.until === "number") add({ sql: "e.created_at <= ?", params: [Math.floor(filter.until)] });

    for (const key of Object.keys(filter)) {
      if (!key.startsWith("#")) continue;
      const raw = filter[key as `#${string}`];
      if (raw === undefined) continue;
      const name = key.slice(1);
      // only single-letter tags are indexed (NIP-01); anything else can't match
      if (!SINGLE_LETTER.test(name) || !Array.isArray(raw)) return null;
      const values = strings(raw);
      if (!values.length) return null;
      const inl = inList(dialect, "t.value", values);
      add({
        sql: `e.seq IN (SELECT t.event_seq FROM event_tags t WHERE t.name = ? AND ${inl.sql})`,
        params: [name, ...inl.params],
      });
    }

    if (typeof filter.search === "string") {
      const { terms, phrases } = parseSearch(filter.search);
      if (terms.length) {
        if (dialect === "postgres") {
          const q = toWebsearch(terms, phrases);
          add({ sql: "e.search @@ websearch_to_tsquery('simple', ?)", params: [q] });
          rank = { sql: "ts_rank(e.search, websearch_to_tsquery('simple', ?)) DESC", params: [q] };
        } else if (this.opts.fts) {
          join = " JOIN events_fts ON events_fts.rowid = e.seq";
          add({ sql: "events_fts MATCH ?", params: [toFts5Query(terms)] });
          rank = { sql: "events_fts.rank", params: [] };
        } else {
          for (const t of terms) add({ sql: "e.content LIKE ? ESCAPE '\\'", params: [`%${escapeLike(t)}%`] });
        }
      }
    }

    const unconstrained = conds.length === 0;
    if (!o.includeExpired) add({ sql: "(e.expiration IS NULL OR e.expiration >= ?)", params: [o.now] });
    return { join, conds, params, rank, unconstrained };
  }
}

const where = (conds: string[]) => (conds.length ? ` WHERE ${conds.join(" AND ")}` : "");
const strings = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === "string"))];

function expirationOf(e: NostrEvent): number | null {
  const v = e.tags.find((t) => t[0] === "expiration")?.[1];
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function indexableTags(e: NostrEvent): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const t of e.tags) {
    const [name, value] = t;
    if (typeof name !== "string" || !SINGLE_LETTER.test(name) || typeof value !== "string") continue;
    if (value.length > MAX_INDEXED_TAG_VALUE) continue;
    const k = `${name}\u0000${value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([name, value]);
  }
  return out;
}

/** Parses an `a` tag coordinate `kind:pubkey:d` (d may contain ':'). Only replaceable/addressable kinds. */
export function parseCoordinate(a: string): { kind: number; pubkey: string; d: string } | null {
  const i = a.indexOf(":");
  const j = i < 0 ? -1 : a.indexOf(":", i + 1);
  if (i < 0) return null;
  const kindStr = a.slice(0, i);
  if (!/^\d+$/.test(kindStr)) return null;
  const kind = Number(kindStr);
  const pubkey = j < 0 ? a.slice(i + 1) : a.slice(i + 1, j);
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
  if (isReplaceable(kind)) return { kind, pubkey, d: "" };
  if (isAddressable(kind)) return { kind, pubkey, d: j < 0 ? "" : a.slice(j + 1) };
  return null;
}
