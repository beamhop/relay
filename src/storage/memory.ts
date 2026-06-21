import { applyFilters, countEvents } from "../filter";
import { addressForEvent, expirationTimestamp, isExpired, isEphemeralKind, replaceableKeyForEvent, shouldReplace, tagValues } from "../kinds";
import { MemorySearchIndex } from "../search";
import type { CountResult, DeletedAddressRecord, DeletedEventRecord, NostrEvent, NostrFilter, QueryResult, StoreResult, VanishRecord } from "../types";
import type { EventStore } from "./types";

export interface MemorySnapshot {
  events: NostrEvent[];
  deletedEvents: DeletedEventRecord[];
  deletedAddresses: DeletedAddressRecord[];
  vanished: VanishRecord[];
}

export class MemoryEventStore implements EventStore {
  protected readonly events = new Map<string, NostrEvent>();
  protected readonly replaceableIndex = new Map<string, string>();
  protected readonly deletedEvents = new Map<string, DeletedEventRecord>();
  protected readonly deletedAddresses = new Map<string, DeletedAddressRecord>();
  protected readonly vanished = new Map<string, VanishRecord>();
  private readonly searchIndex = new MemorySearchIndex();

  async init(): Promise<void> {}

  async close(): Promise<void> {}

  async save(event: NostrEvent): Promise<StoreResult> {
    const rejectReason = await this.rejectReasonForEvent(event);
    if (rejectReason) {
      return { stored: false, duplicate: false, replacedIds: [], deletedIds: [], message: rejectReason };
    }

    if (this.events.has(event.id)) {
      return { stored: false, duplicate: true, replacedIds: [], deletedIds: [], message: "duplicate: already have this event" };
    }

    if (isEphemeralKind(event.kind)) {
      return { stored: false, duplicate: false, replacedIds: [], deletedIds: [], message: "" };
    }

    const replacedIds: string[] = [];
    const replaceableKey = replaceableKeyForEvent(event);
    if (replaceableKey) {
      const existingId = this.replaceableIndex.get(replaceableKey);
      const existing = existingId ? this.events.get(existingId) : undefined;
      if (existing && !shouldReplace(existing, event)) {
        return {
          stored: false,
          duplicate: true,
          replacedIds: [],
          deletedIds: [],
          message: "duplicate: newer replaceable event already exists",
        };
      }
      if (existing) {
        this.events.delete(existing.id);
        this.searchIndex.delete(existing);
        replacedIds.push(existing.id);
      }
      this.replaceableIndex.set(replaceableKey, event.id);
    }

    this.events.set(event.id, event);
    this.searchIndex.add(event);
    return { stored: true, duplicate: false, replacedIds, deletedIds: [], message: "" };
  }

  async has(id: string): Promise<boolean> {
    return this.events.has(id);
  }

  async get(id: string): Promise<NostrEvent | undefined> {
    return this.events.get(id);
  }

  async query(filters: NostrFilter[]): Promise<QueryResult> {
    return applyFilters(this.candidateEventsFor(filters), filters);
  }

  async count(filters: NostrFilter[]): Promise<CountResult> {
    return countEvents(this.candidateEventsFor(filters), filters);
  }

  async allEvents(): Promise<NostrEvent[]> {
    return [...this.events.values()];
  }

  async clear(): Promise<void> {
    this.events.clear();
    this.replaceableIndex.clear();
    this.deletedEvents.clear();
    this.deletedAddresses.clear();
    this.vanished.clear();
    this.searchIndex.clear();
  }

  async deleteEvent(id: string): Promise<boolean> {
    const existing = this.events.get(id);
    if (!existing) return false;
    this.events.delete(id);
    this.searchIndex.delete(existing);
    const key = replaceableKeyForEvent(existing);
    if (key && this.replaceableIndex.get(key) === id) this.replaceableIndex.delete(key);
    return true;
  }

  async deleteEventsByPubkey(pubkey: string, until: number): Promise<number> {
    let deleted = 0;
    for (const event of [...this.events.values()]) {
      if (event.pubkey === pubkey && event.created_at <= until) {
        if (await this.deleteEvent(event.id)) deleted += 1;
      }
    }
    return deleted;
  }

