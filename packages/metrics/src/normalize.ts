import { LruCache } from "./lru";

const PREFIX = /^(duplicate|pow|blocked|rate-limited|invalid|restricted|error|auth-required|mute|policy|too-large)\s*:\s*/i;
const RULES: [RegExp, string][] = [
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"],
  [/\b(npub|nsec|note|nevent|nprofile|naddr|nrelay)1[02-9ac-hj-np-z]{6,}\b/gi, "<bech32>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>"],
  [/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, "<ip>"],
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  [/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>"],
  [/[-+]?\d+(?:\.\d+)?/g, "<n>"],
  [/\s+/g, " "],
];
const MAX = 80;
const cache = new LruCache<string, string>(512);

/**
 * Normalizes a rejection reason for aggregation: strips the machine prefix (stored separately as code)
 * and variable parts (ids, pubkeys, IPs, numbers, URLs, quoted text) and truncates to ~80 chars.
 * Also guarantees no raw IPs are persisted.
 */
export function normalizeReason(reason: string | undefined): string {
  if (!reason) return "(none)";
  const hit = cache.get(reason);
  if (hit !== undefined) return hit;
  let r = reason.trim().replace(PREFIX, "");
  for (const [re, rep] of RULES) r = r.replace(re, rep);
  r = r.trim().toLowerCase();
  if (r.length > MAX) r = r.slice(0, MAX - 1).trimEnd() + "…";
  if (!r) r = "(none)";
  cache.set(reason, r);
  return r;
}
