import { describe, expect, test } from "bun:test";
import {
  compileFilter,
  matchCompiled,
  matchFilter,
  matchFilters,
} from "../src/filter.ts";
import type { Filter, NostrEvent } from "../src/types.ts";

const event: NostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1000,
  kind: 1,
  tags: [
    ["e", "ref1"],
    ["e", "ref2"],
    ["p", "peer1"],
    ["t", "topic"],
  ],
  content: "x",
  sig: "c".repeat(128),
};

describe("matchFilter", () => {
  test("empty filter matches everything", () => {
    expect(matchFilter(event, {})).toBe(true);
  });
  test("ids: exact membership", () => {
    expect(matchFilter(event, { ids: ["a".repeat(64)] })).toBe(true);
    expect(matchFilter(event, { ids: ["other"] })).toBe(false);
  });
  test("authors membership", () => {
    expect(matchFilter(event, { authors: ["b".repeat(64)] })).toBe(true);
    expect(matchFilter(event, { authors: ["nope"] })).toBe(false);
  });
  test("kinds membership", () => {
    expect(matchFilter(event, { kinds: [0, 1, 2] })).toBe(true);
    expect(matchFilter(event, { kinds: [0, 2] })).toBe(false);
  });
  test("since is inclusive", () => {
    expect(matchFilter(event, { since: 1000 })).toBe(true);
    expect(matchFilter(event, { since: 1001 })).toBe(false);
  });
  test("until is inclusive", () => {
    expect(matchFilter(event, { until: 1000 })).toBe(true);
    expect(matchFilter(event, { until: 999 })).toBe(false);
  });
  test("#e tag: OR within values", () => {
    expect(matchFilter(event, { "#e": ["ref2", "zzz"] })).toBe(true);
    expect(matchFilter(event, { "#e": ["nope"] })).toBe(false);
  });
  test("multiple tag keys are ANDed", () => {
    expect(matchFilter(event, { "#e": ["ref1"], "#p": ["peer1"] })).toBe(true);
    expect(matchFilter(event, { "#e": ["ref1"], "#p": ["other"] })).toBe(false);
  });
  test("ignores non-array tag-filter values", () => {
    expect(matchFilter(event, { "#e": "ref1" as unknown as string[] })).toBe(true);
  });
  test("ignores keys that are not single-letter tag filters", () => {
    expect(matchFilter(event, { "#ee": ["x"] as unknown as string[] })).toBe(true);
  });
});

describe("matchCompiled parity with matchFilter", () => {
  const filters: Filter[] = [
    {},
    { ids: ["a".repeat(64)] },
    { ids: ["other"] },
    { ids: [] },
    { authors: ["b".repeat(64)] },
    { authors: [] },
    { kinds: [0, 1, 2] },
    { kinds: [0, 2] },
    { kinds: [] },
    { since: 1000 },
    { since: 1001 },
    { until: 1000 },
    { until: 999 },
    { "#e": ["ref2", "zzz"] },
    { "#e": ["nope"] },
    { "#e": ["ref1"], "#p": ["peer1"] },
    { "#e": ["ref1"], "#p": ["other"] },
    { "#e": "ref1" as unknown as string[] },
    { "#ee": ["x"] as unknown as string[] },
    { kinds: [1], authors: ["b".repeat(64)], since: 500, until: 2000, "#t": ["topic"] },
  ];
  for (const [i, f] of filters.entries()) {
    test(`compiled matches matchFilter for filter #${i}`, () => {
      expect(matchCompiled(event, compileFilter(f))).toBe(matchFilter(event, f));
    });
  }
});

describe("matchFilters", () => {
  test("ORs across filters", () => {
    expect(matchFilters(event, [{ kinds: [99] }, { kinds: [1] }])).toBe(true);
    expect(matchFilters(event, [{ kinds: [99] }, { kinds: [98] }])).toBe(false);
  });
  test("empty filter list matches nothing", () => {
    expect(matchFilters(event, [])).toBe(false);
  });
});