  async applyDeletionRequest(event: NostrEvent): Promise<number> {
    if (event.kind !== 5) return 0;
    let deleted = 0;
    for (const id of tagValues(event, "e")) {
      const existing = this.events.get(id);
      if (existing?.kind === 5) continue;
      this.deletedEvents.set(id, { id, pubkey: event.pubkey, deletedAt: event.created_at });
      if (existing && existing.pubkey === event.pubkey) {
        if (await this.deleteEvent(existing.id)) deleted += 1;
      }
    }

    for (const address of tagValues(event, "a")) {
      const parsed = parseAddress(address);
      if (!parsed || parsed.pubkey !== event.pubkey) continue;
      this.deletedAddresses.set(address, { address, pubkey: event.pubkey, until: event.created_at });
      for (const existing of [...this.events.values()]) {
        if (addressForEvent(existing) === address && existing.pubkey === event.pubkey && existing.created_at <= event.created_at) {
          if (await this.deleteEvent(existing.id)) deleted += 1;
        }
      }
    }

    return deleted;
  }

  async applyVanishRequest(event: NostrEvent, relayUrls: string[]): Promise<number> {
    if (event.kind !== 62) return 0;
    const relayTags = tagValues(event, "relay");
    const applies = relayTags.includes("ALL_RELAYS") || relayUrls.some((relayUrl) => relayTags.includes(relayUrl));
    if (!applies) return 0;
    this.vanished.set(event.pubkey, { pubkey: event.pubkey, until: event.created_at });
    let deleted = await this.deleteEventsByPubkey(event.pubkey, event.created_at);
    for (const giftWrap of [...this.events.values()]) {
      if (giftWrap.kind === 1059 && tagValues(giftWrap, "p").includes(event.pubkey)) {
        if (await this.deleteEvent(giftWrap.id)) deleted += 1;
      }
    }
    return deleted;
  }

  async rejectReasonForEvent(event: NostrEvent): Promise<string | undefined> {
    if (isExpired(event)) return "invalid: event is expired";

    const vanish = this.vanished.get(event.pubkey);
    if (vanish && event.created_at <= vanish.until) {
      return "blocked: pubkey has requested vanish for this timestamp";
    }

    const deletedEvent = this.deletedEvents.get(event.id);
    if (deletedEvent && deletedEvent.pubkey === event.pubkey && event.created_at <= deletedEvent.deletedAt) {
      return "blocked: event was deleted by its author";
    }

    const address = addressForEvent(event);
    if (address) {
      const deletedAddress = this.deletedAddresses.get(address);
      if (deletedAddress && event.pubkey === deletedAddress.pubkey && event.created_at <= deletedAddress.until) {
        return "blocked: replaceable event was deleted by its author";
      }
    }

    return undefined;
  }

  hydrate(snapshot: MemorySnapshot): void {
    this.events.clear();
    this.replaceableIndex.clear();
    this.deletedEvents.clear();
    this.deletedAddresses.clear();
    this.vanished.clear();
    this.searchIndex.clear();

    for (const event of snapshot.events) {
      if (isExpired(event)) continue;
      this.events.set(event.id, event);
      this.searchIndex.add(event);
      const key = replaceableKeyForEvent(event);
      if (key) {
        const existingId = this.replaceableIndex.get(key);
        const existing = existingId ? this.events.get(existingId) : undefined;
        if (!existing || shouldReplace(existing, event)) this.replaceableIndex.set(key, event.id);
      }
    }
    for (const record of snapshot.deletedEvents) this.deletedEvents.set(record.id, record);
    for (const record of snapshot.deletedAddresses) this.deletedAddresses.set(record.address, record);
    for (const record of snapshot.vanished) this.vanished.set(record.pubkey, record);
  }

  snapshot(): MemorySnapshot {
    return {
      events: [...this.events.values()],
      deletedEvents: [...this.deletedEvents.values()],
      deletedAddresses: [...this.deletedAddresses.values()],
      vanished: [...this.vanished.values()],
    };
  }

  private candidateEventsFor(filters: NostrFilter[]): NostrEvent[] {
    if (!filters.every((filter) => typeof filter.search === "string" && filter.search.trim())) return [...this.events.values()];

    const ids = new Set<string>();
    for (const filter of filters) {
      for (const id of this.searchIndex.searchIds(filter.search as string)) ids.add(id);
    }
    return [...ids].map((id) => this.events.get(id)).filter((event): event is NostrEvent => event !== undefined);
  }
}

function parseAddress(address: string): { kind: number; pubkey: string; d: string } | undefined {
  const [kindText, pubkey, ...dParts] = address.split(":");
  const kind = Number(kindText);
  if (!Number.isSafeInteger(kind) || !pubkey) return undefined;
  return { kind, pubkey, d: dParts.join(":") };
}
