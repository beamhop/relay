import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { createTestStores, type StorageStores } from "../src";
import { parseSearch } from "../src/events";
import { inList } from "../src/sql";

// Inputs that postgres rejects (or sqlite and postgres treat differently) behave the same on sqlite.

let stores: StorageStores;
beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

const hex = (n: number) => n.toString(16).padStart(64, "0");
const now = () => Math.floor(Date.now() / 1000);
const ev = (i: number, tags: string[][] = [], content = "x"): NostrEvent => ({
  id: hex(i),
  pubkey: "a".repeat(64),
  created_at: now() - i,
  kind: 1,
  tags,
  content,
  sig: "0".repeat(128),
});

describe("postgres parity", () => {
  test("large IN lists use a text-cast JSON parameter on postgres", () => {
    const values = Array.from({ length: 201 }, (_, i) => hex(i));
    expect(inList("postgres", "e.id", values).sql).toContain("json_array_elements_text(?::text::json)");
    expect(inList("postgres", "e.kind", [...Array(201).keys()], "int").sql).toContain("(json_array_elements_text(?::text::json))::bigint");
    expect(inList("sqlite", "e.id", values).sql).toContain("json_each(?)");
  });

  test("queries with more than 200 ids still match", async () => {
    for (let i = 1; i <= 5; i++) await stores.events.save(ev(i));
    const ids = Array.from({ length: 300 }, (_, i) => hex(i + 1));
    expect((await stores.events.query([{ ids }])).length).toBe(5);
  });

  test("tag values are indexed by UTF-8 bytes, not UTF-16 chars", async () => {
    const cjk = "漢".repeat(400); // 400 chars, 1200 bytes: over the 1024-byte cap
    const ascii = "a".repeat(1000);
    await stores.events.save(ev(1, [["t", cjk], ["t", ascii]]));
    expect((await stores.events.query([{ "#t": [cjk] }])).length).toBe(0);
    expect((await stores.events.query([{ "#t": [ascii] }])).length).toBe(1);
  });

  test("NUL filter values never match and don't break the query", async () => {
    await stores.events.save(ev(1, [["t", "a"]]));
    expect((await stores.events.query([{ "#t": ["a\u0000"] }])).length).toBe(0);
    expect((await stores.events.query([{ "#t": ["a", "b\u0000"] }])).length).toBe(1);
    expect(parseSearch("hel\u0000lo world").terms).toEqual(["hello", "world"]);
  });

  test("since/until/limit beyond 2^53 are clamped", async () => {
    await stores.events.save(ev(1));
    expect((await stores.events.query([{ since: 0, until: 1e21, limit: 1e20 }])).length).toBe(1);
    expect((await stores.events.query([{ since: 1e20 }])).length).toBe(0);
    expect((await stores.events.queryIdsForSync({ limit: 1e21 })).length).toBe(1);
    expect(await stores.events.count([{ until: 1e21 }])).toBe(1);
  });
});
