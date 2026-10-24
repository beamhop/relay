import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { createMemoryDb, createTestStores, type StorageStores } from "../src";
import { toFts5Query } from "../src/events";
import { salvageSettings } from "../src/settings";

let stores: StorageStores;
beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

const hex = (n: number) => n.toString(16).padStart(64, "0");

describe("NIP-50 search on sqlite", () => {
  test("search + kinds + time bounds stays fast without planner stats (FTS index drives the join)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await stores.db.tx(async () => {
      for (let i = 0; i < 3000; i++) {
        // a distinct token per event: the "tok" prefix expands to thousands of terms
        const ev: NostrEvent = { id: hex(i + 1), pubkey: "f".repeat(64), created_at: now - i, kind: 1, tags: [], content: `hello tok${i}x world`, sig: "0".repeat(128) };
        await stores.events.save(ev);
      }
    });
    const t = performance.now();
    const res = await stores.events.query([{ search: "tok", kinds: [1], since: 0, limit: 500 }]);
    const ms = performance.now() - t;
    expect(res.length).toBe(500);
    // the per-row FTS probe plan took seconds here
    expect(ms).toBeLessThan(400);
    expect(await stores.events.count([{ search: "tok", kinds: [1], since: 0 }])).toBe(3000);
  });

  test("1-2 character terms are not prefix-expanded", () => {
    expect(toFts5Query(["a"])).toBe('"a"');
    expect(toFts5Query(["ab"])).toBe('"ab"');
    expect(toFts5Query(["abc"])).toBe('"abc"*');
    expect(toFts5Query(["hello", "wo"])).toBe('"hello" "wo"');
  });
});

describe("runtime settings recovery", () => {
  test("invalid access settings fail closed instead of falling back to public defaults", () => {
    const { settings, dropped } = salvageSettings({ access: { mode: "bogus", authForRead: "yes", authForWrite: false } });
    expect(settings.access.mode).toBe("whitelist");
    expect(settings.access.authForRead).toBe(true);
    // one invalid access field locks all of access down (a valid `false` doesn't survive)
    expect(settings.access.authForWrite).toBe(true);
    expect(settings.access.allowInboundToMembers).toBe(false);
    expect(dropped.sort()).toEqual(["access.authForRead", "access.mode"]);
  });

  test("an unusable access section is locked down", () => {
    const { settings } = salvageSettings({ access: "open sesame" });
    expect(settings.access).toMatchObject({ mode: "whitelist", authForRead: true, authForWrite: true, allowInboundToMembers: false });
  });

  test("only the invalid array elements are dropped", () => {
    const { settings, dropped } = salvageSettings({ moderation: { kindBlocklist: [1, "two", 3] } });
    expect(settings.moderation.kindBlocklist).toEqual([1, 3]);
    expect(dropped).toEqual(["moderation.kindBlocklist.1"]);
  });
});

describe("sqlite transaction isolation", () => {
  test("work started inside a finished transaction doesn't run inside the next one", async () => {
    const db = await createMemoryDb();
    await db.exec("CREATE TABLE t (v TEXT)");
    let late!: Promise<unknown>;
    let fired!: () => void;
    const started = new Promise<void>((r) => (fired = r));
    await db.tx(async (tx) => {
      await tx.run("INSERT INTO t (v) VALUES ('a')");
      // fire and forget: keeps the transaction's async context after it committed
      setTimeout(() => {
        late = db.run("INSERT INTO t (v) VALUES ('late')");
        fired();
      }, 20);
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const failing = db
      .tx(async (tx) => {
        await tx.run("INSERT INTO t (v) VALUES ('b')");
        await gate;
        throw new Error("rollback");
      })
      .catch(() => "rolled back");
    await started;
    release();
    expect(await failing).toBe("rolled back");
    await late;
    expect((await db.all<{ v: string }>("SELECT v FROM t ORDER BY v")).map((r) => r.v)).toEqual(["a", "late"]);
    await db.close();
  });
});
