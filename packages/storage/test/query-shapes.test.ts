import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Filter, NostrEvent } from "@beamhop/sdk";
import { createTestStores, silentLogger, SqlEventStore, type StorageStores } from "../src";

// deterministic xorshift, so a failure reproduces
let seed = 0x2545f491;
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const some = <T>(xs: readonly T[], max: number) => [...new Set(Array.from({ length: 1 + Math.floor(rnd() * max) }, () => pick(xs)))];

const T = 1_700_000_000;
const NOW = T + 10_000;
const AUTHORS = Array.from({ length: 30 }, () => hex(64));
const KINDS = [0, 1, 3, 6, 7, 1059, 30023];
const TAG_VALUES = { p: AUTHORS.slice(0, 8), t: ["gm", "nostr", "art", "zap"], e: Array.from({ length: 6 }, () => hex(64)) };

function randomEvent(): NostrEvent {
  const tags: string[][] = [];
  for (let i = Math.floor(rnd() * 4); i > 0; i--) {
    const name = pick(["p", "t", "e"] as const);
    tags.push([name, pick(TAG_VALUES[name])]);
  }
  if (rnd() < 0.05) tags.push(["expiration", String(NOW + (rnd() < 0.5 ? -100 : 100))]);
  const kind = pick(KINDS);
  if (kind === 30023) tags.push(["d", hex(4)]);
  // a narrow time range: many created_at ties, so the id tie-break is exercised
  return { id: hex(64), pubkey: rnd() < 0.4 ? AUTHORS[0] : pick(AUTHORS), created_at: T + Math.floor(rnd() * 400), kind, tags, content: "", sig: hex(128) };
}

function randomFilter(): Filter {
  const f: Filter = {};
  if (rnd() < 0.5) f.kinds = some(KINDS, 4);
  if (rnd() < 0.5) f.authors = some(AUTHORS, rnd() < 0.2 ? 60 : 6);
  if (rnd() < 0.4) {
    const name = pick(["p", "t", "e"] as const);
    f[`#${name}`] = some(TAG_VALUES[name], 3);
  }
  if (rnd() < 0.15) f["#t"] = some(TAG_VALUES.t, 2);
  if (rnd() < 0.2) f.since = T + Math.floor(rnd() * 200);
  if (rnd() < 0.2) f.until = T + 200 + Math.floor(rnd() * 200);
  if (rnd() < 0.8) f.limit = 1 + Math.floor(rnd() * 60);
  return f;
}

let stores: StorageStores;
/** same database, without the sqlite plan shapes: one generic statement per filter */
let generic: SqlEventStore;

beforeAll(async () => {
  stores = await createTestStores();
  for (let i = 0; i < 3000; i++) await stores.events.save(randomEvent());
  generic = new SqlEventStore(stores.db, silentLogger, { fts: false, queryShapes: false });
});
afterAll(async () => {
  await stores.close();
});

describe("sqlite query shapes", () => {
  test("UNION ALL / event_tags-driven queries return exactly what the generic statement returns", async () => {
    let shaped = 0;
    for (let i = 0; i < 400; i++) {
      const f = randomFilter();
      const q = stores.events.querySql(f, NOW, f.limit);
      if (q && (q.sql.includes("UNION ALL") || q.sql.includes("FROM event_tags t CROSS JOIN"))) shaped++;
      const ids = (await stores.events.query([f])).map((e) => e.id);
      expect({ f, ids }).toEqual({ f, ids: (await generic.query([f])).map((e) => e.id) });
    }
    expect(shaped).toBeGreaterThan(150);
  });

  test("multi-filter queries and multi-value tags have no duplicates", async () => {
    for (let i = 0; i < 100; i++) {
      const filters = [randomFilter(), randomFilter(), { "#t": ["gm", "nostr"], "#p": [AUTHORS[0]], limit: 50 }];
      const got = await stores.events.query(filters);
      expect(new Set(got.map((e) => e.id)).size).toBe(got.length);
      expect(got.map((e) => e.id)).toEqual((await generic.query(filters)).map((e) => e.id));
    }
  });

  test("event_tags.created_at always equals the event's created_at", async () => {
    const row = await stores.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM event_tags t JOIN events e ON e.seq = t.event_seq WHERE t.created_at <> e.created_at",
    );
    expect(row?.n).toBe(0);
  });

  test("shapes are sqlite-only and skipped for ids, search, and long lists", () => {
    const many = AUTHORS.concat(AUTHORS.map((a) => a.replace(/^./, "f"))); // 60 authors
    expect(stores.events.querySql({ ids: [AUTHORS[1]], kinds: [1, 7], limit: 5 }, NOW, 5)!.sql).not.toContain("UNION ALL");
    expect(stores.events.querySql({ authors: many, limit: 5 }, NOW, 5)!.sql).not.toContain("UNION ALL");
    // a long authors list keeps the generic form even when kinds alone would fit
    expect(stores.events.querySql({ authors: many, kinds: [1, 7], limit: 5 }, NOW, 5)!.sql).not.toContain("UNION ALL");
    expect(stores.events.querySql({ kinds: [1, 7] }, NOW)!.sql).not.toContain("UNION ALL");
    expect(stores.events.querySql({ "#t": ["gm", "art"], limit: 5 }, NOW, 5)!.sql).not.toContain("CROSS JOIN");
    expect(generic.querySql({ kinds: [1, 7], "#t": ["gm"], limit: 5 }, NOW, 5)!.sql).not.toMatch(/UNION ALL|CROSS JOIN/);
  });
});

describe("sqlite query plans", () => {
  const plan = async (f: Filter) => {
    const q = stores.events.querySql(f, NOW, f.limit)!;
    const rows = await stores.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, q.params);
    return rows.map((r) => r.detail);
  };
  const check = async () => {
    const kinds = await plan({ kinds: [1, 7], limit: 20 });
    expect(kinds.filter((d) => d.includes("USING INDEX events_kind_created_idx (kind=?)")).length).toBe(2);
    expect(kinds.some((d) => /SCAN e\b/.test(d))).toBe(false);

    const authors = await plan({ authors: AUTHORS.slice(0, 3), kinds: [1, 6], limit: 20 });
    expect(authors.filter((d) => /USING INDEX events_pubkey_(kind_)?created_idx \(pubkey=\?/.test(d)).length).toBe(3);

    const tag = await plan({ "#p": [AUTHORS[0]], kinds: [1, 7], limit: 20 });
    expect(tag[0]).toMatch(/^SEARCH t USING (COVERING )?INDEX event_tags_lookup_idx \(name=\? AND value=\?\)$/);
    expect(tag.some((d) => d.includes("SEARCH e USING INTEGER PRIMARY KEY (rowid=?)"))).toBe(true);
    // ordered by the index: only the id tie-break needs sorting
    expect(tag.some((d) => d === "USE TEMP B-TREE FOR ORDER BY")).toBe(false);

    const since = await plan({ "#t": ["gm"], since: T + 100, until: T + 300, limit: 20 });
    expect(since[0]).toContain("event_tags_lookup_idx (name=? AND value=? AND created_at>? AND created_at<?)");
  };

  test("the intended indexes are used on a fresh database (no planner stats)", async () => {
    await check();
  });

  test("the intended indexes are used after ANALYZE", async () => {
    await stores.db.exec("ANALYZE");
    await check();
  });
});
