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
import { getDTag, isAddressable, isEphemeral, isReplaceable, nowSec, yieldToEventLoop } from "@beamhop/sdk";
import { parseSearch } from "@beamhop/sdk/search";
import { chunk, escapeLike, greatest, inList, insertRows, isUniqueViolation, parseJson, toNum } from "./sql";
import { sqliteFtsReady, sqliteHasFts5 } from "./migrations";

/** Tag values longer than this many UTF-8 bytes are not indexed (and thus not matchable by `#x` filters). */
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
  /** FROM clause (aliasing events as `e`) */
  from: string;
  /** created_at column to order by: `t.created_at` when the plan is driven from event_tags (always equal to e's) */
  timeCol: string;
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
  /** leave out this column's IN list: the caller adds one `= ?` branch per value (see SPLIT_MAX_VALUES) */
  split?: SplitColumn;
  /** start the plan at event_tags for the first single-value tag condition (sqlite) */
  driveByTag?: boolean;
}

type SplitColumn = "e.kind" | "e.pubkey";
/** what querySql() splits into one branch per value (see SPLIT_MAX_VALUES) */
type Split = { column: SplitColumn; values: (string | number)[] } | { column: "tag"; key: `#${string}`; values: string[] };

export interface EventStoreOptions {
  /** sqlite: FTS5 table available (otherwise search falls back to LIKE) */
  fts: boolean;
  /**
   * sqlite: plan-shaping query forms (per-value UNION ALL, event_tags-driven tag lookups); default true.
   * false keeps the single generic statement per filter (tests compare both).
   */
  queryShapes?: boolean;
  /** sqlite: rows of the newest-events window for long authors lists (default MANY_AUTHORS_WINDOW; tests shrink it) */
  manyAuthorsWindow?: number;
  /** sqlite: matches a search ranks (default SEARCH_RANK_WINDOW; tests shrink it) */
  searchRankWindow?: number;
}

/**
 * sqlite query(): an `authors` / `kinds` list of 2..SPLIT_MAX_VALUES values with a limit runs as a UNION ALL of
 * one LIMITed branch per value. With `kind IN (1, 7) ORDER BY created_at DESC` sqlite can't read the
 * (kind, created_at) index in order across both values: it walks the whole created_at index, or sorts every
 * match of a heavy author. One branch per value reads at most `limit` index entries from each range.
 * Measured on 1M events: kinds [1,7] 335 → 0.2 ms, 50 heavy authors 199 → 9 ms, 50 light authors 0.6 → 1.2 ms.
 */
const SPLIT_MAX_VALUES = 50;
/**
 * sqlite query(): a longer `authors` list (a follow list: home feeds) first reads the newest MANY_AUTHORS_WINDOW events
 * in created_at order, keeping the listed authors' ones; enough of them there (any active follow list) answers the
 * query. Otherwise the list runs SPLIT_MAX_VALUES authors per statement, one LIMITed branch per author. As one
 * `pubkey IN (…)` statement sqlite read and sorted every event of every listed author: measured on 1M events, 300
 * authors (heavy ones among them) 232 ms, one synchronous stall of the whole relay; now 0.5 ms (active) / ~40 ms (all
 * barely active, bounded by authors × limit).
 */
const MANY_AUTHORS_WINDOW = 5_000;
/**
 * sqlite NIP-50 search ranks (bm25) the newest this-many matches of the filter, not every match: ranking all 365k
 * matches of a common word in 1M notes took 605 ms, a synchronous stall of the whole relay; the newest 5000 take
 * 30 ms. A filter with fewer matches is ranked exactly as before; for broader ones the most relevant recent notes
 * win over older, possibly better scoring ones.
 */
export const SEARCH_RANK_WINDOW = 5_000;
/** Bulk deletes (sqlite) start at this many events per statement, yielding to the event loop in between. */
export const DELETE_BATCH = 500;
const DELETE_BATCH_MIN = 50;
const DELETE_BATCH_MAX = 2000;
/** target duration of one bulk-delete statement (the longest the event loop waits) */
const DELETE_SLICE_MS = 50;

/**
 * sqlite save(): saves arriving while a transaction is running are committed together in the next one (group
 * commit), each inside its own savepoint, at most this many per transaction. A commit (WAL frames for every page the
 * event dirtied) costs several times the statements themselves: 16 events per transaction measured 167 → 68 µs per
 * save. A save arriving while nothing is queued still commits alone, right away.
 */
export const SAVE_BATCH_MAX = 64;

interface SaveJob {
  event: NostrEvent;
  resolve: (r: SaveResult) => void;
  reject: (err: unknown) => void;
  result?: SaveResult;
  error?: unknown;
}

/** Group commit needs the sqlite Db's transaction-context probe: a wrapper without it (tests) saves one by one. */
const batchable = (db: Db) => {
  const probe = (db as { inTxContext?: unknown }).inTxContext;
  return typeof probe === "boolean" && !probe;
};

