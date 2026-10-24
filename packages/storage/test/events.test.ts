import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { nowSec } from "@beamhop/sdk";
import { createTestStores, parseCoordinate, parseSearch, type StorageStores } from "../src";
import { signer } from "./helpers";

let stores: StorageStores;
beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

const T = 1_700_000_000;

describe("save", () => {
  test("regular events: saved then duplicate; ephemeral not stored", async () => {
    const a = signer();
    const e = a.sign({ kind: 1, created_at: T, content: "hi" });
    expect((await stores.events.save(e)).status).toBe("saved");
    expect((await stores.events.save(e)).status).toBe("duplicate");
    expect(await stores.events.getById(e.id)).toEqual(JSON.parse(JSON.stringify(e)));

    const eph = a.sign({ kind: 20001, created_at: T });
    expect((await stores.events.save(eph)).status).toBe("saved");
    expect(await stores.events.getById(eph.id)).toBeUndefined();
  });

  test("replaceable: newest wins, stale rejected, tie → lowest id", async () => {
    const a = signer();
    const v1 = a.sign({ kind: 0, created_at: T, content: '{"name":"v1"}' });
    const v2 = a.sign({ kind: 0, created_at: T + 10, content: '{"name":"v2"}' });
    expect((await stores.events.save(v1)).status).toBe("saved");
    expect((await stores.events.save(v2)).status).toBe("replaced");
    expect((await stores.events.save(v1)).status).toBe("stale");
    const res = await stores.events.query([{ kinds: [0], authors: [a.pubkey] }]);
    expect(res.map((e) => e.id)).toEqual([v2.id]);

    // tie on created_at
    const x = a.sign({ kind: 10002, created_at: T, content: "x" });
    const y = a.sign({ kind: 10002, created_at: T, content: "y" });
    const [lo, hi] = x.id < y.id ? [x, y] : [y, x];
    expect((await stores.events.save(hi)).status).toBe("saved");
    expect((await stores.events.save(lo)).status).toBe("replaced");
    expect((await stores.events.save(hi)).status).toBe("stale");
    expect((await stores.events.query([{ kinds: [10002] }])).map((e) => e.id)).toEqual([lo.id]);
  });

  test("addressable: per d tag, tags of replaced event are removed", async () => {
    const a = signer();
    const d1 = a.sign({ kind: 30023, created_at: T, tags: [["d", "one"], ["t", "old"]] });
    const d2 = a.sign({ kind: 30023, created_at: T, tags: [["d", "two"]] });
    const d1b = a.sign({ kind: 30023, created_at: T + 1, tags: [["d", "one"], ["t", "new"]] });
    expect((await stores.events.save(d1)).status).toBe("saved");
    expect((await stores.events.save(d2)).status).toBe("saved");
    expect((await stores.events.save(d1b)).status).toBe("replaced");
    expect(await stores.events.count([{ kinds: [30023] }])).toBe(2);
    expect(await stores.events.query([{ "#t": ["old"] }])).toEqual([]);
    expect((await stores.events.query([{ "#t": ["new"] }])).map((e) => e.id)).toEqual([d1b.id]);
    expect((await stores.events.query([{ "#d": ["one"] }])).map((e) => e.id)).toEqual([d1b.id]);
  });
});

