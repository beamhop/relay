/**
 * In-memory event store (default backend).
 */
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

export class MemoryEventStore implements EventStore {
  private readonly byId: Map<string, NostrEvent>;
  /** key: `${pubkey}:${kind}` */
  private readonly replaceable: Map<string, NostrEvent>;
  /** key: `${pubkey}:${kind}:${dTag}` */
  private readonly addressable: Map<string, NostrEvent>;

  constructor() {
    this.byId = new Map();
    this.replaceable = new Map();
    this.addressable = new Map();
  }

  add(event: NostrEvent): AddResult {
    if (this.byId.has(event.id)) return { stored: false, duplicate: true };

    const cls = storageClass(event.kind);
    if (cls === "ephemeral") return { stored: false };

    if (cls === "replaceable" || cls === "addressable") {
      const map = cls === "replaceable" ? this.replaceable : this.addressable;
      const key =
        cls === "replaceable"
          ? `${event.pubkey}:${event.kind}`
          : `${event.pubkey}:${event.kind}:${dTag(event)}`;
      const existing = map.get(key);
      if (existing) {
        if (!replaces(event, existing)) return { stored: false };
        this.byId.delete(existing.id);
        map.set(key, event);
        this.byId.set(event.id, event);
        return { stored: true, replaced: existing };
      }
      map.set(key, event);
      this.byId.set(event.id, event);
      return { stored: true };
    }

    // regular
    this.byId.set(event.id, event);
    return { stored: true };
  }

  query(filters: Filter[], maxLimit?: number): NostrEvent[] {
    const seen = new Set<string>();
    const result: NostrEvent[] = [];

    for (const filter of filters) {
      const compiled = compileFilter(filter);
      const matches: NostrEvent[] = [];
      for (const event of this.byId.values()) {
        if (matchCompiled(event, compiled)) matches.push(event);
      }
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

    // A single filter's results are already sorted and contain no duplicates,
    // so the merge re-sort is only needed when combining multiple filters.
    return filters.length > 1 ? sortNewestFirst(result) : result;
  }

  getById(id: string): NostrEvent | undefined {
    return this.byId.get(id);
  }

  size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.replaceable.clear();
    this.addressable.clear();
  }

  delete(id: string): boolean {
    const event = this.byId.get(id);
    if (!event) return false;
    this.byId.delete(id);
    this.dropFromReplIndex(event);
    return true;
  }

  deleteByAuthor(pubkey: string, until?: number): number {
    let removed = 0;
    for (const event of [...this.byId.values()]) {
      if (event.pubkey !== pubkey) continue;
      if (until !== undefined && event.created_at > until) continue;
      this.byId.delete(event.id);
      this.dropFromReplIndex(event);
      removed++;
    }
    return removed;
  }

  count(filters: Filter[]): number {
    const seen = new Set<string>();
    for (const filter of filters) {
      const compiled = compileFilter(filter);
      for (const event of this.byId.values()) {
        if (!seen.has(event.id) && matchCompiled(event, compiled)) seen.add(event.id);
      }
    }
    return seen.size;
  }

  /** Remove an event from the replaceable/addressable index if it is the slot holder. */
  private dropFromReplIndex(event: NostrEvent): void {
    const cls = storageClass(event.kind);
    if (cls === "replaceable") {
      const key = `${event.pubkey}:${event.kind}`;
      if (this.replaceable.get(key)?.id === event.id) this.replaceable.delete(key);
    } else if (cls === "addressable") {
      const key = `${event.pubkey}:${event.kind}:${dTag(event)}`;
      if (this.addressable.get(key)?.id === event.id) this.addressable.delete(key);
    }
  }
}

function effectiveLimit(
  filterLimit: number | undefined,
  maxLimit: number | undefined,
): number | undefined {
  if (filterLimit === undefined) return maxLimit;
  if (maxLimit === undefined) return filterLimit;
  return Math.min(filterLimit, maxLimit);
}
