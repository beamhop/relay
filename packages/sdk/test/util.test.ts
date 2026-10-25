import { expect, test } from "bun:test";
import { chunk, deepMerge, isHex64, Lru, sha256Hex } from "../src/util";

test("Lru evicts the least recently used and keeps a stored undefined", () => {
  const lru = new Lru<string, number | undefined>(2);
  lru.set("a", undefined);
  lru.set("b", 2);
  expect(lru.has("a")).toBe(true);
  expect(lru.get("a")).toBeUndefined(); // a hit: "a" is now the most recent
  lru.set("c", 3);
  expect(lru.has("b")).toBe(false);
  expect(lru.has("a")).toBe(true);
  expect(lru.size).toBe(2);
});

test("Lru with a TTL drops expired entries", () => {
  let now = 0;
  const lru = new Lru<string, string>(10, 100, () => now);
  lru.set("k", "v");
  now = 100;
  expect(lru.get("k")).toBe("v");
  now = 101;
  expect(lru.has("k")).toBe(false);
  expect(lru.size).toBe(0);
});

test("deepMerge merges plain objects only; arrays and class instances replace, undefined is skipped", () => {
  const date = new Date(0);
  expect(deepMerge<Record<string, unknown>>({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, d: undefined, e: date })).toEqual({ a: { b: 1, c: [2] }, d: 1, e: date });
  expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
});

test("chunk, sha256Hex, isHex64", () => {
  expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  expect(chunk(Array.from({ length: 501 }, (_, i) => i)).map((c) => c.length)).toEqual([500, 1]);
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex(new Uint8Array())).toBe(sha256Hex(""));
  expect(isHex64(sha256Hex("x"))).toBe(true);
});
