/**
 * Filter matching per NIP-01. Conditions within a filter are ANDed; multiple
 * filters are ORed.
 */
import type { Filter, NostrEvent } from "./types.ts";

/** Whether `event` satisfies a single filter. An empty filter matches all. */
export function matchFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  // Tag filters: keys like "#e", "#p". Multiple tag keys are ANDed; the values
  // within a key are ORed.
  for (const key in filter) {
    if (key.length !== 2 || key[0] !== "#") continue;
    const values = filter[key as `#${string}`];
    if (!Array.isArray(values)) continue;
    const tagName = key[1]!;
    const matched = event.tags.some(
      (tag) => tag[0] === tagName && tag[1] !== undefined && (values as string[]).includes(tag[1]),
    );
    if (!matched) return false;
  }

  return true;
}

/** Whether `event` matches any of the given filters. */
export function matchFilters(event: NostrEvent, filters: Filter[]): boolean {
  return filters.some((f) => matchFilter(event, f));
}
