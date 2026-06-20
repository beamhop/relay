import postgres from "postgres";
import { computeHll, isHllEligible } from "../filter";
import { sortEventsForRelay } from "../filter";
import { addressForEvent, expirationTimestamp, isEphemeralKind, isExpired, replaceableKeyForEvent, shouldReplace, tagValues } from "../kinds";
import { buildPostgresTsQuery, searchVectorText } from "../search";
import type { CountResult, NostrEvent, NostrFilter, QueryResult, StoreResult } from "../types";
import type { EventStore } from "./types";

type Sql = postgres.Sql;
type TxSql = postgres.TransactionSql<Record<string, never>>;

export type PostgresStoreOptions = string | Record<string, unknown>;

interface EventRow {
  id: string;
  pubkey: string;
  created_at: string;
  kind: number;
  content: string;
  sig: string;
  tags: string[][];
}

/**
 * SQL-native event store (ADR-0002). Postgres is the single source of truth: reads are indexed
 * SQL queries and writes are incremental upserts. No RAM mirror, no snapshot dumps. This is a
 * production-only backend; the standalone path never imports it (ADR-0001).
 */
export class PostgresEventStore implements EventStore {
  private readonly sql: Sql;
  private readonly schema: string | undefined;

  constructor(options: PostgresStoreOptions, schema?: string) {
    if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
      throw new Error(`invalid postgres schema name: ${schema}`);
    }
    this.schema = schema;
    // Silence NOTICE chatter (e.g. "relation already exists" from idempotent DDL on boot).
    // Pin search_path to our schema so unqualified table names never collide with another app's
    // tables in the same database (e.g. a prior relay's public.events). See init().
    const base: Record<string, unknown> = { onnotice: () => {} };
    if (schema) base.connection = { search_path: schema };
    this.sql = typeof options === "string"
      ? postgres(options, base as postgres.Options<Record<string, never>>)
      : postgres({ ...options, ...base } as postgres.Options<Record<string, never>>);
  }

  async init(): Promise<void> {
    const schemaDdl = this.schema ? `CREATE SCHEMA IF NOT EXISTS "${this.schema}";\n` : "";
    await this.sql.unsafe(`
      ${schemaDdl}CREATE TABLE IF NOT EXISTS events (
        id text PRIMARY KEY,
        pubkey text NOT NULL,
        created_at bigint NOT NULL,
        kind integer NOT NULL,
        content text NOT NULL,
        sig text NOT NULL,
        tags jsonb NOT NULL DEFAULT '[]'::jsonb,
        address text,
        expires_at bigint,
        search tsvector
      );
      CREATE INDEX IF NOT EXISTS events_pubkey_idx ON events (pubkey);
      CREATE INDEX IF NOT EXISTS events_kind_idx ON events (kind);
      CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at DESC);
      CREATE INDEX IF NOT EXISTS events_kind_created_idx ON events (kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS events_address_idx ON events (address) WHERE address IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_expires_at_idx ON events (expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_search_idx ON events USING gin (search);

      CREATE TABLE IF NOT EXISTS event_tags (
        event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        tag text NOT NULL,
        value text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_tags_tag_value_idx ON event_tags (tag, value);
      CREATE INDEX IF NOT EXISTS event_tags_event_idx ON event_tags (event_id);

      CREATE TABLE IF NOT EXISTS deleted_events (
        id text PRIMARY KEY,
        pubkey text NOT NULL,
        deleted_at bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deleted_addresses (
        address text PRIMARY KEY,
        pubkey text NOT NULL,
        until bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vanished_pubkeys (
        pubkey text PRIMARY KEY,
        until bigint NOT NULL
      );
    `);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async save(event: NostrEvent): Promise<StoreResult> {
    const rejectReason = await this.rejectReasonForEvent(event);
    if (rejectReason) {
      return { stored: false, duplicate: false, replacedIds: [], deletedIds: [], message: rejectReason };
    }
    if (await this.has(event.id)) {
      return { stored: false, duplicate: true, replacedIds: [], deletedIds: [], message: "duplicate: already have this event" };
    }
    if (isEphemeralKind(event.kind)) {
      return { stored: false, duplicate: false, replacedIds: [], deletedIds: [], message: "" };
    }

    const replaceableKey = replaceableKeyForEvent(event);
    return this.sql.begin(async (sql) => {
      const replacedIds: string[] = [];
      if (replaceableKey) {
        const existing = await sql<{ id: string; created_at: string }[]>`
          SELECT id, created_at FROM events WHERE address = ${replaceableKey}
        `;
        const newest = existing.reduce<{ id: string; created_at: number } | undefined>((best, row) => {
          const candidate = { id: row.id, created_at: Number(row.created_at) };
          if (!best) return candidate;
          return shouldReplace(best as NostrEvent, candidate as NostrEvent) ? candidate : best;
        }, undefined);
        if (newest && !shouldReplace(newest as NostrEvent, event)) {
          return { stored: false, duplicate: true, replacedIds: [], deletedIds: [], message: "duplicate: newer replaceable event already exists" };
        }
        for (const row of existing) {
          await sql`DELETE FROM events WHERE id = ${row.id}`;
          replacedIds.push(row.id);
        }
      }
      await this.insertEvent(sql, event);
      return { stored: true, duplicate: false, replacedIds, deletedIds: [], message: "" };
    });
  }

  async has(id: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM events WHERE id = ${id} LIMIT 1`;
    return rows.length > 0;
  }

  async get(id: string): Promise<NostrEvent | undefined> {
    const rows = await this.sql<EventRow[]>`
      SELECT id, pubkey, created_at, kind, content, sig, tags FROM events WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? rowToEvent(rows[0]) : undefined;
  }

  async query(filters: NostrFilter[]): Promise<QueryResult> {
    const now = Math.floor(Date.now() / 1000);
    const byId = new Map<string, NostrEvent>();
    let complete = true;
    let hasSearch = false;

    for (const filter of filters) {
      const params: unknown[] = [];
      const where = buildWhere(filter, params, now);
      const searchTsQuery = typeof filter.search === "string" ? buildPostgresTsQuery(filter.search) : undefined;
      const order = filter.search && searchTsQuery
        ? `ts_rank(e.search, to_tsquery('simple', ${pushParam(params, searchTsQuery)})) DESC, e.created_at DESC, e.id ASC`
        : "e.created_at DESC, e.id ASC";
      const limit = typeof filter.limit === "number" ? filter.limit : Number.MAX_SAFE_INTEGER;
      const fetch = Number.isFinite(limit) ? Math.min(limit + 1, Number.MAX_SAFE_INTEGER) : limit;

      const rows = await this.sql.unsafe<EventRow[]>(
        `SELECT e.id, e.pubkey, e.created_at, e.kind, e.content, e.sig, e.tags FROM events e WHERE ${where} ORDER BY ${order} LIMIT ${Math.floor(fetch)}`,
        params as never[],
      );

      if (rows.length > limit) complete = false;
      for (const row of rows.slice(0, limit)) byId.set(row.id, rowToEvent(row));
      if (filter.search) hasSearch = true;
    }

    const values = [...byId.values()];
    return { events: hasSearch ? values : sortEventsForRelay(values), complete };
  }

  async count(filters: NostrFilter[]): Promise<CountResult> {
    const now = Math.floor(Date.now() / 1000);
    const params: unknown[] = [];
    const clauses = filters.map((filter) => `(${buildWhere(filter, params, now)})`);
    const where = clauses.length > 0 ? clauses.join(" OR ") : "TRUE";
    const [row] = await this.sql.unsafe<{ count: string }[]>(
      `SELECT count(*)::bigint AS count FROM events e WHERE ${where}`,
      params as never[],
    );
    const result: CountResult = { count: Number(row?.count ?? 0) };

    if (filters.length === 1 && isHllEligible(filters[0] as NostrFilter)) {
      const hllParams: unknown[] = [];
      const hllWhere = buildWhere(filters[0] as NostrFilter, hllParams, now);
      const pubkeys = await this.sql.unsafe<{ pubkey: string }[]>(
        `SELECT DISTINCT e.pubkey FROM events e WHERE ${hllWhere}`,
        hllParams as never[],
      );
      result.hll = computeHll(pubkeys, filters[0] as NostrFilter);
    }
    return result;
  }

  async allEvents(): Promise<NostrEvent[]> {
    const rows = await this.sql<EventRow[]>`SELECT id, pubkey, created_at, kind, content, sig, tags FROM events`;
    return rows.map(rowToEvent);
  }

  async deleteEvent(id: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM events WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  async deleteEventsByPubkey(pubkey: string, until: number): Promise<number> {
    const rows = await this.sql`DELETE FROM events WHERE pubkey = ${pubkey} AND created_at <= ${until} RETURNING id`;
    return rows.length;
  }

  async applyDeletionRequest(event: NostrEvent): Promise<number> {
    if (event.kind !== 5) return 0;
    let deleted = 0;

    for (const id of tagValues(event, "e")) {
      const existing = await this.sql<{ pubkey: string; kind: number }[]>`
        SELECT pubkey, kind FROM events WHERE id = ${id} LIMIT 1
      `;
      if (existing[0]?.kind === 5) continue;
      await this.sql`
        INSERT INTO deleted_events (id, pubkey, deleted_at) VALUES (${id}, ${event.pubkey}, ${event.created_at})
        ON CONFLICT (id) DO UPDATE SET pubkey = EXCLUDED.pubkey, deleted_at = EXCLUDED.deleted_at
      `;
      if (existing[0] && existing[0].pubkey === event.pubkey) {
        if (await this.deleteEvent(id)) deleted += 1;
      }
    }

    for (const address of tagValues(event, "a")) {
      const parsed = parseAddress(address);
      if (!parsed || parsed.pubkey !== event.pubkey) continue;
      await this.sql`
        INSERT INTO deleted_addresses (address, pubkey, until) VALUES (${address}, ${event.pubkey}, ${event.created_at})
        ON CONFLICT (address) DO UPDATE SET pubkey = EXCLUDED.pubkey, until = EXCLUDED.until
      `;
      const rows = await this.sql`
        DELETE FROM events WHERE address = ${address} AND pubkey = ${event.pubkey} AND created_at <= ${event.created_at} RETURNING id
      `;
      deleted += rows.length;
    }

    return deleted;
  }

  async applyVanishRequest(event: NostrEvent, relayUrls: string[]): Promise<number> {
    if (event.kind !== 62) return 0;
    const relayTags = tagValues(event, "relay");
    const applies = relayTags.includes("ALL_RELAYS") || relayUrls.some((relayUrl) => relayTags.includes(relayUrl));
    if (!applies) return 0;

    await this.sql`
      INSERT INTO vanished_pubkeys (pubkey, until) VALUES (${event.pubkey}, ${event.created_at})
      ON CONFLICT (pubkey) DO UPDATE SET until = EXCLUDED.until
    `;
    let deleted = await this.deleteEventsByPubkey(event.pubkey, event.created_at);
    const wraps = await this.sql`
      DELETE FROM events e WHERE e.kind = 1059 AND EXISTS (
        SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND t.tag = 'p' AND t.value = ${event.pubkey}
      ) RETURNING e.id
    `;
    deleted += wraps.length;
    return deleted;
  }

  async rejectReasonForEvent(event: NostrEvent): Promise<string | undefined> {
    if (isExpired(event)) return "invalid: event is expired";

    const vanish = await this.sql<{ until: string }[]>`SELECT until FROM vanished_pubkeys WHERE pubkey = ${event.pubkey} LIMIT 1`;
    if (vanish[0] && event.created_at <= Number(vanish[0].until)) {
      return "blocked: pubkey has requested vanish for this timestamp";
    }

    const deletedEvent = await this.sql<{ pubkey: string; deleted_at: string }[]>`
      SELECT pubkey, deleted_at FROM deleted_events WHERE id = ${event.id} LIMIT 1
    `;
    if (deletedEvent[0] && deletedEvent[0].pubkey === event.pubkey && event.created_at <= Number(deletedEvent[0].deleted_at)) {
      return "blocked: event was deleted by its author";
    }

    const address = addressForEvent(event);
    if (address) {
      const deletedAddress = await this.sql<{ pubkey: string; until: string }[]>`
        SELECT pubkey, until FROM deleted_addresses WHERE address = ${address} LIMIT 1
      `;
      if (deletedAddress[0] && deletedAddress[0].pubkey === event.pubkey && event.created_at <= Number(deletedAddress[0].until)) {
        return "blocked: replaceable event was deleted by its author";
      }
    }

    return undefined;
  }

  private async insertEvent(sql: TxSql, event: NostrEvent): Promise<void> {
    const address = replaceableKeyForEvent(event) ?? null;
    const expiresAt = expirationTimestamp(event) ?? null;
    const vectorText = searchVectorText(event);
    await sql`
      INSERT INTO events (id, pubkey, created_at, kind, content, sig, tags, address, expires_at, search)
      VALUES (
        ${event.id}, ${event.pubkey}, ${event.created_at}, ${event.kind}, ${event.content}, ${event.sig},
        ${sql.json(event.tags)}, ${address}, ${expiresAt}, to_tsvector('simple', ${vectorText})
      )
    `;

    const tagRows = event.tags
      .filter((tag) => typeof tag[0] === "string" && tag[0].length === 1 && typeof tag[1] === "string")
      .map((tag) => ({ event_id: event.id, tag: tag[0] as string, value: tag[1] as string }));
    if (tagRows.length > 0) {
      await sql`INSERT INTO event_tags ${sql(tagRows, "event_id", "tag", "value")}`;
    }
  }
}

function rowToEvent(row: EventRow): NostrEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: Number(row.created_at),
    kind: row.kind,
    tags: row.tags,
    content: row.content,
    sig: row.sig,
  };
}

function pushParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function buildWhere(filter: NostrFilter, params: unknown[], nowSeconds: number): string {
  const clauses: string[] = ["TRUE"];

  if (Array.isArray(filter.ids)) clauses.push(`e.id = ANY(${pushParam(params, filter.ids)})`);
  if (Array.isArray(filter.authors)) clauses.push(`e.pubkey = ANY(${pushParam(params, filter.authors)})`);
  if (Array.isArray(filter.kinds)) clauses.push(`e.kind = ANY(${pushParam(params, filter.kinds)})`);
  if (typeof filter.since === "number") clauses.push(`e.created_at >= ${pushParam(params, filter.since)}`);
  if (typeof filter.until === "number") clauses.push(`e.created_at <= ${pushParam(params, filter.until)}`);

  clauses.push(`(e.expires_at IS NULL OR e.expires_at > ${pushParam(params, nowSeconds)})`);

  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(value)) continue;
    const name = key.slice(1);
    const values = value.filter((item): item is string => typeof item === "string");
    // NIP-01 only indexes single-letter tags; non-indexed tag filters match nothing.
    if (name.length !== 1) {
      clauses.push("FALSE");
      continue;
    }
    clauses.push(
      `EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND t.tag = ${pushParam(params, name)} AND t.value = ANY(${pushParam(params, values)}))`,
    );
  }

  if (typeof filter.search === "string" && filter.search.trim()) {
    const tsQuery = buildPostgresTsQuery(filter.search);
    if (!tsQuery) clauses.push("FALSE");
    else clauses.push(`e.search @@ to_tsquery('simple', ${pushParam(params, tsQuery)})`);
  }

  return clauses.join(" AND ");
}

function parseAddress(address: string): { kind: number; pubkey: string; d: string } | undefined {
  const [kindText, pubkey, ...dParts] = address.split(":");
  const kind = Number(kindText);
  if (!Number.isSafeInteger(kind) || !pubkey) return undefined;
  return { kind, pubkey, d: dParts.join(":") };
}
