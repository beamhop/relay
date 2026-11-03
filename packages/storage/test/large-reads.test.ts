import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Filter, NostrEvent } from "@beamhop/sdk";
import { createTestStores, silentLogger, SqlEventStore, type StorageStores } from "../src";

// Reads that used to cost time proportional to every match (one synchronous stall of the relay on sqlite): COUNT
// with the expiration check, and search ranking.

const T = 1_700_000_000;
const hex = (n: number, salt = 0) => (n * 7919 + salt).toString(16).padStart(64, "0");
const ev = (i: number, e: Partial<NostrEvent>): NostrEvent => ({ id: hex(i), pubkey: hex(1, 1), created_at: T + i, kind: 1, tags: [], content: "", sig: "0".repeat(128), ...e });

let stores: StorageStores;
const now = Math.floor(Date.now() / 1000);
beforeAll(async () => {
  stores = await createTestStores();
  for (let i = 0; i < 400; i++) {
    const tags = [["t", i % 3 ? "odd" : "even"]];
    // some expired, some expiring later, most never
    if (i % 10 === 0) tags.push(["expiration", String(now - 100)]);
    if (i % 10 === 5) tags.push(["expiration", String(now + 10_000)]);
    await stores.events.save(ev(i, { kind: i % 4 === 0 ? 7 : 1, pubkey: hex(i % 5, 1), tags, content: `note ${i} ${i % 7 ? "coffee" : "tea"}` }));
  }
});
afterAll(async () => {
  await stores.close();
});

describe("COUNT", () => {
  test("expired events are not counted, for every filter shape", async () => {
    const all = await stores.events.query([{ limit: 10_000 }]);
    expect(all.length).toBe(360); // 40 expired
    const cases: Filter[][] = [
      [{}],
      [{ kinds: [1] }],
      [{ kinds: [7] }],
      [{ authors: [hex(0, 1), hex(3, 1)] }],
      [{ "#t": ["odd"] }],
      [{ "#t": ["even"], kinds: [7] }],
      [{ since: T + 100, until: T + 300 }],
      [{ search: "coffee" }],
      [{ kinds: [7] }, { "#t": ["even"] }],
      [{ ids: [hex(0), hex(1), hex(10), hex(15)] }],
    ];
    for (const filters of cases) {
      const expected = all.filter((e) => filters.some((f) => matches(f, e))).length;
      expect({ filters, n: await stores.events.count(filters) }).toEqual({ filters, n: expected });
    }
  });
});

describe("sqlite search ranking window", () => {
  test("ranks only the newest matches of the whole filter; narrower filters still find older events", async () => {
    const store = new SqlEventStore(stores.db, silentLogger, { fts: true, searchRankWindow: 20 });
    const res = await store.query([{ search: "coffee", limit: 100 }]);
    // the 20 newest unexpired coffee notes: the window counts the filter's matches
    expect(res.length).toBe(20);
    const newest = (await stores.events.query([{ limit: 10_000 }])).filter((e) => e.content.includes("coffee")).slice(0, 20);
    expect(res.map((e) => e.id).sort()).toEqual(newest.map((e) => e.id).sort());
    // the window applies to the filter's matches: an author's old notes are still found
    const old = await store.query([{ search: "coffee", authors: [hex(2, 1)], until: T + 100, limit: 100 }]);
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((e) => e.pubkey === hex(2, 1) && e.created_at <= T + 100)).toBe(true);
    // fewer matches than the window: everything, as before
    const few: Filter = { search: "tea", authors: [hex(0, 1)], limit: 100 };
    const exact = (await stores.events.query([few])).map((e) => e.id);
    expect(exact.length).toBeLessThan(20);
    expect((await store.query([few])).map((e) => e.id)).toEqual(exact);
  });
});

function matches(f: Filter, e: NostrEvent): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  if (f.search && !e.content.includes(f.search)) return false;
  for (const [k, v] of Object.entries(f)) {
    if (k[0] === "#" && !e.tags.some((t) => t[0] === k[1] && (v as string[]).includes(t[1]))) return false;
  }
  return true;
}
