import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HEX_32_RE } from "./crypto";
import { isExpired } from "./kinds";
import type { CountResult, NostrEvent, NostrFilter } from "./types";

const textEncoder = new TextEncoder();

const STRUCTURAL_FILTER_KEYS = new Set(["ids", "authors", "kinds", "since", "until", "limit", "search"]);

export function isFilterShape(value: unknown): value is NostrFilter {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeFilters(filters: unknown[], maxLimit: number, defaultLimit: number): NostrFilter[] {
  const normalized = filters.filter(isFilterShape).map((filter) => normalizeFilter(filter, maxLimit, defaultLimit));
  return normalized.length === 0 ? [normalizeFilter({}, maxLimit, defaultLimit)] : normalized;
}

export function normalizeFilter(filter: NostrFilter, maxLimit: number, defaultLimit: number): NostrFilter {
  const next: NostrFilter = {};
  if (Array.isArray(filter.ids)) next.ids = filter.ids.filter((id): id is string => typeof id === "string");
  if (Array.isArray(filter.authors)) next.authors = filter.authors.filter((author): author is string => typeof author === "string");
  if (Array.isArray(filter.kinds)) next.kinds = filter.kinds.filter((kind): kind is number => Number.isSafeInteger(kind));
  if (typeof filter.since === "number" && Number.isSafeInteger(filter.since)) next.since = filter.since;
  if (typeof filter.until === "number" && Number.isSafeInteger(filter.until)) next.until = filter.until;
  if (typeof filter.search === "string" && filter.search.trim()) next.search = filter.search.trim();
  const requestedLimit = Number.isSafeInteger(filter.limit) ? Number(filter.limit) : defaultLimit;
  next.limit = Math.max(0, Math.min(maxLimit, requestedLimit));
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    if (!Array.isArray(value)) continue;
    next[key] = value.filter((item): item is string => typeof item === "string");
  }
  return next;
}

export function validateFilter(filter: NostrFilter): string | undefined {
  if (filter.ids?.some((id) => !HEX_32_RE.test(id))) return "ids must contain lowercase 32-byte hex values";
  if (filter.authors?.some((author) => !HEX_32_RE.test(author))) return "authors must contain lowercase 32-byte hex values";
  for (const [key, value] of Object.entries(filter)) {
    if (STRUCTURAL_FILTER_KEYS.has(key) || !key.startsWith("#")) continue;
    if (!Array.isArray(value)) return `${key} must be an array`;
    if (key === "#e" || key === "#p") {
      if (value.some((item) => typeof item !== "string" || !HEX_32_RE.test(item))) {
        return `${key} must contain lowercase 32-byte hex values`;
      }
    }
  }
  return undefined;
}

export function matchesAnyFilter(event: NostrEvent, filters: NostrFilter[], nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return filters.some((filter) => matchesFilter(event, filter, nowSeconds));
}

export function matchesFilter(event: NostrEvent, filter: NostrFilter, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (isExpired(event, nowSeconds)) return false;
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (typeof filter.since === "number" && event.created_at < filter.since) return false;
  if (typeof filter.until === "number" && event.created_at > filter.until) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(value)) continue;
    const tagName = key.slice(1);
    const wanted = value.filter((item): item is string => typeof item === "string");
    if (wanted.length === 0) return false;
    const values = event.tags
      .filter((tag) => tag[0] === tagName && typeof tag[1] === "string")
      .map((tag) => tag[1] as string);
    if (!values.some((tagValue) => wanted.includes(tagValue))) return false;
  }
  if (filter.search && searchScore(event, filter.search) <= 0) return false;
  return true;
}

export function sortEventsForRelay(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id.localeCompare(b.id);
  });
}

export function sortEventsForFilter(events: NostrEvent[], filter: NostrFilter): NostrEvent[] {
  if (!filter.search) return sortEventsForRelay(events);
  return [...events].sort((a, b) => {
    const scoreDelta = searchScore(b, filter.search as string) - searchScore(a, filter.search as string);
    if (scoreDelta !== 0) return scoreDelta;
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id.localeCompare(b.id);
  });
}

export function applyFilters(events: Iterable<NostrEvent>, filters: NostrFilter[]): { events: NostrEvent[]; complete: boolean } {
  const byId = new Map<string, NostrEvent>();
  let complete = true;
  for (const filter of filters) {
    const matches = sortEventsForFilter(
      [...events].filter((event) => matchesFilter(event, filter)),
      filter,
    );
    const limit = typeof filter.limit === "number" ? filter.limit : matches.length;
    if (matches.length > limit) complete = false;
    for (const event of matches.slice(0, limit)) byId.set(event.id, event);
  }
  return { events: sortEventsForRelay([...byId.values()]), complete };
}

export function searchScore(event: NostrEvent, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term && !term.includes(":"));
  if (terms.length === 0) return 1;
  const content = event.content.toLowerCase();
  const tagText = event.tags.flat().join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (content.includes(term)) score += 4;
    if (tagText.includes(term)) score += 1;
  }
  return score;
}

export function countEvents(events: Iterable<NostrEvent>, filters: NostrFilter[]): CountResult {
  const ids = new Set<string>();
  const matched: NostrEvent[] = [];
  for (const event of events) {
    if (!matchesAnyFilter(event, filters)) continue;
    if (ids.has(event.id)) continue;
    ids.add(event.id);
    matched.push(event);
  }
  const result: CountResult = { count: matched.length };
  if (filters.length === 1 && isHllEligible(filters[0] as NostrFilter)) result.hll = computeHll(matched, filters[0] as NostrFilter);
  return result;
}

function isHllEligible(filter: NostrFilter): boolean {
  const tagKeys = Object.keys(filter).filter((key) => key.startsWith("#") && Array.isArray(filter[key]) && (filter[key] as unknown[]).length === 1);
  return tagKeys.length === 1;
}

function computeHll(events: NostrEvent[], filter: NostrFilter): string {
  const offset = hllOffset(filter);
  const registers = new Uint8Array(256);
  for (const event of events) {
    const pubkeyBytes = hexToByteArray(event.pubkey);
    const index = pubkeyBytes[offset] ?? 0;
    const rank = leadingZeroRank(pubkeyBytes, offset + 1);
    registers[index] = Math.max(registers[index] ?? 0, rank);
  }
  return bytesToHex(registers);
}

function hllOffset(filter: NostrFilter): number {
  const tagKey = Object.keys(filter).find((key) => key.startsWith("#") && Array.isArray(filter[key]));
  const values = tagKey ? (filter[tagKey] as unknown[]) : [];
  const value = typeof values[0] === "string" ? values[0] : "";
  let hex: string;
  if (HEX_32_RE.test(value)) {
    hex = value;
  } else {
    const addressPubkey = value.split(":")[1];
    hex = addressPubkey && HEX_32_RE.test(addressPubkey) ? addressPubkey : bytesToHex(sha256(textEncoder.encode(value)));
  }
  return Number.parseInt(hex[32] ?? "0", 16) + 8;
}

function leadingZeroRank(bytes: Uint8Array, startByte: number): number {
  let zeros = 0;
  for (let i = startByte; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) {
      zeros += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit -= 1) {
      if (((byte >> bit) & 1) === 0) zeros += 1;
      else return zeros + 1;
    }
  }
  return zeros + 1;
}

function hexToByteArray(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
