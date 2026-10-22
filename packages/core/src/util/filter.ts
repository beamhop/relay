import type { Filter, NostrEvent } from "@beamhop/sdk";

/** Very small NIP-50 matcher used for live delivery: all plain terms must occur (case-insensitive). */
export function matchSearch(search: string, event: NostrEvent): boolean {
  const terms = search
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !/^[a-z_]+:/.test(t)); // drop extensions like "language:en"
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
      if (t[0] === name && t[1] !== undefined && values.includes(t[1])) {
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
