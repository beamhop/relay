import type { Filter, NostrEvent } from "@beamhop/sdk";

/** NIP-50 extensions (`key:value`) — ignored for matching, as the spec allows. */
const SEARCH_EXTENSION = /^(include|domain|language|sentiment|nsfw):/;
/** Tag values longer than this aren't indexed by the store, so live matching ignores them too. */
export const MAX_MATCHED_TAG_VALUE = 1024;

/**
 * Small NIP-50 matcher used for live delivery: every term (or "quoted phrase") must occur in the
 * content, case-insensitively. Mirrors the stored full-text search closely enough for live events.
 */
export function matchSearch(search: string, event: NostrEvent): boolean {
  const terms: string[] = [];
  for (const m of search.toLowerCase().matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim();
    if (t && (m[1] !== undefined || !SEARCH_EXTENSION.test(t))) terms.push(t);
  }
  if (!terms.length) return true;
  const content = event.content.toLowerCase();
  return terms.every((t) => content.includes(t));
}

/** NIP-01 filter matching (exact ids/authors; single-letter tag filters). */
export function matchFilter(filter: Filter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const key in filter) {
    if (key.charCodeAt(0) !== 35 /* # */) continue;
    const values = filter[key as `#${string}`];
    if (!values) continue;
    const name = key.slice(1);
    let ok = false;
    for (const t of event.tags) {
      if (t[0] === name && t[1] !== undefined && t[1].length <= MAX_MATCHED_TAG_VALUE && values.includes(t[1])) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (filter.search !== undefined && !matchSearch(filter.search, event)) return false;
  return true;
}

export function matchFilters(filters: Filter[], event: NostrEvent): boolean {
  for (const f of filters) if (matchFilter(f, event)) return true;
  return false;
}