const rowToEvent = (r: EventRow): NostrEvent => ({
  id: r.id,
  pubkey: r.pubkey,
  created_at: Number(r.created_at),
  kind: Number(r.kind),
  tags: parseJson<string[][]>(r.tags, []),
  content: r.content,
  sig: r.sig,
});

/** Re-exported for callers that import it from the store (one tokenizer: see @beamhop/sdk/search). */
export { parseSearch };

export const compareEvents = (a: NostrEvent, b: NostrEvent) =>
  b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const compareRows = (a: EventRow, b: EventRow) =>
  Number(b.created_at) - Number(a.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Shorter last terms are matched as whole tokens: a 1-2 letter prefix expands to most of the index (and
 * diacritic folding makes "é" behave like "e"). CJK terms keep prefix matching at any length: the
 * tokenizer keeps runs of CJK characters as one long token, so a short CJK query only ever matches as a prefix.
 */
export const MIN_PREFIX_TERM_LENGTH = 3;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** FTS5 MATCH expression: every term quoted (no operator injection), AND-ed, last term prefix-matched. */
export function toFts5Query(terms: string[]): string {
  return terms
    .map((t, i) => {
      const prefix = i === terms.length - 1 && !/\s/.test(t) && ([...t].length >= MIN_PREFIX_TERM_LENGTH || CJK.test(t));
      return `"${t.replace(/"/g, '""')}"${prefix ? "*" : ""}`;
    })
    .join(" ");
}

/** websearch_to_tsquery input: phrases kept quoted, other terms plain (operators already stripped). */
const toWebsearch = (terms: string[], phrases: boolean[]) =>
  terms.map((t, i) => (phrases[i] ? `"${t}"` : t.replace(/^[-]+/, "").replace(/\bor\b/gi, ""))).join(" ");

export class SqlEventStore implements EventStore {
  private initialized = false;
  /** current adaptive bulk-delete batch size (see deleteSeqs) */
  private deleteBatch = DELETE_BATCH;
  /** sqlite: saves waiting for the next group-commit transaction (see flushSaves) */
  private saveQueue: SaveJob[] = [];
  private flushing = false;
  /** NIP-50 search uses full-text search (sqlite: FTS5 table present; postgres: always). See rebind(). */
  private fts: boolean;

  constructor(
    private db: Db,
    private logger: Logger,
    private opts: EventStoreOptions,
  ) {
    this.fts = opts.fts;
  }

  /**
   * Recomputes the state derived from the database: run at startup by createStores() and after a database switch
   * (the dialect, and with it full-text search availability, may have changed). Everything else reads
   * `db.dialect` per call.
   */
  async rebind(): Promise<void> {
    if (this.db.dialect === "postgres") {
      this.fts = true;
      return;
    }
    this.fts = (await sqliteHasFts5(this.db)) && (await sqliteFtsReady(this.db));
    if (!this.fts) this.logger.debug("sqlite full-text search unavailable; NIP-50 search falls back to LIKE");
  }

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
    // a save from inside a transaction joins it (as before) instead of waiting for a batch behind it
    if (this.db.dialect === "sqlite" && batchable(this.db)) {
      return new Promise<SaveResult>((resolve, reject) => {
        this.saveQueue.push({ event, resolve, reject });
        if (!this.flushing) void this.flushSaves();
      });
    }
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

  /**
   * Commits the queued saves, SAVE_BATCH_MAX per transaction, until the queue is empty. A failing save is rolled back
   * to its savepoint and rejects alone; a transaction that fails as a whole (watchdog, database closing) rejects
   * every save in it.
   */
  private async flushSaves(): Promise<void> {
    this.flushing = true;
    try {
      while (this.saveQueue.length) {
        const batch = this.saveQueue.splice(0, SAVE_BATCH_MAX);
        try {
          await this.db.tx(async (tx) => {
            for (const job of batch) {
              await tx.exec("SAVEPOINT save_event");
              try {
                job.result = await this.saveIn(tx, job.event);
              } catch (err) {
                await tx.exec("ROLLBACK TO save_event");
                job.error = err;
              }
              await tx.exec("RELEASE save_event");
            }
          });
        } catch (err) {
          for (const job of batch) job.reject(err);
          continue;
        }
        for (const job of batch) {
          if (job.result) job.resolve(job.result);
          else job.reject(job.error);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async saveIn(tx: Db, event: NostrEvent): Promise<SaveResult> {
    await lockPubkey(tx, event.pubkey);
    if (await tx.get("SELECT 1 AS x FROM events WHERE id = ?", [event.id])) {
      return { status: "duplicate", message: "duplicate: already have this event" };
    }
    // NIP-09 / NIP-62: a deletion request naming a deletion request or a request to vanish has no effect
    if (
      event.kind !== 5 &&
      event.kind !== 62 &&
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
      for (const r of await this.queryRows(filter, now, limit)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(rowToEvent(r));
      }
    }
    // NIP-50: search results keep their relevance order instead of the usual created_at order
    if (filters.length === 1 && filters[0].search) return out;
    return out.sort(compareEvents);
  }

  private async queryRows(filter: Filter, now: number, limit: number | undefined): Promise<EventRow[]> {
    if (limit !== undefined && this.shaped(filter) && filter.authors && strings(filter.authors).length > SPLIT_MAX_VALUES && !singleTagKey(filter)) {
      return this.queryManyAuthors(filter, now, safeInt(limit));
    }
    const q = this.querySql(filter, now, limit);
    return q ? this.db.all<EventRow>(q.sql, q.params) : [];
  }

  /** sqlite plan shapes apply (not to search, ids or with queryShapes off) */
  private shaped(filter: Filter): boolean {
    return this.db.dialect === "sqlite" && this.opts.queryShapes !== false && filter.search === undefined && !filter.ids;
  }

  /**
   * sqlite, an authors list longer than SPLIT_MAX_VALUES (see MANY_AUTHORS_WINDOW): the newest events in created_at
   * order first, then (when too few of them match) SPLIT_MAX_VALUES authors per statement, with a loop turn between
   * statements.
   */
  private async queryManyAuthors(filter: Filter, now: number, limit: number): Promise<EventRow[]> {
    const b = this.build(filter, { now });
    if (!b) return [];
    const until = typeof filter.until === "number" ? safeInt(filter.until) : undefined;
    // created_at of the newest MANY_AUTHORS_WINDOW-th event (no later than `until`): a covering index read
    const edge = await this.db.get<{ t: number }>(
      `SELECT created_at AS t FROM events INDEXED BY events_created_idx${until === undefined ? "" : " WHERE created_at <= ?"} ORDER BY created_at DESC LIMIT 1 OFFSET ?`,
      until === undefined ? [this.opts.manyAuthorsWindow ?? MANY_AUTHORS_WINDOW] : [until, this.opts.manyAuthorsWindow ?? MANY_AUTHORS_WINDOW],
    );
    const lower = edge === undefined ? undefined : toNum(edge.t);
    const window = `SELECT ${EVENT_COLUMNS} FROM events e INDEXED BY events_created_idx${where(lower === undefined ? b.conds : [...b.conds, "e.created_at >= ?"])} ORDER BY e.created_at DESC, e.id ASC LIMIT ?`;
    const rows = await this.db.all<EventRow>(window, lower === undefined ? [...b.params, limit] : [...b.params, lower, limit]);
    // complete: enough matches, or the window held every event the filter's time range allows
    if (rows.length >= limit || lower === undefined || (typeof filter.since === "number" && filter.since >= lower)) return rows;
    const out: EventRow[] = [];
    for (const [i, part] of chunk(strings(filter.authors!), SPLIT_MAX_VALUES).entries()) {
      if (i > 0) await yieldToEventLoop();
      const q = this.querySql({ ...filter, authors: part }, now, limit);
      if (q) out.push(...(await this.db.all<EventRow>(q.sql, q.params)));
    }
    return out.sort(compareRows).slice(0, limit);
  }

  /**
   * The SELECT query() runs for one filter (exposed for plan tests). On sqlite it picks a shape the planner
   * handles well: event_tags-driven for a single-value tag, per-value UNION ALL for short kinds/authors lists;
   * otherwise (and always on postgres) one generic statement.
   * @internal
   */
  querySql(filter: Filter, now: number, limit?: number): { sql: string; params: unknown[] } | null {
    const shaped = this.shaped(filter);
    const split = shaped && limit !== undefined ? splitOf(filter) : undefined;
    if (split?.column === "tag" && limit !== undefined) return this.tagSplitSql(filter, split.key, split.values, now, limit);
    const b = this.build(filter, { now, split: split?.column as SplitColumn | undefined, driveByTag: shaped && !split });
    if (!b) return null;
    const order = `ORDER BY ${b.rank ? `${b.rank.sql}, ` : ""}${b.timeCol} DESC, e.id ASC`;
    if (split && split.column !== "tag" && limit !== undefined) {
      // branches carry only the sort key; the full rows are read for the final `limit` seqs only
      const lim = safeInt(limit);
      const params: unknown[] = [];
      const branches = split.values.map((v) => {
        params.push(v, ...b.params, lim);
        return `SELECT * FROM (SELECT e.seq, e.created_at, e.id FROM ${b.from}${where([`${split.column} = ?`, ...b.conds])} ${order} LIMIT ?)`;
      });
      params.push(lim);
      const seqs = `SELECT seq FROM (${branches.join(" UNION ALL ")}) ORDER BY created_at DESC, id ASC LIMIT ?`;
      return { sql: `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.seq IN (${seqs}) ORDER BY e.created_at DESC, e.id ASC`, params };
    }
    const params = [...b.params];
    let conds = b.conds;
    if (b.from.startsWith("events_fts")) {
      // sqlite search ranks the newest SEARCH_RANK_WINDOW matches only (see there)
      conds = [...conds, `events_fts.rowid >= COALESCE((SELECT MIN(seq) FROM (SELECT e.seq AS seq FROM ${b.from}${where(b.conds)} ORDER BY events_fts.rowid DESC LIMIT ?)), 0)`];
      params.push(...b.params, this.opts.searchRankWindow ?? SEARCH_RANK_WINDOW);
    }
    params.push(...(b.rank?.params ?? []));
    let sql = `SELECT ${EVENT_COLUMNS} FROM ${b.from}${where(conds)} ${order}`;
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(safeInt(limit));
    }
    return { sql, params };
  }

  /**
   * sqlite, a tag condition with 2..SPLIT_MAX_VALUES values: one branch per value, each read from
   * event_tags_lookup_idx in created_at order (as for a single value) and LIMITed. UNION, not UNION ALL: an event
   * carrying several of the values comes from several branches and must count once against the limit. Measured on
   * 1M events, five hashtags: 36 → 0.6 ms.
   */
  private tagSplitSql(filter: Filter, key: `#${string}`, values: string[], now: number, limit: number): { sql: string; params: unknown[] } | null {
    const lim = safeInt(limit);
    const params: unknown[] = [];
    const branches: string[] = [];
    for (const v of values) {
      const b = this.build({ ...filter, [key]: [v] }, { now, driveByTag: true });
      if (!b) continue;
      params.push(...b.params, lim);
      branches.push(`SELECT * FROM (SELECT e.seq, ${b.timeCol} AS created_at, e.id FROM ${b.from}${where(b.conds)} ORDER BY ${b.timeCol} DESC, e.id ASC LIMIT ?)`);
    }
    if (!branches.length) return null;
    params.push(lim);
    const seqs = `SELECT seq FROM (${branches.join(" UNION ")}) ORDER BY created_at DESC, id ASC LIMIT ?`;
    return { sql: `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.seq IN (${seqs}) ORDER BY e.created_at DESC, e.id ASC`, params };
  }

  /**
   * Matches, minus the expired ones counted separately. `expiration IS NULL OR expiration > now` in the counting
   * statement made sqlite read the table row of every match (the column is in no index but the partial expiration
   * one): on 1M events COUNT kinds:[1] took 908 ms, one stall of the relay; counted from the (kind, created_at) index
   * alone 10 ms. The expired matches are few (purged every minute) and found through events_expiration_idx.
   */
  async count(filters: Filter[]): Promise<number> {
    const now = nowSec();
    const all = { parts: [] as string[], params: [] as unknown[] };
    const expired = { parts: [] as string[], params: [] as unknown[] };
    for (const filter of filters) {
      const b = this.build(filter, { now, includeExpired: true });
      if (!b) continue;
      const fts = b.from.startsWith("events_fts");
      // a search alone is counted in the FTS index, without reading the events
      all.parts.push(fts && b.conds.length === 1 ? "SELECT rowid AS seq FROM events_fts WHERE events_fts MATCH ?" : `SELECT e.seq FROM ${b.from}${where(b.conds)}`);
      all.params.push(...b.params);
      if (this.db.dialect === "sqlite") {
        // expired matches from the (partial) expiration index; a search becomes a rowid list to check against
        const conds = b.conds.map((c) => (c === "events_fts MATCH ?" ? "e.seq IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)" : c));
        expired.parts.push(`SELECT e.seq FROM events e INDEXED BY events_expiration_idx${where([...conds, "e.expiration IS NOT NULL", "e.expiration <= ?"])}`);
      } else expired.parts.push(`SELECT e.seq FROM ${b.from}${where([...b.conds, "e.expiration IS NOT NULL", "e.expiration <= ?"])}`);
      expired.params.push(...b.params, now);
    }
    if (!all.parts.length) return 0;
    const countOf = async (q: { parts: string[]; params: unknown[] }) =>
      toNum((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${q.parts.join(" UNION ")}) c`, q.params))?.n);
    return Math.max(0, (await countOf(all)) - (await countOf(expired)));
  }

  async getById(id: string): Promise<NostrEvent | undefined> {
    const r = await this.db.get<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = ?`, [id]);
    return r ? rowToEvent(r) : undefined;
  }

  async queryIdsForSync(filter: Filter): Promise<{ id: string; created_at: number }[]> {
    const b = this.build({ ...filter, search: undefined }, { now: nowSec() });
    if (!b) return [];
    const params = [...b.params];
    // sqlite: with several authors or kinds, `+` keeps the planner from walking an index in created_at order and
    // checking every row: { authors: [heavy], kinds: [4, 1059, 21059] } (COUNT's private-event check) read all
    // 122k of the author's events, 219 ms; from the (pubkey, kind, created_at) ranges it reads the few matches
    const multi = this.db.dialect === "sqlite" && ((filter.kinds?.length ?? 0) > 1 || (filter.authors?.length ?? 0) > 1);
    let sql = `SELECT e.id, e.created_at FROM ${b.from}${where(b.conds)} ORDER BY ${multi ? "+" : ""}e.created_at ASC, e.id ASC`;
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(safeInt(filter.limit));
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
      await lockPubkey(tx, deletion.pubkey);
      let deleted = 0;
      const idList = [...ids];
      for (let i = 0; i < idList.length; i += 500) {
        const part = idList.slice(i, i + 500);
        const inl = inList(tx.dialect, "id", part);
        // deletions of deletions (NIP-09) and of requests to vanish (NIP-62) have no effect
        const r = await tx.run(`DELETE FROM events WHERE pubkey = ? AND kind NOT IN (5, 62) AND ${inl.sql}`, [deletion.pubkey, ...inl.params]);
        deleted += r.changes;
      }
      // NIP-59: recipients may delete gift wraps addressed to them (signed by throwaway keys)
      const wrapTombstones: unknown[][] = [];
      for (let i = 0; i < idList.length; i += 500) {
        const inl = inList(tx.dialect, "e.id", idList.slice(i, i + 500));
        const wraps = await tx.all<{ seq: number; id: string; pubkey: string }>(
          `SELECT e.seq, e.id, e.pubkey FROM events e JOIN event_tags t ON t.event_seq = e.seq WHERE e.kind = 1059 AND t.name = 'p' AND t.value = ? AND ${inl.sql}`,
          [deletion.pubkey, ...inl.params],
        );
        for (const w of wraps) {
          deleted += (await tx.run("DELETE FROM events WHERE seq = ?", [w.seq])).changes;
          wrapTombstones.push([w.pubkey, w.id, deletion.created_at, deletion.id]);
        }
      }
      if (wrapTombstones.length) await insertRows(tx, "INSERT INTO deleted_events (pubkey, ref, deleted_at, deletion_id)", 4, wrapTombstones, "ON CONFLICT (pubkey, ref) DO NOTHING");
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

  /** On sqlite each batch of DELETE_BATCH ids is its own transaction (see deleteSeqs); postgres deletes all in one. */
  async deleteByIds(ids: string[], opts: { tombstone?: string } = {}): Promise<number> {
    const unique = [...new Set(ids)];
    if (!unique.length) return 0;
    const now = nowSec();
    const deletePart = async (tx: Db, part: string[]) => {
      const inl = inList(tx.dialect, "id", part);
      if (opts.tombstone !== undefined) {
        const rows = await tx.all<{ id: string; pubkey: string }>(`SELECT id, pubkey FROM events WHERE ${inl.sql}`, inl.params);
        const stones = rows.map((r) => [r.pubkey, r.id, now, opts.tombstone]);
        if (stones.length) await insertRows(tx, "INSERT INTO deleted_events (pubkey, ref, deleted_at, deletion_id)", 4, stones, "ON CONFLICT (pubkey, ref) DO NOTHING");
      }
      return (await tx.run(`DELETE FROM events WHERE ${inl.sql}`, inl.params)).changes;
    };
    if (this.db.dialect !== "sqlite") {
      return this.db.tx(async (tx) => {
        let deleted = 0;
        for (const part of chunk(unique, 500)) deleted += await deletePart(tx, part);
        return deleted;
      });
    }
    let deleted = 0;
    for (const [i, part] of chunk(unique, DELETE_BATCH).entries()) {
      if (i > 0) await yieldToEventLoop();
      deleted += await this.db.tx((tx) => deletePart(tx, part));
    }
    return deleted;
  }

  /**
   * Admin bulk delete. Each filter's `limit` (if any) bounds the number of newest matches removed.
   * Filters without any constraint are rejected to avoid accidentally wiping the database.
   */
  async deleteByFilter(filters: Filter[], opts: { exceptAuthors?: string[] } = {}): Promise<number> {
    const now = nowSec();
    const built = filters.map((f) => ({ f, b: this.build(f, { now, includeExpired: true }) }));
    if (built.some(({ b }) => b?.unconstrained)) throw new Error("deleteByFilter: refusing to delete with an empty filter");
    const except = strings(opts.exceptAuthors ?? []);
    if (except.length) {
      for (const { b } of built) {
        if (!b) continue;
        const inl = inList(this.db.dialect, "e.pubkey", except);
        b.conds.push(`NOT (${inl.sql})`);
        b.params.push(...inl.params);
      }
    }
    if (this.db.dialect === "sqlite") {
      // victims are selected once (so each filter's limit means the newest matches now), then deleted in batches
      const seqs = new Set<number>();
      for (const { f, b } of built) {
        if (!b) continue;
        if (f.limit !== undefined && f.limit <= 0) continue;
        const params = [...b.params];
        let sql = `SELECT e.seq FROM ${b.from}${where(b.conds)}`;
        if (f.limit !== undefined) {
          sql += " ORDER BY e.created_at DESC LIMIT ?";
          params.push(safeInt(f.limit));
        }
        for (const r of await this.db.all<{ seq: number }>(sql, params)) seqs.add(Number(r.seq));
      }
      return this.deleteSeqs([...seqs]);
    }
    // serialize with save() for the authors involved (postgres), so a concurrent save can't slip in
    const authors = [...new Set(filters.flatMap((f) => f.authors ?? []))].sort();
    return this.db.tx(async (tx) => {
      if (authors.length <= MAX_LOCKED_AUTHORS) for (const pk of authors) await lockPubkey(tx, pk);
      let deleted = 0;
      for (const { f, b } of built) {
        if (!b) continue;
        if (f.limit !== undefined && f.limit <= 0) continue;
        const params = [...b.params];
        let sub = `SELECT e.seq FROM ${b.from}${where(b.conds)}`;
        if (f.limit !== undefined) {
          sub += " ORDER BY e.created_at DESC LIMIT ?";
          params.push(safeInt(f.limit));
        }
        deleted += (await tx.run(`DELETE FROM events WHERE seq IN (${sub})`, params)).changes;
      }
      return deleted;
    });
  }

  async trimPubkey(pubkey: string, keep: number, opts: { kinds?: number[] } = {}): Promise<{ deleted: number; remaining: number }> {
    keep = safeInt(keep);
    const kinds = opts.kinds?.length ? inList(this.db.dialect, "kind", [...new Set(opts.kinds)], "int") : undefined;
    const match = `pubkey = ?${kinds ? ` AND ${kinds.sql}` : ""}`;
    const mp = [pubkey, ...(kinds?.params ?? [])];
    const countWhere = async (extra = "", p: unknown[] = []) =>
      toNum((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${match}${extra}`, [...mp, ...p]))?.n);
    if (this.db.dialect !== "sqlite") {
      return this.db.tx(async (tx) => {
        await lockPubkey(tx, pubkey);
        const total = toNum((await tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${match}`, mp))?.n);
        if (total <= keep) return { deleted: 0, remaining: total };
        const deleted = (
          await tx.run(`DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE ${match} ORDER BY created_at DESC, id ASC OFFSET ?)`, [...mp, keep])
        ).changes;
        return { deleted, remaining: total - deleted };
      });
    }
    // sqlite, without sorting the author's rows by id (that reads every row of the table): counts and the
    // boundary come from the (pubkey[, kind], created_at) indexes; only rows at the boundary timestamp are
    // ordered by id
    const total = await countWhere();
    if (total <= keep) return { deleted: 0, remaining: total };
    let victims: number[];
    if (keep === 0) {
      victims = (await this.db.all<{ seq: number }>(`SELECT seq FROM events WHERE ${match}`, mp)).map((r) => Number(r.seq));
    } else {
      const edge = toNum(
        (await this.db.get<{ t: number }>(`SELECT created_at AS t FROM events WHERE ${match} ORDER BY created_at DESC LIMIT 1 OFFSET ?`, [...mp, keep - 1]))?.t,
      );
      const newer = await countWhere(" AND created_at > ?", [edge]);
      const atEdge = await this.db.all<{ seq: number }>(`SELECT seq FROM events WHERE ${match} AND created_at = ? ORDER BY id ASC`, [...mp, edge]);
      const older = await this.db.all<{ seq: number }>(`SELECT seq FROM events WHERE ${match} AND created_at < ?`, [...mp, edge]);
      victims = [...atEdge.slice(keep - newer), ...older].map((r) => Number(r.seq));
    }
    const deleted = await this.deleteSeqs(victims);
    return { deleted, remaining: total - deleted };
  }

  async deleteByPubkey(pubkey: string, until?: number): Promise<number> {
    if (this.db.dialect === "sqlite") {
      const rows =
        until === undefined
          ? await this.db.all<{ seq: number }>("SELECT seq FROM events WHERE pubkey = ?", [pubkey])
          : await this.db.all<{ seq: number }>("SELECT seq FROM events WHERE pubkey = ? AND created_at <= ?", [pubkey, until]);
      return this.deleteSeqs(rows.map((r) => Number(r.seq)));
    }
    return this.db.tx(async (tx) =>
      until === undefined
        ? (await tx.run("DELETE FROM events WHERE pubkey = ?", [pubkey])).changes
        : (await tx.run("DELETE FROM events WHERE pubkey = ? AND created_at <= ?", [pubkey, until])).changes,
    );
  }

  async purgeExpired(now: number): Promise<number> {
    if (this.db.dialect === "sqlite") {
      const rows = await this.db.all<{ seq: number }>("SELECT seq FROM events WHERE expiration IS NOT NULL AND expiration <= ?", [now]);
      return this.deleteSeqs(rows.map((r) => Number(r.seq)));
    }
    return this.db.tx(
      async (tx) => (await tx.run("DELETE FROM events WHERE expiration IS NOT NULL AND expiration <= ?", [now])).changes,
    );
  }

  /**
   * sqlite: deletes events by seq in batches, with a timer turn between them. SQLite runs on the event loop: one
   * statement removing 80k events (plus their tag and FTS rows) stalled the relay for 6-9 s. The batch size adapts
   * to keep each statement near DELETE_SLICE_MS (a deleted event costs ~0.1-0.3 ms, with all its index entries).
   * Seqs are deleted in order (table and event_tags pages are then visited sequentially). Each batch is atomic, the
   * whole call is not; rows already gone (deleted or replaced meanwhile) are simply not counted.
   */
  private async deleteSeqs(seqs: number[]): Promise<number> {
    seqs.sort((a, b) => a - b);
    let deleted = 0;
    let size = this.deleteBatch;
    for (let i = 0; i < seqs.length; ) {
      if (i > 0) await yieldToEventLoop();
      const part = seqs.slice(i, i + size);
      i += part.length;
      const started = performance.now();
      // one statement text for every batch size (json list instead of a placeholder per value)
      deleted += (await this.db.run("DELETE FROM events WHERE seq IN (SELECT value FROM json_each(?))", [JSON.stringify(part)])).changes;
      const ms = performance.now() - started;
      if (ms > DELETE_SLICE_MS) size = Math.max(DELETE_BATCH_MIN, size >> 1);
      else if (ms < DELETE_SLICE_MS / 4) size = Math.min(DELETE_BATCH_MAX, size * 2);
    }
    // the next bulk delete (e.g. retention's next author) starts from the size that fit
    this.deleteBatch = size;
    return deleted;
  }

  /** `byKind` (a full GROUP BY scan) only when asked for. */
  async stats(opts: { byKind?: boolean } = {}): Promise<EventStoreStats> {
    const total = toNum((await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events"))?.n);
    const byKind = opts.byKind
      ? (
          await this.db.all<{ kind: number; n: number }>(
            "SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC, kind ASC",
          )
        ).map((r) => ({ kind: Number(r.kind), count: Number(r.n) }))
      : undefined;
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
    return byKind ? { total, byKind, sizeBytes } : { total, sizeBytes };
  }

  /** One pubkey's events per kind (most first): a range of events_pubkey_kind_created_idx, not a table scan. */
  async kindCounts(pubkey: string): Promise<{ kind: number; count: number }[]> {
    const rows = await this.db.all<{ kind: number; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM events WHERE pubkey = ? GROUP BY kind ORDER BY n DESC, kind ASC",
      [pubkey],
    );
    return rows.map((r) => ({ kind: Number(r.kind), count: Number(r.n) }));
  }

  // ------------------------------------------------------------------ filter → SQL

  /** Returns null when the filter can never match (e.g. empty id list). */
  private build(filter: Filter, o: BuildOptions): BuiltFilter | null {
    const dialect = this.db.dialect;
    const conds: string[] = [];
    const params: unknown[] = [];
    let from = "events e";
    let timeCol = "e.created_at";
    let rank: BuiltFilter["rank"];
    const add = (c: { sql: string; params: unknown[] }) => {
      conds.push(c.sql);
      params.push(...c.params);
    };

    // sqlite: a single-value tag is read from event_tags_lookup_idx (name, value, created_at DESC) in order, then
    // joined to events by seq (CROSS JOIN pins that loop order). As `e.seq IN (subquery)` the planner walks an
    // events index instead and probes the tag list per row. event_tags.created_at is written from the event and
    // never changes, so ordering by it is ordering by e.created_at (since/until also use it, on the index).
    const driveKey = o.driveByTag ? Object.keys(filter).find((k) => isTagKey(k) && singleTagValue(filter[k as `#${string}`]) !== undefined) : undefined;
    if (driveKey) {
      from = "event_tags t CROSS JOIN events e ON e.seq = t.event_seq";
      timeCol = "t.created_at";
      add({ sql: "t.name = ? AND t.value = ?", params: [driveKey.slice(1), singleTagValue(filter[driveKey as `#${string}`])] });
    }

    if (filter.ids) {
      const ids = strings(filter.ids);
      if (!ids.length) return null;
      add(inList(dialect, "e.id", ids));
    }
    if (filter.authors) {
      const authors = strings(filter.authors);
      if (!authors.length) return null;
      if (o.split !== "e.pubkey") add(inList(dialect, "e.pubkey", authors));
    }
    if (filter.kinds) {
      const kinds = [...new Set(filter.kinds.filter((k) => Number.isInteger(k)))];
      if (!kinds.length) return null;
      if (o.split !== "e.kind") add(inList(dialect, "e.kind", kinds, "int"));
    }
    if (typeof filter.since === "number") add({ sql: `${timeCol} >= ?`, params: [safeInt(filter.since)] });
    if (typeof filter.until === "number") add({ sql: `${timeCol} <= ?`, params: [safeInt(filter.until)] });

    for (const key of Object.keys(filter)) {
      if (!key.startsWith("#") || key === driveKey) continue;
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
        } else if (this.fts) {
          // CROSS JOIN pins the FTS index as the outer loop. Otherwise, without planner stats (fresh
          // database), sqlite may walk an events index and probe FTS once per row: quadratic in the
          // number of matches, and a synchronous stall of the whole relay.
          from = "events_fts CROSS JOIN events e ON e.seq = events_fts.rowid";
          add({ sql: "events_fts MATCH ?", params: [toFts5Query(terms)] });
          rank = { sql: "events_fts.rank", params: [] };
        } else {
          for (const t of terms) add({ sql: "e.content LIKE ? ESCAPE '\\'", params: [`%${escapeLike(t)}%`] });
        }
      }
    }

    const unconstrained = conds.length === 0 && !o.split;
    // NIP-40: an event is expired once now >= expiration (same boundary as core's isExpired)
    if (!o.includeExpired) add({ sql: "(e.expiration IS NULL OR e.expiration > ?)", params: [o.now] });
    return { from, timeCol, conds, params, rank, unconstrained };
  }
}

/**
 * Postgres (READ COMMITTED, many connections): serializes save() and applyDeletion() for one pubkey,
 * otherwise a save can miss a tombstone being written while the deletion misses the not-yet-inserted
 * row, and the deleted event survives. SQLite transactions are already serialized.
 */
async function lockPubkey(tx: Db, pubkey: string): Promise<void> {
  if (tx.dialect === "postgres") await tx.run("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [pubkey]);
}

/** deleteByFilter takes per-author locks only for small author lists (vanish, admin user deletes). */
const MAX_LOCKED_AUTHORS = 20;

const isTagKey = (k: string) => k.length === 2 && k[0] === "#" && SINGLE_LETTER.test(k[1]);
/** The value of a tag condition with exactly one (usable) value, else undefined. */
function singleTagValue(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = strings(raw);
  return values.length === 1 ? values[0] : undefined;
}

/** The first tag condition with exactly one (usable) value: query() drives the plan from event_tags with it. */
const singleTagKey = (filter: Filter) => Object.keys(filter).find((k) => isTagKey(k) && singleTagValue(filter[k as `#${string}`]) !== undefined);

/** Which IN list query() splits into per-value branches (see SPLIT_MAX_VALUES), if any. */
function splitOf(filter: Filter): Split | undefined {
  // a single-value tag is driven from event_tags instead
  if (singleTagKey(filter)) return undefined;
  const fits = (n: number) => n >= 2 && n <= SPLIT_MAX_VALUES;
  // authors first: each branch is then `pubkey = ? [AND kind IN (…)]` on (pubkey, kind, created_at) / (pubkey, created_at)
  const authors = filter.authors ? strings(filter.authors) : [];
  if (fits(authors.length)) return { column: "e.pubkey", values: authors };
  // per-kind branches that still carry a long authors list are no faster than one statement
  if (authors.length > 1) return undefined;
  // then a multi-value tag (more selective than kinds): one event_tags-driven branch per value
  for (const k of Object.keys(filter)) {
    const raw = filter[k as `#${string}`];
    if (!isTagKey(k) || !Array.isArray(raw)) continue;
    const values = strings(raw);
    if (fits(values.length)) return { column: "tag", key: k as `#${string}`, values };
  }
  const kinds = filter.kinds ? [...new Set(filter.kinds.filter((k) => Number.isInteger(k)))] : [];
  if (fits(kinds.length)) return { column: "e.kind", values: kinds };
  return undefined;
}

const where = (conds: string[]) => (conds.length ? ` WHERE ${conds.join(" AND ")}` : "");
/** Distinct string values; NUL-containing ones are dropped (never stored, and postgres can't bind them). */
const strings = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === "string" && !x.includes("\u0000")))];
/** Integer in [0, 2^53): larger values overflow postgres bigint (and stringify as `1e+21`). */
const safeInt = (n: number) => (Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), Number.MAX_SAFE_INTEGER) : n > 0 ? Number.MAX_SAFE_INTEGER : 0);

/** NIP-40 expiration: first `expiration` tag with a value; must match core's expirationOf. */
function expirationOf(e: NostrEvent): number | null {
  for (const t of e.tags) {
    if (t[0] !== "expiration" || t[1] === undefined) continue;
    return /^\d{1,12}$/.test(t[1]) ? Number(t[1]) : null;
  }
  return null;
}

function indexableTags(e: NostrEvent): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const t of e.tags) {
    const [name, value] = t;
    if (typeof name !== "string" || !SINGLE_LETTER.test(name) || typeof value !== "string") continue;
    // UTF-8 bytes, not UTF-16 chars: postgres btree index rows are capped at 2704 bytes
    if (value.length > MAX_INDEXED_TAG_VALUE || Buffer.byteLength(value, "utf8") > MAX_INDEXED_TAG_VALUE) continue;
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
