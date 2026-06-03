/**
 * Event store contract and storage-class helpers (NIP-01).
 */
import type { Filter, NostrEvent, StorageClass } from "../types.ts";

/** Result of attempting to store an event. */
export interface AddResult {
  /** Whether the event was persisted (false for ephemeral and stale replaceable). */
  stored: boolean;
  /** A previously stored event that this one replaced, if any. */
  replaced?: NostrEvent;
  /** Whether an event with this id was already present. */
  duplicate?: boolean;
}

/** Pluggable event storage backend. */
export interface EventStore {
  /** Store an event, applying replaceable/addressable/ephemeral semantics. */
  add(event: NostrEvent): AddResult;
  /** Query stored events across filters, newest-first, honoring each limit. */
  query(filters: Filter[], maxLimit?: number): NostrEvent[];
  /** Look up an event by id. */
  getById(id: string): NostrEvent | undefined;
  /** Number of stored events. */
  size(): number;
  /** Remove all events. */
  clear(): void;
}

/** Classify an event kind into its storage behavior. */
export function storageClass(kind: number): StorageClass {
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
    return "replaceable";
  }
  if (kind >= 20000 && kind < 30000) return "ephemeral";
  if (kind >= 30000 && kind < 40000) return "addressable";
  return "regular";
}

/** First `d` tag value of an event, or "" if none. */
export function dTag(event: NostrEvent): string {
  for (const tag of event.tags) {
    if (tag[0] === "d") return tag[1] ?? "";
  }
  return "";
}

/**
 * Whether `candidate` should replace `existing` for the same replaceable or
 * addressable slot: newer created_at wins; on a tie the lower id wins (NIP-01).
 */
export function replaces(candidate: NostrEvent, existing: NostrEvent): boolean {
  if (candidate.created_at !== existing.created_at) {
    return candidate.created_at > existing.created_at;
  }
  return candidate.id < existing.id;
}

/** Sort newest-first (created_at desc), tie-breaking by id asc. Mutates in place. */
export function sortNewestFirst(events: NostrEvent[]): NostrEvent[] {
  return events.sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
