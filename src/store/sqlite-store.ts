/**
 * SQLite-backed event store (opt-in persistence via bun:sqlite).
 * Implements the same EventStore contract and storage semantics as the
 * in-memory store. Filter matching reuses matchFilter for parity.
 */
import { Database } from "bun:sqlite";
import { matchFilter } from "../filter.ts";
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
    const all = this.db.query("SELECT * FROM events").all() as Row[];
    const events = all.map(rowToEvent);

    const seen = new Set<string>();
    const result: NostrEvent[] = [];
    for (const filter of filters) {
      const matches = events.filter((e) => matchFilter(e, filter));
      sortNewestFirst(matches);
      const limit = effectiveLimit(filter.limit, maxLimit);
      const limited = limit === undefined ? matches : matches.slice(0, limit);
      for (const event of limited) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          result.push(event);
        }
      }
    }
    return sortNewestFirst(result);
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
    const all = this.db.query("SELECT * FROM events").all() as Row[];
    const events = all.map(rowToEvent);
    const seen = new Set<string>();
    for (const filter of filters) {
      for (const event of events) {
        if (!seen.has(event.id) && matchFilter(event, filter)) seen.add(event.id);
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
