import { describe, expect, test } from "bun:test";
import { replaces, sortNewestFirst } from "../../src/store/store.ts";
import type { NostrEvent } from "../../src/types.ts";

function ev(id: string, created_at: number): NostrEvent {
  return { id, pubkey: "", created_at, kind: 1, tags: [], content: "", sig: "" };
}

describe("replaces", () => {
  test("newer created_at wins", () => {
    expect(replaces(ev("a", 2), ev("b", 1))).toBe(true);
    expect(replaces(ev("a", 1), ev("b", 2))).toBe(false);
  });
  test("on a tie, the lower id wins", () => {
    expect(replaces(ev("a", 1), ev("b", 1))).toBe(true);
    expect(replaces(ev("b", 1), ev("a", 1))).toBe(false);
  });
});

describe("sortNewestFirst", () => {
  test("orders by created_at desc, then id asc", () => {
    const sorted = sortNewestFirst([ev("b", 1), ev("a", 2), ev("c", 2)]);
    expect(sorted.map((e) => e.id)).toEqual(["a", "c", "b"]);
  });
  test("treats fully-equal entries as equal (stable, returns 0)", () => {
    const a = ev("same", 5);
    const b = ev("same", 5);
    const sorted = sortNewestFirst([a, b]);
    expect(sorted).toHaveLength(2);
  });
});
