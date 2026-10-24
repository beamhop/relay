import { Buffer } from "node:buffer";
import type { Filter, NostrEvent } from "@beamhop/sdk";

// Tokenization mirrors @beamhop/storage parseSearch so live delivery and stored queries agree.
const EXTENSION_TOKEN = /^[a-zA-Z_-]+:[^/\s]/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
/** Tag values longer than this (UTF-16 units or UTF-8 bytes) aren't indexed by the store, so live matching ignores them too. */
const MAX_MATCHED_TAG_VALUE = 1024;
/**
 * Filter weight of a search filter (see filterWeight). Live search matching scans each new event's content once per
 * search filter, so it costs far more than a plain filter value; this keeps a connection to a few dozen of them.
 */
export const SEARCH_FILTER_WEIGHT = 500;

/** Whether the store indexes a tag value (it skips ones over MAX_MATCHED_TAG_VALUE chars or UTF-8 bytes). */
function matchableValue(v: string): boolean {
  if (v.length > MAX_MATCHED_TAG_VALUE) return false;
  // a UTF-16 unit is at most 3 UTF-8 bytes
  return v.length * 3 <= MAX_MATCHED_TAG_VALUE || Buffer.byteLength(v, "utf8") <= MAX_MATCHED_TAG_VALUE;
}

/** NIP-50 search terms: quoted phrases kept whole, `key:value` extensions (language:en, …) dropped. */
function searchTerms(search: string): string[] {
  const terms: string[] = [];
  for (const tok of search.match(/"[^"]*"|\S+/g) ?? []) {
    const quoted = tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"');
    if (!quoted && EXTENSION_TOKEN.test(tok)) continue;
    const text = (quoted ? tok.slice(1, -1) : tok).replace(/"/g, " ").trim().toLowerCase();
    if (text && HAS_WORD_CHAR.test(text)) terms.push(text);
  }
  return terms;
}

/** Every term / phrase occurs in the (already lowercased) content; no terms match everything. */
const matchTerms = (terms: readonly string[], lowered: string) => terms.every((t) => lowered.includes(t));

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
      if (t[0] === name && t[1] !== undefined && values.includes(t[1]) && matchableValue(t[1])) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (filter.search !== undefined) {
    const terms = searchTerms(filter.search);
    if (terms.length && !matchTerms(terms, event.content.toLowerCase())) return false;
  }
  return true;
}

/** A filter prepared for repeated live matching: array lookups become Set lookups, search terms are parsed once. */
export interface CompiledFilter {
  filter: Filter;
  ids?: ReadonlySet<string>;
  kinds?: ReadonlySet<number>;
  authors?: ReadonlySet<string>;
  tags: [name: string, values: ReadonlySet<string>][];
  /** NIP-50 terms; empty when the filter has no (effective) search */
  search: readonly string[];
}

export function compileFilter(filter: Filter): CompiledFilter {
  const tags: CompiledFilter["tags"] = [];
  for (const key in filter) {
    if (key.charCodeAt(0) !== 35 /* # */) continue;
    const values = filter[key as `#${string}`];
    if (values) tags.push([key.slice(1), new Set(values)]);
  }
  return {
    filter,
    ids: filter.ids && new Set(filter.ids),
    kinds: filter.kinds && new Set(filter.kinds),
    authors: filter.authors && new Set(filter.authors),
    tags,
    search: filter.search !== undefined ? searchTerms(filter.search) : [],
  };
}

/**
 * Same semantics as matchFilter, O(tags) per event instead of O(tags × filter values). `lowered` returns the event's
 * lowercased content, so one broadcast lowercases it once for all search filters.
 */
export function matchCompiled(c: CompiledFilter, event: NostrEvent, lowered: () => string = () => event.content.toLowerCase()): boolean {
  const f = c.filter;
  if (c.ids && !c.ids.has(event.id)) return false;
  if (c.kinds && !c.kinds.has(event.kind)) return false;
  if (c.authors && !c.authors.has(event.pubkey)) return false;
  if (f.since !== undefined && event.created_at < f.since) return false;
  if (f.until !== undefined && event.created_at > f.until) return false;
  for (const [name, values] of c.tags) {
    let ok = false;
    for (const t of event.tags) {
      if (t[0] === name && t[1] !== undefined && values.has(t[1]) && matchableValue(t[1])) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (c.search.length && !matchTerms(c.search, lowered())) return false;
  return true;
}

/** Index/memory weight of a filter set: one per filter, one per array value, SEARCH_FILTER_WEIGHT per search filter. */
export function filterWeight(filters: Filter[]): number {
  let n = 0;
  for (const f of filters) {
    n++;
    for (const v of Object.values(f)) if (Array.isArray(v)) n += v.length;
    if (typeof f.search === "string" && f.search.trim() !== "") n += SEARCH_FILTER_WEIGHT;
  }
  return n;
}
