import type { Filter, NostrEvent } from "@beamhop/sdk";

// Tokenization mirrors @beamhop/storage parseSearch so live delivery and stored queries agree.
const EXTENSION_TOKEN = /^[a-zA-Z_-]+:[^/\s]/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
/** Tag values longer than this aren't indexed by the store, so live matching ignores them too. */
export const MAX_MATCHED_TAG_VALUE = 1024;

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

/** Small NIP-50 matcher used for live delivery: every term / phrase must occur (case-insensitive). */
export function matchSearch(search: string, event: NostrEvent): boolean {
  const terms = searchTerms(search);
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

/** A filter prepared for repeated live matching: array lookups become Set lookups. */
export interface CompiledFilter {
  filter: Filter;
  ids?: ReadonlySet<string>;
  kinds?: ReadonlySet<number>;
  authors?: ReadonlySet<string>;
  tags: [name: string, values: ReadonlySet<string>][];
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
  };
}

/** Same semantics as matchFilter, O(tags) per event instead of O(tags × filter values). */
export function matchCompiled(c: CompiledFilter, event: NostrEvent): boolean {
  const f = c.filter;
  if (c.ids && !c.ids.has(event.id)) return false;
  if (c.kinds && !c.kinds.has(event.kind)) return false;
  if (c.authors && !c.authors.has(event.pubkey)) return false;
  if (f.since !== undefined && event.created_at < f.since) return false;
  if (f.until !== undefined && event.created_at > f.until) return false;
  for (const [name, values] of c.tags) {
    let ok = false;
    for (const t of event.tags) {
      if (t[0] === name && t[1] !== undefined && values.has(t[1])) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (f.search !== undefined && !matchSearch(f.search, event)) return false;
  return true;
}

/** Index/memory weight of a filter set (number of values plus one per filter). */
export function filterWeight(filters: Filter[]): number {
  let n = 0;
  for (const f of filters) {
    n++;
    for (const v of Object.values(f)) if (Array.isArray(v)) n += v.length;
  }
  return n;
}

export function matchFilters(filters: Filter[], event: NostrEvent): boolean {
  for (const f of filters) if (matchFilter(f, event)) return true;
  return false;
}
