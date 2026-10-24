/**
 * Parsing of untrusted Nostr data (event content, URL search params) into the shapes the UI renders.
 * The relay only guarantees `content` is a string and tags are non-empty string arrays: whatever JSON is inside is
 * attacker-controlled, so nothing parsed here may reach rendering unless it has the type the UI expects.
 * No DOM or React imports: unit-tested in test/sanitize.test.ts.
 */
import type { Filter, Profile } from "@beamhop/sdk/admin-contract";

const PROFILE_FIELDS = ["name", "display_name", "picture", "about", "nip05", "banner", "website"] as const;
const MAX_FIELD = 2000;

/** Kind-0 content → profile with non-empty string fields only (the rule admin-api's parseProfile applies). */
export function parseProfileContent(content: string): Profile {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const p: Profile = {};
  for (const f of PROFILE_FIELDS) {
    const v = r[f];
    if (typeof v === "string" && v) p[f] = v.slice(0, MAX_FIELD);
  }
  if (!p.display_name && typeof r.displayName === "string" && r.displayName) p.display_name = r.displayName.slice(0, MAX_FIELD);
  return p;
}

/** The embedded event's `content` of a kind-6/16 repost, only when it is a string. */
export function repostContent(content: string): string | undefined {
  if (!content) return undefined;
  try {
    const v: unknown = JSON.parse(content);
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const c = (v as { content?: unknown }).content;
    return typeof c === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined);
const ints = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every((x) => Number.isInteger(x)) ? v : undefined);
const int = (v: unknown): number | undefined => (Number.isInteger(v) ? (v as number) : undefined);

/** One NIP-01 filter with every field of the wrong type dropped (filters arrive from `?f=` links). */
export function sanitizeFilter(raw: unknown): Filter | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const f: Filter = {};
  const ids = strings(r.ids);
  const authors = strings(r.authors);
  const kinds = ints(r.kinds);
  if (ids) f.ids = ids;
  if (authors) f.authors = authors;
  if (kinds) f.kinds = kinds;
  for (const k of ["since", "until", "limit"] as const) {
    const n = int(r[k]);
    if (n !== undefined) f[k] = n;
  }
  if (typeof r.search === "string") f.search = r.search;
  for (const [k, v] of Object.entries(r)) {
    const vals = strings(v);
    if (/^#[a-zA-Z]$/.test(k) && vals) f[k as `#${string}`] = vals;
  }
  return f;
}

/** `?f=` value (a filter object or an array of them) → filters; anything unusable becomes the empty filter. */
export function parseFiltersParam(raw?: string): Filter[] {
  if (!raw) return [{}];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [{}];
  }
  const out = (Array.isArray(v) ? v : [v]).map(sanitizeFilter).filter((f): f is Filter => !!f);
  return out.length ? out : [{}];
}
