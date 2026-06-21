import type { CountResult, NostrEvent, NostrFilter, QueryResult, StoreResult } from "../types";

export interface EventStore {
  init(): Promise<void>;
  close(): Promise<void>;
  save(event: NostrEvent): Promise<StoreResult>;
  has(id: string): Promise<boolean>;
  get(id: string): Promise<NostrEvent | undefined>;
  query(filters: NostrFilter[]): Promise<QueryResult>;
  count(filters: NostrFilter[]): Promise<CountResult>;
  allEvents(): Promise<NostrEvent[]>;
  clear(): Promise<void>;
  deleteEvent(id: string, reason?: string): Promise<boolean>;
  deleteEventsByPubkey(pubkey: string, until: number): Promise<number>;
  applyDeletionRequest(event: NostrEvent): Promise<number>;
  applyVanishRequest(event: NostrEvent, relayUrls: string[]): Promise<number>;
  rejectReasonForEvent(event: NostrEvent): Promise<string | undefined>;
}
