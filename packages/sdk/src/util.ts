/** Small runtime-neutral helpers several packages need identically: hex, hashing, an LRU, deep merge, chunking. */
import { createHash } from "node:crypto";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export const isHex64 = (s: unknown): s is string => typeof s === "string" && HEX64.test(s);
export const isHex128 = (s: unknown): s is string => typeof s === "string" && HEX128.test(s);

const HEX_CHARS = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX_CHARS[bytes[i] >> 4] + HEX_CHARS[bytes[i] & 15];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Lowercase hex SHA-256 of bytes or of a string's UTF-8. */
export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/**
 * Minimal LRU map built on Map insertion order, with an optional TTL (ms; 0 = entries never expire). A stored
 * `undefined` is a value like any other (`has` tells it from a miss).
 */
export class Lru<K, V> {
  private map = new Map<K, { v: V; exp: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs = 0,
    private readonly now: () => number = Date.now,
  ) {}
  /** The entry, unless missing or expired (an expired one is dropped). */
  private live(key: K): { v: V; exp: number } | undefined {
    const e = this.map.get(key);
    if (e && e.exp && e.exp < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }
  get(key: K): V | undefined {
    const e = this.live(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  /** Whether a live entry exists; doesn't refresh its recency. */
  has(key: K): boolean {
    return this.live(key) !== undefined;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as K);
    this.map.set(key, { v: value, exp: this.ttlMs ? this.now() + this.ttlMs : 0 });
  }
  delete(key: K): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

/** A plain object literal (not an array, null, class instance or Object.create(null) map). */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Deep merge: plain objects are merged recursively; arrays and scalars replace; `undefined` is ignored. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Splits a list into chunks of at most `size` (e.g. for `IN (?, ?, …)` queries with portable parameter counts). */
export function chunk<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
