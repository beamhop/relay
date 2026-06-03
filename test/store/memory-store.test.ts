import { describe, expect, test } from "bun:test";
import { MemoryEventStore } from "../../src/store/memory-store.ts";
import { dTag, storageClass } from "../../src/store/store.ts";
import { runStoreSuite } from "./store-suite.ts";
import { events } from "../fixtures.ts";

runStoreSuite("MemoryEventStore", () => new MemoryEventStore());

describe("storageClass boundaries", () => {
  test.each([
    [0, "replaceable"],
    [3, "replaceable"],
    [1, "regular"],
    [9999, "regular"],
    [10000, "replaceable"],
    [19999, "replaceable"],
    [20000, "ephemeral"],
    [29999, "ephemeral"],
    [30000, "addressable"],
    [39999, "addressable"],
    [40000, "regular"],
  ] as const)("kind %i -> %s", (kind, cls) => {
    expect(storageClass(kind)).toBe(cls);
  });
});

describe("MemoryEventStore query edges", () => {
  test("returns empty when nothing matches", () => {
    const store = new MemoryEventStore();
    store.add(events.note);
    expect(store.query([{ kinds: [9999] }])).toHaveLength(0);
  });
  test("getById returns undefined for an unknown id", () => {
    expect(new MemoryEventStore().getById("nope")).toBeUndefined();
  });
});

describe("dTag", () => {
  test("returns the first d tag value", () => {
    expect(dTag(events.addressable)).toBe("slot");
  });
  test("returns empty string when absent", () => {
    expect(dTag(events.note)).toBe("");
  });
  test("returns empty string for a d tag with no value", () => {
    expect(dTag({ ...events.note, tags: [["d"]] })).toBe("");
  });
});