describe("query", () => {
  test("filters, tags, since/until, limit, multiple filters, ordering", async () => {
    const a = signer();
    const b = signer();
    const evs = [
      a.sign({ kind: 1, created_at: T + 1, tags: [["t", "nostr"]], content: "a1" }),
      a.sign({ kind: 1, created_at: T + 2, tags: [["p", b.pubkey]], content: "a2" }),
      a.sign({ kind: 7, created_at: T + 3, tags: [["e", "x".repeat(64)]], content: "+" }),
      b.sign({ kind: 1, created_at: T + 4, tags: [["t", "nostr"], ["t", "bun"]], content: "b1" }),
      b.sign({ kind: 1, created_at: T + 4, content: "b2" }),
    ];
    for (const e of evs) await stores.events.save(e);
    const ids = (r: { id: string }[]) => r.map((e) => e.id);
    const tieSorted = [evs[3], evs[4]].sort((x, y) => (x.id < y.id ? -1 : 1));

    expect(ids(await stores.events.query([{}]))).toEqual([...tieSorted, evs[2], evs[1], evs[0]].map((e) => e.id));
    expect(ids(await stores.events.query([{ authors: [a.pubkey], kinds: [1] }]))).toEqual([evs[1].id, evs[0].id]);
    expect(ids(await stores.events.query([{ "#t": ["nostr"] }]))).toEqual([evs[3].id, evs[0].id]);
    expect(ids(await stores.events.query([{ "#t": ["nostr"], "#p": [b.pubkey] }]))).toEqual([]);
    expect(ids(await stores.events.query([{ "#p": [b.pubkey] }]))).toEqual([evs[1].id]);
    expect(ids(await stores.events.query([{ since: T + 2, until: T + 3 }]))).toEqual([evs[2].id, evs[1].id]);
    expect(ids(await stores.events.query([{ kinds: [1], limit: 1 }, { kinds: [7] }]))).toEqual([tieSorted[0].id, evs[2].id]);
    expect(ids(await stores.events.query([{ ids: [evs[0].id] }, { ids: [evs[0].id], kinds: [1] }]))).toEqual([evs[0].id]);
    expect(await stores.events.query([{ ids: [] }])).toEqual([]);
    expect(await stores.events.query([{ kinds: [1], limit: 0 }])).toEqual([]);
    expect(await stores.events.query([{ "#emoji": ["x"] }])).toEqual([]);
    expect((await stores.events.query([{}], { maxLimit: 2 })).length).toBe(2);
    expect((await stores.events.query([{ limit: 100 }], { maxLimit: 3 })).length).toBe(3);

    expect(await stores.events.count([{ kinds: [1] }])).toBe(4);
    expect(await stores.events.count([{ kinds: [1] }, { authors: [a.pubkey] }])).toBe(5);
    expect(await stores.events.queryIdsForSync({ authors: [a.pubkey] })).toEqual(
      [evs[0], evs[1], evs[2]].map((e) => ({ id: e.id, created_at: e.created_at })),
    );
  });

  test("large IN lists (json_each path)", async () => {
    const a = signer();
    const saved = [];
    for (let i = 0; i < 5; i++) {
      const e = a.sign({ kind: 1, created_at: T + i });
      await stores.events.save(e);
      saved.push(e.id);
    }
    const fakeIds = Array.from({ length: 1500 }, (_, i) => i.toString(16).padStart(64, "0"));
    const res = await stores.events.query([{ ids: [...fakeIds, ...saved] }]);
    expect(res.length).toBe(5);
    const kinds = Array.from({ length: 300 }, (_, i) => i);
    expect(await stores.events.count([{ kinds }])).toBe(5);
    expect(await stores.events.deleteByIds([...fakeIds, saved[0]])).toBe(1);
  });

  test("NIP-50 search (FTS) with extensions and special characters", async () => {
    const a = signer();
    const e1 = a.sign({ kind: 1, created_at: T + 1, content: "Hello beautiful Nostr world" });
    const e2 = a.sign({ kind: 1, created_at: T + 2, content: "bun is a fast javascript runtime" });
    const e3 = a.sign({ kind: 0, created_at: T + 3, content: JSON.stringify({ name: "satoshi", about: "café owner" }) });
    for (const e of [e1, e2, e3]) await stores.events.save(e);
    const ids = async (search: string, extra = {}) => (await stores.events.query([{ search, ...extra }])).map((e) => e.id);

    expect(await ids("nostr")).toEqual([e1.id]);
    expect(await ids("HELLO world")).toEqual([e1.id]);
    expect(await ids("javascri")).toEqual([e2.id]); // prefix on last term
    expect(await ids("satoshi", { kinds: [0] })).toEqual([e3.id]);
    expect(await ids("cafe")).toEqual([e3.id]); // diacritics removed
    expect(await ids("nostr domain:example.com language:en")).toEqual([e1.id]);
    expect(await ids('"beautiful nostr"')).toEqual([e1.id]);
    expect(await ids("hello ( ) * ^ \" : - NEAR")).toEqual([]); // operators are literal terms, never syntax
    expect(await ids("hello ( ) * ^ \" : -")).toEqual([e1.id]);
    expect(await ids("nothingmatches")).toEqual([]);
    expect(await stores.events.count([{ search: "runtime" }])).toBe(1);
    // filters with only extensions ignore the search constraint
    expect((await ids("include:spam")).length).toBe(3);
    // deleted events leave the index
    await stores.events.deleteByIds([e1.id]);
    expect(await ids("nostr")).toEqual([]);
  });

  test("NIP-40 expiration: hidden from queries and purged", async () => {
    const a = signer();
    const now = nowSec();
    const expired = a.sign({ kind: 1, created_at: now - 100, tags: [["expiration", String(now - 10)]] });
    const live = a.sign({ kind: 1, created_at: now - 100, tags: [["expiration", String(now + 1000)]] });
    await stores.events.save(expired);
    await stores.events.save(live);
    expect((await stores.events.query([{}])).map((e) => e.id)).toEqual([live.id]);
    expect(await stores.events.count([{}])).toBe(1);
    expect(await stores.events.purgeExpired(now)).toBe(1);
    expect((await stores.events.stats()).total).toBe(1);
  });
});

