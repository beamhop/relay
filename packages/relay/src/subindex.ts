// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Inverted subscription index for live fan-out.
 *
 * Each filter is registered under exactly ONE dimension that any matching
 * event is guaranteed to hit: `ids` → `authors` → tag values → `kinds`,
 * falling back to a catch-all list. A filter with an empty array on any
 * dimension can never match and is not indexed. Matching an event therefore
 * only visits filters in the buckets keyed by the event's id, pubkey, kind
 * and single-letter tag values (plus catch-alls), then confirms each
 * candidate with the full NIP-01 `matchFilter`.
 */
import { type Filter, type NostrEvent, matchFilter, tagFilterEntries } from '@beamhop/core';

export interface IndexedSub {
  /** Unique key of the subscription (e.g. `${connId}\u0000${subId}`). */
  readonly key: string;
  readonly filters: Filter[];
}

interface Entry<S extends IndexedSub> {
  sub: S;
  filter: Filter;
  bucket: Set<Entry<S>> | null;
  bucketMap: Map<string | number, Set<Entry<S>>> | null;
  bucketKeys: Array<string | number>;
}

/** Lowercased, whitespace-split terms (ignoring `key:value` extensions) must all occur in content. */
export function searchMatches(search: string, e: NostrEvent): boolean {
  const hay = e.content.toLowerCase();
  for (const t of search.toLowerCase().split(/\s+/)) {
    if (!t || t.includes(':')) continue;
    if (!hay.includes(t)) return false;
  }
  return true;
}

export function matchLive(filter: Filter, event: NostrEvent): boolean {
  if (!matchFilter(filter, event)) return false;
  return !filter.search || searchMatches(filter.search, event);
}

export class SubscriptionIndex<S extends IndexedSub = IndexedSub> {
  private byId = new Map<string | number, Set<Entry<S>>>();
  private byAuthor = new Map<string | number, Set<Entry<S>>>();
  private byKind = new Map<string | number, Set<Entry<S>>>();
  /** Key: `${tagName}:${value}`. */
  private byTag = new Map<string | number, Set<Entry<S>>>();
  private catchAll = new Set<Entry<S>>();
  private entries = new Map<string, Entry<S>[]>();

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  add(sub: S): void {
    this.remove(sub.key);
    const list: Entry<S>[] = [];
    for (const filter of sub.filters) {
      const entry = this.place(sub, filter);
      if (entry) list.push(entry);
    }
    this.entries.set(sub.key, list);
  }

  remove(key: string): boolean {
    const list = this.entries.get(key);
    if (!list) return false;
    for (const e of list) {
      if (e.bucket) e.bucket.delete(e);
      else if (e.bucketMap) {
        for (const k of e.bucketKeys) {
          const set = e.bucketMap.get(k);
          if (!set) continue;
          set.delete(e);
          if (set.size === 0) e.bucketMap.delete(k);
        }
      }
    }
    this.entries.delete(key);
    return true;
  }

  /** Subscriptions (each at most once) with at least one filter matching `event`. */
  match(event: NostrEvent): S[] {
    const out: S[] = [];
    const seen = new Set<string>();
    const visit = (set: Set<Entry<S>> | undefined) => {
      if (!set) return;
      for (const e of set) {
        if (seen.has(e.sub.key)) continue;
        if (matchLive(e.filter, event)) {
          seen.add(e.sub.key);
          out.push(e.sub);
        }
      }
    };
    visit(this.byId.get(event.id));
    visit(this.byAuthor.get(event.pubkey));
    if (this.byTag.size > 0) {
      for (const t of event.tags) {
        const name = t[0];
        const value = t[1];
        if (name === undefined || name.length !== 1 || value === undefined) continue;
        visit(this.byTag.get(`${name}:${value}`));
      }
    }
    visit(this.byKind.get(event.kind));
    visit(this.catchAll);
    return out;
  }

  private place(sub: S, filter: Filter): Entry<S> | null {
    const entry: Entry<S> = { sub, filter, bucket: null, bucketMap: null, bucketKeys: [] };
    const tags = tagFilterEntries(filter);
    // Empty arrays can never match.
    if (filter.ids?.length === 0 || filter.authors?.length === 0 || filter.kinds?.length === 0)
      return null;
    for (const [, values] of tags) if (values.length === 0) return null;

    let map: Map<string | number, Set<Entry<S>>> | null = null;
    let keys: Array<string | number> = [];
    if (filter.ids) {
      map = this.byId;
      keys = filter.ids;
    } else if (filter.authors) {
      map = this.byAuthor;
      keys = filter.authors;
    } else if (tags.length > 0) {
      // Pick the tag dimension with the fewest values (most selective).
      let best = tags[0]!;
      for (const t of tags) if (t[1].length < best[1].length) best = t;
      map = this.byTag;
      keys = best[1].map((v) => `${best[0]}:${v}`);
    } else if (filter.kinds) {
      map = this.byKind;
      keys = filter.kinds;
    }
    if (!map) {
      this.catchAll.add(entry);
      entry.bucket = this.catchAll;
      return entry;
    }
    const unique = [...new Set(keys)];
    for (const k of unique) {
      let set = map.get(k);
      if (!set) {
        set = new Set();
        map.set(k, set);
      }
      set.add(entry);
    }
    entry.bucketMap = map;
    entry.bucketKeys = unique;
    return entry;
  }
}
