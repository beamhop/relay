import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus, nowSec } from "@beamhop/sdk";
import { createMemoryDb, createSettingsService, createTestStores, type StorageStores } from "../src";
import { SETTINGS_KEY, SETTINGS_NAMESPACE, salvageSettings } from "../src/settings";
import { signer } from "./helpers";

let stores: StorageStores;
beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

describe("runtime settings recovery", () => {
  test("one invalid stored field doesn't reset the access mode to public", async () => {
    await stores.kv.set(SETTINGS_NAMESPACE, SETTINGS_KEY, {
      access: { mode: "whitelist", authForRead: true },
      limits: { maxLimit: "lots" },
    });
    const bus = new EventBus();
    const alerts: string[] = [];
    bus.on("alert", (a) => void alerts.push(a.title));
    const s = await createSettingsService(stores, bus);
    expect(s.get().access.mode).toBe("whitelist");
    expect(s.get().access.authForRead).toBe(true);
    expect(s.get().limits.maxLimit).toBe(500);
    expect(alerts).toEqual(["Invalid stored settings"]);
  });

  test("salvageSettings reports dropped fields", () => {
    const { settings, dropped } = salvageSettings({ access: { mode: "nope" }, info: { name: "x" } });
    expect(settings.info.name).toBe("x");
    expect(dropped).toEqual(["access.mode"]);
  });
});

describe("NIP-40 boundary", () => {
  test("an event is expired once now >= expiration (matches core)", async () => {
    const a = signer();
    const now = nowSec();
    const atNow = a.sign({ kind: 1, created_at: now - 10, tags: [["expiration", String(now)]] });
    await stores.events.save(atNow);
    expect(await stores.events.query([{ ids: [atNow.id] }])).toEqual([]);
    expect(await stores.events.purgeExpired(now)).toBe(1);
  });

  test("the first expiration tag with a value counts; malformed values mean no expiration", async () => {
    const a = signer();
    const now = nowSec();
    const ev = a.sign({ kind: 1, created_at: now - 10, tags: [["expiration"], ["expiration", String(now - 1)]] });
    await stores.events.save(ev);
    expect(await stores.events.purgeExpired(now)).toBe(1);
  });
});

describe("sqlite transaction isolation", () => {
  test("statements from outside an open transaction are not rolled back with it", async () => {
    const db = await createMemoryDb();
    await db.exec("CREATE TABLE t (v TEXT)");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const failing = db
      .tx(async (tx) => {
        await tx.run("INSERT INTO t (v) VALUES ('inside')");
        await gate;
        throw new Error("rollback");
      })
      .catch(() => "rolled back");
    await Promise.resolve();
    const outside = db.run("INSERT INTO t (v) VALUES ('outside')");
    // the outside reader must not see uncommitted data either (it runs after the rollback, in order)
    const seen = db.all<{ v: string }>("SELECT v FROM t");
    release();
    expect(await failing).toBe("rolled back");
    await outside;
    expect((await seen).map((r) => r.v)).toEqual(["outside"]);
    expect((await db.all<{ v: string }>("SELECT v FROM t")).map((r) => r.v)).toEqual(["outside"]);
    await db.close();
  });
});

describe("users", () => {
  test("delete() during an in-flight flush doesn't resurrect the row", async () => {
    const pk = "d".repeat(64);
    await stores.users.touch(pk, nowSec());
    const flushing = stores.users.flush();
    const del = stores.users.delete(pk);
    await Promise.all([flushing, del]);
    expect(await stores.users.get(pk)).toBeUndefined();
  });

  test("tag filter is exact and case-sensitive on every backend", async () => {
    await stores.users.upsert("a".repeat(64), { tags: ["VIP"] });
    await stores.users.upsert("b".repeat(64), { tags: ["vip"] });
    const { items } = await stores.users.list({ tag: "vip" });
    expect(items.map((u) => u.pubkey)).toEqual(["b".repeat(64)]);
  });
});
