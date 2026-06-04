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

/**
 * A filter preprocessed for fast repeated matching: array membership tests
 * become `Set` lookups, and the `#`-tag entries are extracted once instead of
 * re-scanning every filter key per event. Semantically identical to
 * {@link matchFilter}.
 */
export interface CompiledFilter {
  ids?: Set<string>;
  authors?: Set<string>;
  kinds?: Set<number>;
  since?: number;
  until?: number;
  /** Tag filters: tag name (single letter) -> the set of accepted values. */
  tags: { name: string; values: Set<string> }[];
}

/** Precompile a {@link Filter} into a {@link CompiledFilter}. */
export function compileFilter(filter: Filter): CompiledFilter {
  const tags: { name: string; values: Set<string> }[] = [];
  for (const key in filter) {
    if (key.length !== 2 || key[0] !== "#") continue;
    const values = filter[key as `#${string}`];
    if (!Array.isArray(values)) continue;
    tags.push({ name: key[1]!, values: new Set(values as string[]) });
  }
  return {
    ids: filter.ids ? new Set(filter.ids) : undefined,
    authors: filter.authors ? new Set(filter.authors) : undefined,
    kinds: filter.kinds ? new Set(filter.kinds) : undefined,
    since: filter.since,
    until: filter.until,
    tags,
  };
}

/** Whether `event` satisfies a precompiled filter. Mirrors {@link matchFilter}. */
export function matchCompiled(event: NostrEvent, filter: CompiledFilter): boolean {
  if (filter.ids && !filter.ids.has(event.id)) return false;
  if (filter.authors && !filter.authors.has(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.has(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const { name, values } of filter.tags) {
    const matched = event.tags.some(
      (tag) => tag[0] === name && tag[1] !== undefined && values.has(tag[1]),
    );
    if (!matched) return false;
  }

  return true;
}
