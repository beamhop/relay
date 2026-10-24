import { describe, expect, test } from "bun:test";
import { MAX_D_TAG_BYTES, validateEventShape, validateFilter } from "../src/protocol/messages";

// Inputs postgres can't store or bind are refused (or neutralised) before they reach storage.

const base = { id: "a".repeat(64), pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: 1_700_000_000, kind: 1, tags: [] as string[][], content: "" };
const reason = (r: ReturnType<typeof validateEventShape>) => ("reason" in r ? r.reason : undefined);

describe("event shape: postgres-unsafe values", () => {
  test("NUL in content or tag values is rejected", () => {
    expect(reason(validateEventShape({ ...base, content: "a\u0000b" }))).toMatch(/^invalid: content must not contain NUL/);
    expect(reason(validateEventShape({ ...base, tags: [["t", "a\u0000"]] }))).toMatch(/^invalid: tag values must not contain NUL/);
    expect(reason(validateEventShape({ ...base, content: "fine", tags: [["t", "ok"]] }))).toBeUndefined();
  });

  test("addressable d tags are capped by UTF-8 bytes", () => {
    const long = { ...base, kind: 30023, tags: [["d", "漢".repeat(400)]] }; // 1200 bytes
    expect(reason(validateEventShape(long))).toBe(`invalid: "d" tag longer than ${MAX_D_TAG_BYTES} bytes`);
    expect(reason(validateEventShape({ ...base, kind: 30023, tags: [["d", "a".repeat(MAX_D_TAG_BYTES)]] }))).toBeUndefined();
    // the cap only applies to addressable kinds (other kinds don't index d)
    expect(reason(validateEventShape({ ...base, kind: 1, tags: [["d", "a".repeat(3000)]] }))).toBeUndefined();
  });
});

describe("filters: postgres-unsafe values", () => {
  const filter = (f: unknown) => {
    const r = validateFilter(f);
    if ("reason" in r) throw new Error(r.reason);
    return r.filter;
  };

  test("since/until/limit are clamped to 2^53 - 1", () => {
    expect(filter({ since: 1e20, until: 1e21, limit: 1e21 })).toEqual({
      since: Number.MAX_SAFE_INTEGER,
      until: Number.MAX_SAFE_INTEGER,
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(filter({ since: 5 })).toEqual({ since: 5 });
  });

  test("NUL tag values are dropped and NUL is stripped from search", () => {
    expect(filter({ "#t": ["a", "b\u0000"] })).toEqual({ "#t": ["a"] });
    expect(filter({ "#t": ["\u0000"] })).toEqual({ "#t": [] });
    expect(filter({ search: "hel\u0000lo" })).toEqual({ search: "hello" });
  });
});
