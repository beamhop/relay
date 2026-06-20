import { Database } from "bun:sqlite";
import { MemoryEventStore, type MemorySnapshot } from "./memory";
import type { EventStore } from "./types";
import type { CountResult, NostrEvent, NostrFilter, QueryResult, StoreResult } from "../types";

interface EventRow {
  event_json: string;
}

interface DeletedEventRow {
  id: string;
  pubkey: string;
  deleted_at: number;
}

interface DeletedAddressRow {
  address: string;
  pubkey: string;
  until: number;
}

interface VanishedRow {
  pubkey: string;
  until: number;
}

export class SqliteEventStore implements EventStore {
  private readonly db: Database;
  private readonly memory = new MemoryEventStore();

  constructor(path: string) {
    this.db = new Database(path, { create: true });
  }

  async init(): Promise<void> {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        kind INTEGER NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE TABLE IF NOT EXISTS deleted_events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deleted_addresses (
        address TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vanished_pubkeys (
        pubkey TEXT PRIMARY KEY,
        until INTEGER NOT NULL
      );
    `);
    this.memory.hydrate(this.loadSnapshot());
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async save(event: NostrEvent): Promise<StoreResult> {
    const result = await this.memory.save(event);
    this.syncSnapshot();
    return result;
  }

  async has(id: string): Promise<boolean> {
    return this.memory.has(id);
  }

  async get(id: string): Promise<NostrEvent | undefined> {
    return this.memory.get(id);
  }

  async query(filters: NostrFilter[]): Promise<QueryResult> {
    return this.memory.query(filters);
  }

  async count(filters: NostrFilter[]): Promise<CountResult> {
    return this.memory.count(filters);
  }

  async allEvents(): Promise<NostrEvent[]> {
    return this.memory.allEvents();
  }

  async deleteEvent(id: string, reason?: string): Promise<boolean> {
    const deleted = await this.memory.deleteEvent(id);
    if (deleted) this.syncSnapshot();
    return deleted;
  }

  async deleteEventsByPubkey(pubkey: string, until: number): Promise<number> {
    const deleted = await this.memory.deleteEventsByPubkey(pubkey, until);
    if (deleted) this.syncSnapshot();
    return deleted;
  }

  async applyDeletionRequest(event: NostrEvent): Promise<number> {
    const deleted = await this.memory.applyDeletionRequest(event);
    this.syncSnapshot();
    return deleted;
  }

  async applyVanishRequest(event: NostrEvent, relayUrls: string[]): Promise<number> {
    const deleted = await this.memory.applyVanishRequest(event, relayUrls);
    this.syncSnapshot();
    return deleted;
  }

  async rejectReasonForEvent(event: NostrEvent): Promise<string | undefined> {
    return this.memory.rejectReasonForEvent(event);
  }

  private loadSnapshot(): MemorySnapshot {
    const events = this.db
      .query<EventRow, []>("SELECT event_json FROM events")
      .all()
      .map((row) => JSON.parse(row.event_json) as NostrEvent);
    const deletedEvents = this.db
      .query<DeletedEventRow, []>("SELECT id, pubkey, deleted_at FROM deleted_events")
      .all()
      .map((row) => ({ id: row.id, pubkey: row.pubkey, deletedAt: row.deleted_at }));
    const deletedAddresses = this.db
      .query<DeletedAddressRow, []>("SELECT address, pubkey, until FROM deleted_addresses")
      .all()
      .map((row) => ({ address: row.address, pubkey: row.pubkey, until: row.until }));
    const vanished = this.db
      .query<VanishedRow, []>("SELECT pubkey, until FROM vanished_pubkeys")
      .all()
      .map((row) => ({ pubkey: row.pubkey, until: row.until }));
    return { events, deletedEvents, deletedAddresses, vanished };
  }

  private syncSnapshot(): void {
    const snapshot = this.memory.snapshot();
    const transaction = this.db.transaction(() => {
      this.db.exec("DELETE FROM events; DELETE FROM deleted_events; DELETE FROM deleted_addresses; DELETE FROM vanished_pubkeys;");
      const insertEvent = this.db.query("INSERT INTO events (id, pubkey, created_at, kind, event_json) VALUES (?, ?, ?, ?, ?)");
      for (const event of snapshot.events) {
        insertEvent.run(event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event));
      }
      const insertDeletedEvent = this.db.query("INSERT INTO deleted_events (id, pubkey, deleted_at) VALUES (?, ?, ?)");
      for (const record of snapshot.deletedEvents) insertDeletedEvent.run(record.id, record.pubkey, record.deletedAt);
      const insertDeletedAddress = this.db.query("INSERT INTO deleted_addresses (address, pubkey, until) VALUES (?, ?, ?)");
      for (const record of snapshot.deletedAddresses) insertDeletedAddress.run(record.address, record.pubkey, record.until);
      const insertVanished = this.db.query("INSERT INTO vanished_pubkeys (pubkey, until) VALUES (?, ?)");
      for (const record of snapshot.vanished) insertVanished.run(record.pubkey, record.until);
    });
    transaction();
  }
}