describe("deletion", () => {
  test("NIP-09 by e tag: own events only, tombstone blocks re-save, kind 5 untouched", async () => {
    const a = signer();
    const b = signer();
    const mine = a.sign({ kind: 1, created_at: T });
    const theirs = b.sign({ kind: 1, created_at: T });
    const prevDeletion = a.sign({ kind: 5, created_at: T, tags: [["e", mine.id]] });
    for (const e of [mine, theirs, prevDeletion]) await stores.events.save(e);

    const del = a.sign({ kind: 5, created_at: T + 5, tags: [["e", mine.id], ["e", theirs.id], ["e", prevDeletion.id]] });
    expect(await stores.events.applyDeletion(del)).toBe(1);
    expect(await stores.events.getById(mine.id)).toBeUndefined();
    expect(await stores.events.getById(theirs.id)).toBeDefined();
    expect(await stores.events.getById(prevDeletion.id)).toBeDefined();
    expect((await stores.events.save(mine)).status).toBe("deleted");
    // b's tombstone attempt on a's id is irrelevant to b
    await stores.events.deleteByIds([theirs.id]);
    expect((await stores.events.save(theirs)).status).toBe("saved");
  });

  test("NIP-09 by a tag: deletes versions up to deletion time, blocks older re-publish only", async () => {
    const a = signer();
    const b = signer();
    const art = a.sign({ kind: 30023, created_at: T, tags: [["d", "post"]] });
    const other = b.sign({ kind: 30023, created_at: T, tags: [["d", "post"]] });
    await stores.events.save(art);
    await stores.events.save(other);
    const del = a.sign({
      kind: 5,
      created_at: T + 10,
      tags: [["a", `30023:${a.pubkey}:post`], ["a", `30023:${b.pubkey}:post`]],
    });
    expect(await stores.events.applyDeletion(del)).toBe(1);
    expect(await stores.events.getById(other.id)).toBeDefined();
    const older = a.sign({ kind: 30023, created_at: T + 10, tags: [["d", "post"]] });
    expect((await stores.events.save(older)).status).toBe("deleted");
    const newer = a.sign({ kind: 30023, created_at: T + 11, tags: [["d", "post"]] });
    expect((await stores.events.save(newer)).status).toBe("saved");
    // a newer deletion raises the tombstone watermark
    const del2 = a.sign({ kind: 5, created_at: T + 20, tags: [["a", `30023:${a.pubkey}:post`]] });
    expect(await stores.events.applyDeletion(del2)).toBe(1);
    expect((await stores.events.save(a.sign({ kind: 30023, created_at: T + 15, tags: [["d", "post"]] }))).status).toBe("deleted");
  });

  test("NIP-59: recipients delete gift wraps addressed to them; tombstoned", async () => {
    const bob = signer();
    const wrap = signer().sign({ kind: 1059, created_at: T, tags: [["p", bob.pubkey]] });
    const other = signer().sign({ kind: 1059, created_at: T, tags: [["p", signer().pubkey]] });
    await stores.events.save(wrap);
    await stores.events.save(other);
    const del = bob.sign({ kind: 5, created_at: T + 1, tags: [["e", wrap.id], ["e", other.id]] });
    expect(await stores.events.applyDeletion(del)).toBe(1);
    expect(await stores.events.getById(wrap.id)).toBeUndefined();
    expect(await stores.events.getById(other.id)).toBeDefined();
    expect((await stores.events.save(wrap)).status).toBe("deleted");
  });

  test("deleteByIds with tombstone; deleteByPubkey until", async () => {
    const a = signer();
    const e1 = a.sign({ kind: 1, created_at: T });
    const e2 = a.sign({ kind: 1, created_at: T + 5 });
    const e3 = a.sign({ kind: 1, created_at: T + 10 });
    for (const e of [e1, e2, e3]) await stores.events.save(e);
    expect(await stores.events.deleteByIds([e1.id], { tombstone: "vanish" })).toBe(1);
    expect((await stores.events.save(e1)).status).toBe("deleted");
    expect(await stores.events.deleteByPubkey(a.pubkey, T + 5)).toBe(1);
    expect(await stores.events.getById(e3.id)).toBeDefined();
  });

  test("admin deletes: by filter, by pubkey; empty filter rejected", async () => {
    const a = signer();
    const b = signer();
    for (let i = 0; i < 4; i++) await stores.events.save(a.sign({ kind: 1, created_at: T + i, tags: [["t", "x"]] }));
    await stores.events.save(b.sign({ kind: 1, created_at: T }));
    expect(stores.events.deleteByFilter([{}])).rejects.toThrow();
    expect(await stores.events.deleteByFilter([{ "#t": ["x"], limit: 1 }])).toBe(1);
    expect(await stores.events.deleteByFilter([{ authors: [a.pubkey], until: T + 1 }])).toBe(2);
    expect(await stores.events.deleteByPubkey(a.pubkey)).toBe(1);
    const stats = await stores.events.stats();
    expect(stats.total).toBe(1);
    expect(stats.byKind).toEqual([{ kind: 1, count: 1 }]);
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });
});

test("parseSearch / parseCoordinate", () => {
  expect(parseSearch('foo domain:x.com "a b" http://x.y ---').terms).toEqual(["foo", "a b", "http://x.y"]);
  const pk = "a".repeat(64);
  expect(parseCoordinate(`30023:${pk}:with:colon`)).toEqual({ kind: 30023, pubkey: pk, d: "with:colon" });
  expect(parseCoordinate(`0:${pk}:`)).toEqual({ kind: 0, pubkey: pk, d: "" });
  expect(parseCoordinate(`1:${pk}:x`)).toBeNull();
  expect(parseCoordinate("garbage")).toBeNull();
});
