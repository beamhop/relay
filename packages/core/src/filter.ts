// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NostrEvent } from './event.ts';

/** NIP-01 filter. Tag filters use `#<letter>` keys. NIP-50 adds `search`. */
export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  search?: string;
  [tag: `#${string}`]: string[] | undefined;
}

export function tagFilterEntries(f: Filter): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const key of Object.keys(f)) {
    if (key.length === 2 && key[0] === '#') {
      const v = f[key as `#${string}`];
      if (Array.isArray(v)) out.push([key.slice(1), v]);
    }
  }
  return out;
}

/** Does `event` match `filter`? `search` is not evaluated here (store-specific). */
export function matchFilter(filter: Filter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [name, values] of tagFilterEntries(filter)) {
    let hit = false;
    for (const t of event.tags) {
      if (t[0] === name && t[1] !== undefined && values.includes(t[1])) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
}

export function matchFilters(filters: Filter[], event: NostrEvent): boolean {
  for (const f of filters) if (matchFilter(f, event)) return true;
  return false;
}

export type FilterCheck = { ok: true; filter: Filter } | { ok: false; reason: string };

/** Structural validation of an untrusted filter object. */
export function validateFilter(input: unknown): FilterCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'invalid: filter must be an object' };
  }
  const f = input as Record<string, unknown>;
  const strArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const intOk = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  for (const [k, v] of Object.entries(f)) {
    if (k === 'ids' || k === 'authors') {
      if (!strArr(v)) return { ok: false, reason: `invalid: ${k}` };
    } else if (k === 'kinds') {
      if (!Array.isArray(v) || !v.every(intOk)) return { ok: false, reason: 'invalid: kinds' };
    } else if (k === 'since' || k === 'until' || k === 'limit') {
      if (!intOk(v)) return { ok: false, reason: `invalid: ${k}` };
    } else if (k === 'search') {
      if (typeof v !== 'string') return { ok: false, reason: 'invalid: search' };
    } else if (k.length === 2 && k[0] === '#') {
      if (!strArr(v)) return { ok: false, reason: `invalid: ${k}` };
    }
    // Unknown keys are ignored per NIP-01 leniency.
  }
  return { ok: true, filter: f as Filter };
}
