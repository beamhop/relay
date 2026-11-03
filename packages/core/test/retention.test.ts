import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NostrEvent, RetentionRule } from "@beamhop/sdk";
import * as nip19 from "nostr-tools/nip19";
import { createTestStores, type StorageStores } from "@beamhop/storage";
import type { RelayContext } from "../src/context";
import { runRetention } from "../src/jobs/retention";

const T = 1_700_000_000;
const RELAY = "f".repeat(64);
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
let n = 0;
const ev = (pubkey: string, created_at: number, kind = 1): NostrEvent => ({
  id: (n++).toString(16).padStart(64, "0").split("").reverse().join(""), // ids not in created_at order
  pubkey,
  created_at,
  kind,
  tags: [],
  content: "",
  sig: "0".repeat(128),
});

let stores: StorageStores;
let rules: RetentionRule[];
const ctx = () =>
  ({
    s: () => ({ retention: { rules, intervalMinutes: 60 } }),
    key: { pubkey: RELAY },
    stores,
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
    bus: { emit() {} },
  }) as unknown as RelayContext;
const rule = (r: Partial<RetentionRule>): RetentionRule => ({ id: "r", enabled: true, exemptPubkeys: [], ...r });

/** saves through the store and counts the event like the relay's write path does (users.touch) */
async function publish(e: NostrEvent) {
  await stores.events.save(e);
  await stores.users.touch(e.pubkey, e.created_at);
}
const idsOf = async (pubkey: string) => (await stores.events.query([{ authors: [pubkey] }])).map((e) => e.id);

beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

describe("retention: per-pubkey caps", () => {
  test("keeps exactly the newest maxPerPubkey events (query order, ties at the boundary by id)", async () => {
    for (let i = 0; i < 30; i++) await publish(ev(A, T + Math.floor(i / 4))); // 4 events per second
    for (let i = 0; i < 5; i++) await publish(ev(B, T + i));
    const expected = (await idsOf(A)).slice(0, 10);
    rules = [rule({ maxPerPubkey: 10 })];
    expect(await runRetention(ctx())).toBe(20);
    expect(await idsOf(A)).toEqual(expected);
    expect((await idsOf(B)).length).toBe(5);
  });

  test("a kinds-restricted cap only counts and trims those kinds; exempt authors are untouched", async () => {
    for (let i = 0; i < 12; i++) await publish(ev(A, T + i, i % 2 ? 7 : 1));
    for (let i = 0; i < 12; i++) await publish(ev(C, T + i, 7));
    for (let i = 0; i < 12; i++) await publish(ev(RELAY, T + i, 7));
    rules = [rule({ maxPerPubkey: 2, kinds: [7], exemptPubkeys: [C] })];
    expect(await runRetention(ctx())).toBe(4 + 10); // A: 6 reactions → 2, relay key: not exempt for kind 7 only
    const a = await stores.events.query([{ authors: [A] }]);
    expect(a.filter((e) => e.kind === 1).length).toBe(6);
    expect(a.filter((e) => e.kind === 7).map((e) => e.created_at)).toEqual([T + 11, T + 9]);
    expect((await idsOf(C)).length).toBe(12);
  });

  test("the relay's own NIP-29 state is exempt when the rule covers all kinds", async () => {
    for (let i = 0; i < 6; i++) await publish(ev(RELAY, T + i, 39000));
    rules = [rule({ maxPerPubkey: 1 })];
    expect(await runRetention(ctx())).toBe(0);
  });

  test("authors verified within the cap are not counted again until their eventCount could cross it", async () => {
    for (let i = 0; i < 8; i++) await publish(ev(A, T + i));
    await stores.events.deleteByPubkey(A, T + 5); // 2 stored, eventCount still 8 (lifetime)
    for (let i = 0; i < 3; i++) await publish(ev(B, T + i));
    rules = [rule({ maxPerPubkey: 3 })];
    const trims: string[] = [];
    const trim = stores.events.trimPubkey.bind(stores.events);
    stores.events.trimPubkey = (pk, keep, o) => (trims.push(pk), trim(pk, keep, o));

    expect(await runRetention(ctx())).toBe(0);
    expect(trims).toEqual([A]); // B's eventCount is within the cap: never a candidate
    expect(await runRetention(ctx())).toBe(0);
    expect(trims).toEqual([A]); // stored 2 + 0 new ≤ 3
    await publish(ev(A, T + 100));
    expect(await runRetention(ctx())).toBe(0);
    expect(trims).toEqual([A]); // 2 + 1 ≤ 3: still provably within the cap
    await publish(ev(A, T + 101));
    expect(await runRetention(ctx())).toBe(1);
    expect(trims).toEqual([A, A]);
    expect((await stores.events.query([{ authors: [A] }])).map((e) => e.created_at)).toEqual([T + 101, T + 100, T + 7]);
  });

  test("candidates are paged by pubkey across many authors", async () => {
    const authors = Array.from({ length: 450 }, (_, i) => i.toString(16).padStart(64, "0"));
    for (const pk of authors) for (let i = 0; i < 3; i++) await publish(ev(pk, T + i));
    rules = [rule({ maxPerPubkey: 2 })];
    expect(await runRetention(ctx())).toBe(450);
    expect(await stores.events.count([{}])).toBe(900);
  });
});

describe("retention: maximum age", () => {
  test("old events of non-exempt authors are deleted in SQL without loading them", async () => {
    const now = Math.floor(Date.now() / 1000);
    const old = now - 40 * 86400;
    for (const pk of [A, C]) for (let i = 0; i < 5; i++) await publish(ev(pk, old + i));
    await publish(ev(A, now - 10));
    await publish(ev(RELAY, old));
    let queried = 0;
    const query = stores.events.query.bind(stores.events);
    stores.events.query = (...args) => (queried++, query(...args));
    rules = [rule({ maxAgeDays: 30, exemptPubkeys: [C] })];
    expect(await runRetention(ctx())).toBe(5);
    expect(queried).toBe(0);
    stores.events.query = query;
    expect((await idsOf(A)).length).toBe(1);
    expect((await idsOf(C)).length).toBe(5);
    expect((await idsOf(RELAY)).length).toBe(1);
  });

  test("regression: an exempt pubkey stored as an npub (or uppercase hex) still exempts its author", async () => {
    const old = Math.floor(Date.now() / 1000) - 40 * 86400;
    for (const pk of [A, B, C]) for (let i = 0; i < 3; i++) await publish(ev(pk, old + i));
    rules = [rule({ maxAgeDays: 30, exemptPubkeys: [nip19.npubEncode(B), C.toUpperCase()] })];
    expect(await runRetention(ctx())).toBe(3);
    expect((await idsOf(A)).length).toBe(0);
    expect((await idsOf(B)).length).toBe(3);
    expect((await idsOf(C)).length).toBe(3);
  });
});
