import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { nowSec } from "@beamhop/sdk";
import { createTestStores, randomCode, type StorageStores } from "../src";

let stores: StorageStores;
beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

const pk = (c: string) => c.repeat(64);

describe("users", () => {
  test("upsert creates with defaults and merges patches", async () => {
    const u = await stores.users.upsert(pk("a"), { allowed: true, tags: ["vip"], nip05Name: "Alice" });
    expect(u).toMatchObject({ pubkey: pk("a"), status: "active", allowed: true, tags: ["vip"], nip05Name: "alice", role: null });
    const u2 = await stores.users.upsert(pk("a"), { status: "banned", banReason: "spam", rateLimit: { eventsPerMinute: 5 } });
    expect(u2).toMatchObject({ allowed: true, tags: ["vip"], status: "banned", banReason: "spam", rateLimit: { eventsPerMinute: 5 } });
    expect((await stores.users.getByNip05("ALICE"))?.pubkey).toBe(pk("a"));
    await stores.users.delete(pk("a"));
    expect(await stores.users.get(pk("a"))).toBeUndefined();
  });

  test("touch is buffered, overlaid on reads and flushed", async () => {
    await stores.users.upsert(pk("b"), { notes: "existing" });
    await stores.users.touch(pk("a"), 100);
    await stores.users.touch(pk("a"), 200);
    await stores.users.touch(pk("b"), 150);
    // nothing written yet, but reads see pending activity
    expect(await stores.db.get("SELECT 1 AS x FROM users WHERE pubkey = ?", [pk("a")])).toBeUndefined();
    expect(await stores.users.get(pk("a"))).toMatchObject({ firstSeenAt: 100, lastSeenAt: 200, eventCount: 2 });
    await stores.flush();
    await stores.users.touch(pk("a"), 300);
    await stores.flush();
    expect(await stores.users.get(pk("a"))).toMatchObject({ firstSeenAt: 100, lastSeenAt: 300, eventCount: 3 });
    expect(await stores.users.get(pk("b"))).toMatchObject({ notes: "existing", firstSeenAt: 150, eventCount: 1 });
    // upsert must not clobber activity counters
    await stores.users.upsert(pk("a"), { notes: "x" });
    expect((await stores.users.get(pk("a")))?.eventCount).toBe(3);
  });

  test("list: search, filters, sort, pagination", async () => {
    await stores.users.upsert(pk("a"), { nip05Name: "alice", tags: ["vip"], role: "admin", allowed: true });
    await stores.users.upsert(pk("b"), { notes: "Known SPAMMER", status: "banned" });
    await stores.users.upsert(pk("c"), { tags: ["vip_100%"] });
    for (const [p, at, n] of [["a", 10, 1], ["b", 30, 5], ["c", 20, 3]] as const)
      for (let i = 0; i < n; i++) await stores.users.touch(pk(p), at);
    await stores.flush();

    const keys = (r: { items: { pubkey: string }[] }) => r.items.map((u) => u.pubkey[0]);
    expect(keys(await stores.users.list({}))).toEqual(["b", "c", "a"]);
    expect(keys(await stores.users.list({ sort: "eventCount" }))).toEqual(["b", "c", "a"]);
    expect(keys(await stores.users.list({ sort: "firstSeen" }))).toEqual(["b", "c", "a"]);
    expect(keys(await stores.users.list({ search: "ali" }))).toEqual(["a"]);
    expect(keys(await stores.users.list({ search: "spammer" }))).toEqual(["b"]);
    expect(keys(await stores.users.list({ search: "cccc" }))).toEqual(["c"]);
    expect(keys(await stores.users.list({ search: "100%" }))).toEqual(["c"]);
    expect(keys(await stores.users.list({ tag: "vip" }))).toEqual(["a"]);
    expect(keys(await stores.users.list({ status: "banned" }))).toEqual(["b"]);
    expect(keys(await stores.users.list({ role: "admin", allowed: true }))).toEqual(["a"]);
    const page = await stores.users.list({ limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(keys(page)).toEqual(["c"]);
  });
});

describe("invites", () => {
  test("random codes", () => {
    const c = randomCode();
    expect(c).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(new Set(Array.from({ length: 200 }, () => randomCode())).size).toBe(200);
  });

  test("redeem consumes uses atomically and marks user allowed", async () => {
    const inv = await stores.invites.create({ createdBy: pk("f"), maxUses: 2, note: "friends" });
    expect(inv).toMatchObject({ createdBy: pk("f"), maxUses: 2, uses: 0, expiresAt: null, note: "friends" });
    const results = await Promise.all([pk("1"), pk("2"), pk("3")].map((p) => stores.invites.redeem(inv.code, p)));
    expect(results.filter(Boolean).length).toBe(2);
    expect((await stores.invites.list())[0].uses).toBe(2);
    expect(await stores.users.get(pk("1"))).toMatchObject({ allowed: true, invitedBy: pk("f") });
    expect(await stores.invites.redeem("nope", pk("4"))).toBe(false);
  });

  test("expired, unlimited and revoked invites", async () => {
    const expired = await stores.invites.create({ createdBy: pk("f"), expiresAt: nowSec() - 1 });
    expect(await stores.invites.redeem(expired.code, pk("1"))).toBe(false);
    const unlimited = await stores.invites.create({ createdBy: pk("f"), maxUses: 0 });
    for (let i = 0; i < 5; i++) expect(await stores.invites.redeem(unlimited.code, pk(String(i)))).toBe(true);
    await stores.invites.revoke(unlimited.code);
    expect(await stores.invites.redeem(unlimited.code, pk("9"))).toBe(false);
    expect((await stores.invites.list()).map((i) => i.code)).toEqual([expired.code]);
  });
});

test("ip rules", async () => {
  await stores.ipRules.add({ cidr: "10.0.0.0/8", action: "block", reason: "lan" });
  await stores.ipRules.add({ cidr: "10.0.0.0/8", action: "allow", reason: "changed" });
  await stores.ipRules.add({ cidr: "1.2.3.4", action: "block", reason: "" });
  const rules = await stores.ipRules.list();
  expect(rules.length).toBe(2);
  expect(rules.find((r) => r.cidr === "10.0.0.0/8")).toMatchObject({ action: "allow", reason: "changed" });
  await stores.ipRules.remove("1.2.3.4");
  expect((await stores.ipRules.list()).length).toBe(1);
});

test("kv", async () => {
  await stores.kv.set("ns", "a", { x: [1, 2] });
  await stores.kv.set("ns", "b", "str");
  await stores.kv.set("ns", "b", 42);
  await stores.kv.set("other", "a", true);
  expect(await stores.kv.get("ns", "a")).toEqual({ x: [1, 2] });
  expect(await stores.kv.list("ns")).toEqual({ a: { x: [1, 2] }, b: 42 });
  await stores.kv.delete("ns", "a");
  expect(await stores.kv.get("ns", "a")).toBeUndefined();
});

test("audit log", async () => {
  for (let i = 0; i < 5; i++)
    await stores.audit.record({ actor: i % 2 ? "system" : pk("a"), action: "user.ban", target: pk(String(i)), details: { i }, ip: null });
  await stores.audit.record({ actor: "system", action: "settings.update", target: null, details: {}, ip: "1.1.1.1", at: 123 });
  const all = await stores.audit.list({});
  expect(all.length).toBe(6);
  expect(all[0]).toMatchObject({ action: "settings.update", at: 123, ip: "1.1.1.1", target: null });
  expect((await stores.audit.list({ actor: "system", action: "user.ban" })).map((e) => e.details.i)).toEqual([3, 1]);
  expect((await stores.audit.list({ before: all[1].id, limit: 2 })).map((e) => e.id)).toEqual([all[2].id, all[3].id]);
  expect((await stores.audit.list({ target: pk("2") }))[0].details).toEqual({ i: 2 });
});

test("db.close() flushes buffered touches", async () => {
  const path = `${import.meta.dir}/.tmp-close-${Date.now()}.db`;
  const { createStores, silentLogger } = await import("../src");
  const { ConfigSchema } = await import("@beamhop/sdk");
  const cfg = ConfigSchema.parse({ database: { sqlitePath: path } });
  const s1 = await createStores(cfg, silentLogger);
  await s1.users.touch(pk("a"), 5);
  await s1.db.close();
  const s2 = await createStores(cfg, silentLogger);
  expect((await s2.users.get(pk("a")))?.eventCount).toBe(1);
  await s2.close();
  const { rmSync } = await import("node:fs");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});
