// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small pure helpers shared by the policy package (hashing, PoW, token buckets, DocStore paging). */
import type { DocStore, RelayId } from '@beamhop/core';

export const HEX64 = /^[0-9a-f]{64}$/;

/** DocStore key for a relay-scoped record. */
export function rkey(relayId: RelayId, id: string): string {
  return `${relayId}:${id}`;
}

/** Read every record of a collection under `prefix` (follows cursors). */
export async function listAll<T>(
  docs: DocStore,
  collection: string,
  prefix: string,
): Promise<Array<{ key: string; value: T }>> {
  const out: Array<{ key: string; value: T }> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await docs.list<T>(collection, { prefix, cursor, limit: 500 });
    out.push(...page.items);
    if (!page.cursor || page.items.length === 0) break;
    cursor = page.cursor;
  }
  return out;
}

/** NIP-13: number of leading zero bits of a hex id. */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = Number.parseInt(hex[i] as string, 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

/** Normalize text for duplicate detection: lowercase, strip punctuation noise, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/[^\p{L}\p{N}:/.\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 32-bit FNV-1a with a seed. */
export function fnv1a32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Fast non-cryptographic 64-bit-ish content hash as hex (two FNV lanes). */
export function contentHash(s: string): string {
  return (
    fnv1a32(s).toString(16).padStart(8, '0') + fnv1a32(s, 0x9747b28c).toString(16).padStart(8, '0')
  );
}

export interface SimHash {
  hi: number;
  lo: number;
}

/** 64-bit SimHash over word 3-shingles (words when the text is short). */
export function simhash(normalized: string): SimHash {
  const words = normalized.split(' ').filter(Boolean);
  const features: string[] = [];
  if (words.length < 3) features.push(...words);
  else
    for (let i = 0; i + 2 < words.length; i++)
      features.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  const v = new Array<number>(64).fill(0);
  for (const f of features) {
    const a = fnv1a32(f);
    const b = fnv1a32(f, 0x9747b28c);
    for (let bit = 0; bit < 32; bit++) {
      v[bit] = (v[bit] as number) + ((a >>> bit) & 1 ? 1 : -1);
      v[bit + 32] = (v[bit + 32] as number) + ((b >>> bit) & 1 ? 1 : -1);
    }
  }
  let lo = 0;
  let hi = 0;
  for (let bit = 0; bit < 32; bit++) {
    if ((v[bit] as number) > 0) lo |= 1 << bit;
    if ((v[bit + 32] as number) > 0) hi |= 1 << bit;
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcount32(x: number): number {
  let n = x >>> 0;
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hamming(a: SimHash, b: SimHash): number {
  return popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo);
}

/**
 * Token bucket keyed by string. Capacity = `perMinute` (one minute of burst),
 * refilled continuously. Times are milliseconds from the injected clock.
 */
export class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number; cap: number }>();
  constructor(private readonly maxKeys = 100_000) {}

  /** Try to take one token. `consume=false` only peeks (dry runs). */
  take(key: string, perMinute: number, nowMs: number, consume = true): boolean {
    const cap = Math.max(1, perMinute);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: cap, at: nowMs, cap };
      if (consume) {
        if (this.buckets.size >= this.maxKeys) this.evict(nowMs);
        this.buckets.set(key, b);
      }
    }
    const refill = ((nowMs - b.at) * cap) / 60_000;
    const tokens = Math.min(cap, b.tokens + Math.max(0, refill));
    if (tokens < 1) {
      if (consume) {
        b.tokens = tokens;
        b.at = nowMs;
        b.cap = cap;
      }
      return false;
    }
    if (consume) {
      b.tokens = tokens - 1;
      b.at = nowMs;
      b.cap = cap;
    }
    return true;
  }

  size(): number {
    return this.buckets.size;
  }

  /** Drop buckets that are full again (idle keys). */
  evict(nowMs: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((nowMs - b.at) * b.cap) / 60_000 >= b.cap) this.buckets.delete(k);
    }
    if (this.buckets.size >= this.maxKeys) {
      // Still full: drop the oldest half.
      const keys = [...this.buckets.keys()];
      for (const k of keys.slice(0, Math.floor(keys.length / 2))) this.buckets.delete(k);
    }
  }
}

/** Short display form of a pubkey for plain-language text. */
export function shortKey(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 8)}…` : pk;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0 && seconds >= 86400) return plural(seconds / 86400, 'day');
  if (seconds % 3600 === 0 && seconds >= 3600) return plural(seconds / 3600, 'hour');
  if (seconds % 60 === 0 && seconds >= 60) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}
