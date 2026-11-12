import { afterEach, describe, expect, test } from "bun:test";
import { ConfigSchema, DbSwitchingError, EventBus, isDbSwitchingError, type Db, type DbSwappedEvent } from "@beamhop/sdk";
import { createDb, createMemoryDb, createSettingsService, createStores, silentLogger, SwappableDb, type StorageStores } from "../src";
import { isWriteSql } from "../src/swappable";
import { signer } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const config = ConfigSchema.parse({ database: { driver: "sqlite", sqlitePath: ":memory:" } });

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

async function memDb(): Promise<Db> {
  const db = await createMemoryDb();
  cleanup.push(() => db.close());
  return db;
}

async function wrapped(pauseWaitMs = 2000) {
  const inner = await memDb();
  const db = new SwappableDb(inner, { pauseWaitMs });
  await db.exec("CREATE TABLE t (x INTEGER)");
  return { db, inner };
}

describe("isWriteSql", () => {
  test("classifies statements", () => {
    expect(isWriteSql("SELECT 1")).toBe(false);
    expect(isWriteSql("  -- note\n /* c */ insert into t values (1) RETURNING x")).toBe(true);
    expect(isWriteSql("UPDATE t SET x = 1")).toBe(true);
    expect(isWriteSql("delete from t returning x")).toBe(true);
    expect(isWriteSql("REPLACE INTO t VALUES (1)")).toBe(true);
    expect(isWriteSql("WITH a AS (SELECT 1) SELECT * FROM a")).toBe(false);
    expect(isWriteSql("WITH a AS (DELETE FROM t RETURNING x) SELECT * FROM a")).toBe(true);
    expect(isWriteSql("SELECT updated_at FROM kv")).toBe(false);
  });
});

describe("SwappableDb gate", () => {
  test("reads flow while paused", async () => {
    const { db } = await wrapped();
    await db.run("INSERT INTO t VALUES (1)");
    await db.pauseWrites();
    expect(db.phase).toBe("paused");
    expect(await db.all<{ x: number }>("SELECT x FROM t")).toEqual([{ x: 1 }]);
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM t")).toEqual({ n: 1 });
    db.resumeWrites();
  });

  test("a write waits while paused and succeeds on resume", async () => {
    const { db } = await wrapped();
    await db.pauseWrites();
    let done = false;
    const w = db.run("INSERT INTO t VALUES (2)").then((r) => {
      done = true;
      return r;
    });
    const viaAll = db.all("INSERT INTO t VALUES (3) RETURNING x");
    await sleep(30);
    expect(done).toBe(false);
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM t"))?.n).toBe(0);
    db.resumeWrites();
    expect((await w).changes).toBe(1);
    expect(await viaAll).toEqual([{ x: 3 }]);
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM t"))?.n).toBe(2);
  });

  test("a write rejects with DbSwitchingError after pauseWaitMs", async () => {
    const { db } = await wrapped(50);
    await db.pauseWrites();
    const started = Date.now();
    const err = await db.run("INSERT INTO t VALUES (1)").catch((e) => e);
    expect(err).toBeInstanceOf(DbSwitchingError);
    expect(isDbSwitchingError(err)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(await db.tx(async () => 1).catch((e) => e)).toBeInstanceOf(DbSwitchingError);
    expect(await db.exec("DELETE FROM t").catch((e) => e)).toBeInstanceOf(DbSwitchingError);
    expect(await db.get("UPDATE t SET x = 1 RETURNING x").catch((e) => e)).toBeInstanceOf(DbSwitchingError);
    db.resumeWrites();
    expect((await db.run("INSERT INTO t VALUES (1)")).changes).toBe(1);
  });

  test("pauseWrites waits for an in-flight transaction (which keeps writing through the wrapper)", async () => {
    const { db } = await wrapped();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const txDone = db.tx(async (tx) => {
      await tx.run("INSERT INTO t VALUES (1)");
      await gate;
      // statements on the wrapper from inside the transaction's context pass the gate
      await db.run("INSERT INTO t VALUES (2)");
      await tx.run("INSERT INTO t VALUES (3)");
      return "ok";
    });
    await sleep(5);
    let paused = false;
    const pausing = db.pauseWrites().then(() => (paused = true));
    await sleep(20);
    expect(paused).toBe(false);
    release();
    expect(await txDone).toBe("ok");
    await pausing;
    expect(paused).toBe(true);
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM t"))?.n).toBe(3);
    // idempotent
    await db.pauseWrites();
    db.resumeWrites();
  });

  test("phase listeners and idempotent pause", async () => {
    const { db } = await wrapped();
    const phases: string[] = [];
    const off = db.onPhase((p) => phases.push(p));
    await db.pauseWrites();
    await db.pauseWrites();
    db.resumeWrites();
    off();
    await db.pauseWrites();
    db.resumeWrites();
    expect(phases).toEqual(["paused", "normal"]);
  });

  test("swap and runBeforeFinalCopy require paused writes", async () => {
    const { db } = await wrapped();
    await expect(db.swap(await memDb())).rejects.toThrow(/paused/);
    await expect(db.runBeforeFinalCopy()).rejects.toThrow(/paused/);
  });

  test("swap points at the new db, runs hooks in order, hooks may write", async () => {
    const { db, inner } = await wrapped(50);
    await db.run("INSERT INTO t VALUES (1)");
    const next = await memDb();
    await next.exec("CREATE TABLE t (x INTEGER)");
    const seen: string[] = [];
    db.onBeforeFinalCopy(async () => {
      seen.push("flush");
      await db.run("INSERT INTO t VALUES (10)"); // allowed while paused: runs inside the hook
    });
    db.onSwapped(async (e) => {
      await sleep(5);
      seen.push(`a:${e.from}->${e.to}`);
    });
    const off = db.onSwapped(() => void seen.push("removed"));
    off();
    db.onSwapped(async () => {
      seen.push("b");
      await db.run("INSERT INTO t VALUES (20)");
    });
    await db.pauseWrites();
    await db.runBeforeFinalCopy();
    const prev = await db.swap(next);
    expect(prev).toBe(inner);
    expect(db.current).toBe(next);
    expect(seen).toEqual(["flush", "a:sqlite->sqlite", "b"]);
    // still paused after the swap
    expect(await db.run("INSERT INTO t VALUES (99)").catch((e) => e)).toBeInstanceOf(DbSwitchingError);
    db.resumeWrites();
    await db.run("INSERT INTO t VALUES (30)");
    expect((await db.all<{ x: number }>("SELECT x FROM t ORDER BY x")).map((r) => r.x)).toEqual([20, 30]);
    expect((await inner.all<{ x: number }>("SELECT x FROM t ORDER BY x")).map((r) => r.x)).toEqual([1, 10]);
  });

  test("a failing hook rolls the swap back and re-runs the hooks reversed", async () => {
    const { db, inner } = await wrapped();
    const next = await memDb();
    const events: (DbSwappedEvent & { hook: string; current: Db })[] = [];
    db.onSwapped((e) => void events.push({ ...e, hook: "a", current: db.current }));
    let fail = true;
    db.onSwapped(() => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      events.push({ from: "sqlite", to: "sqlite", hook: "b", current: db.current });
    });
    db.onSwapped((e) => {
      events.push({ ...e, hook: "c", current: db.current });
      throw new Error("ignored while rolling back");
    });
    await db.pauseWrites();
    await expect(db.swap(next)).rejects.toThrow("boom");
    await sleep(0);
    expect(db.current).toBe(inner);
    expect(events.map((e) => [e.hook, e.current === next ? "next" : "prev"])).toEqual([
      ["a", "next"],
      ["a", "prev"],
      ["b", "prev"],
      ["c", "prev"],
    ]);
    db.resumeWrites();
  });

  test("registeredMigrations records every migrate call (latest list per namespace, first-seen order)", async () => {
    const db = new SwappableDb(await memDb());
    const m1 = [{ id: "001", up: "CREATE TABLE a (x INTEGER)" }];
    const m2 = [{ id: "001", up: "CREATE TABLE b (x INTEGER)" }];
    await db.migrate("one", m1);
    await db.migrate("two", m2);
    await db.migrate("one", [...m1, { id: "002", up: "CREATE TABLE a2 (x INTEGER)" }]);
    expect(db.registeredMigrations().map((n) => [n.namespace, n.migrations.map((m) => m.id)])).toEqual([
      ["one", ["001", "002"]],
      ["two", ["001"]],
    ]);
  });

  test("close closes the current inner db", async () => {
    const a = await createMemoryDb();
    const b = await createMemoryDb();
    const db = new SwappableDb(a);
    await db.pauseWrites();
    await db.swap(b);
    db.resumeWrites();
    await db.close();
    await expect(b.get("SELECT 1 AS x")).rejects.toThrow();
    expect(await a.get("SELECT 1 AS x")).toEqual({ x: 1 });
    await a.close();
  });
});

// ------------------------------------------------------------------ live stores

/** Copies the given tables row by row (the columns the source has). */
async function copyTables(from: Db, to: Db, tables: string[]) {
  for (const table of tables) {
    const rows = await from.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
    for (const r of rows) {
      const cols = Object.keys(r);
      await to.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => r[c]));
    }
  }
}
const COPIED = ["events", "event_tags", "deleted_events", "users", "kv", "invites", "ip_rules", "audit_log"];

async function prepare(stores: StorageStores, target: Db) {
  for (const n of stores.swappable.registeredMigrations()) await target.migrate(n.namespace, n.migrations);
}

async function seed(stores: StorageStores) {
  const a = signer();
  const T = 1_700_000_000;
  const note = a.sign({ kind: 1, created_at: T, tags: [["t", "swap"]], content: "hello swapped world" });
  await stores.events.save(note);
  await stores.users.upsert(a.pubkey, { allowed: true, nip05Name: "alice" });
  await stores.users.touch(a.pubkey, T);
  await stores.kv.set("ns", "k", { v: 1 });
  return { a, note, T };
}

async function swapTo(stores: StorageStores, target: Db, copy: () => Promise<void>) {
  await stores.swappable.pauseWrites();
  await stores.swappable.runBeforeFinalCopy();
  await copy();
  const prev = await stores.swappable.swap(target);
  stores.swappable.resumeWrites();
  return prev;
}

test("swap two sqlite databases under live stores", async () => {
  const stores = await createStores(config, silentLogger, { db: await memDb() });
  cleanup.push(() => stores.users.close());
  const settings = await createSettingsService(stores, new EventBus());
  await settings.update({ info: { name: "before" } }, "me");
  const { a, note, T } = await seed(stores);
  const target = await memDb();
  await prepare(stores, target);
  const old = await swapTo(stores, target, () => copyTables(stores.swappable.current, target, COPIED));
  // the user's touch was flushed before the copy
  expect((await target.get<{ event_count: number }>("SELECT event_count FROM users WHERE pubkey = ?", [a.pubkey]))?.event_count).toBe(1);

  // everything now reads and writes the new database
  await old.run("DELETE FROM events");
  await old.run("DELETE FROM kv");
  await old.run("DELETE FROM users");
  expect((await stores.events.query([{ "#t": ["swap"] }])).map((e) => e.id)).toEqual([note.id]);
  expect((await stores.events.query([{ search: "swapped" }])).map((e) => e.id)).toEqual([note.id]);
  expect((await stores.users.get(a.pubkey))?.allowed).toBe(true);
  expect(await stores.kv.get("ns", "k")).toEqual({ v: 1 });
  const n2 = a.sign({ kind: 1, created_at: T + 1, content: "after the swap" });
  expect((await stores.events.save(n2)).status).toBe("saved");
  expect((await target.get<{ n: number }>("SELECT COUNT(*) AS n FROM events"))?.n).toBe(2);
  expect((await old.get<{ n: number }>("SELECT COUNT(*) AS n FROM events"))?.n).toBe(0);
  expect(settings.get().info.name).toBe("before");
});

test("settings reload after a swap and notify only on change", async () => {
  const stores = await createStores(config, silentLogger, { db: await memDb() });
  cleanup.push(() => stores.users.close());
  const settings = await createSettingsService(stores, new EventBus());
  await settings.update({ info: { name: "old db" } }, "me");
  const seen: string[] = [];
  settings.onChange((s) => seen.push(s.info.name));

  // identical copy: no notification
  const same = await memDb();
  await prepare(stores, same);
  await swapTo(stores, same, () => copyTables(stores.swappable.current, same, ["kv"]));
  expect(seen).toEqual([]);

  // a database holding different settings: reloaded and notified
  const other = await memDb();
  await prepare(stores, other);
  await other.run("INSERT INTO kv (namespace, key, value, updated_at) VALUES ('settings', 'runtime', ?, 0)", [JSON.stringify({ info: { name: "new db" } })]);
  await swapTo(stores, other, async () => {});
  expect(settings.get().info.name).toBe("new db");
  expect(seen).toEqual(["new db"]);
});

// ------------------------------------------------------------------ sqlite -> postgres

// Runs against a real database only when BEAMHOP_TEST_PG=postgres://... is set. Drops storage tables first!
const pgUrl = process.env.BEAMHOP_TEST_PG;

test.skipIf(!pgUrl)("swap sqlite -> postgres under live stores", async () => {
  const stores = await createStores(config, silentLogger, { db: await memDb() });
  cleanup.push(() => stores.users.close());
  const settings = await createSettingsService(stores, new EventBus());
  await settings.update({ info: { name: "sqlite relay" } }, "me");
  const { a, note, T } = await seed(stores);
  const replaceable = a.sign({ kind: 0, created_at: T, content: "{}" });
  await stores.events.save(replaceable);

  const pg = await createDb(ConfigSchema.parse({ database: { driver: "postgres", postgresUrl: pgUrl } }));
  cleanup.push(() => pg.close());
  await pg
    .exec(
      "DROP TABLE IF EXISTS event_tags, events, deleted_events, users, invites, ip_rules, kv, audit_log CASCADE; DELETE FROM _migrations WHERE namespace = 'storage'",
    )
    .catch(() => {});
  await prepare(stores, pg);
  await swapTo(stores, pg, async () => {
    await copyTables(stores.swappable.current, pg, COPIED);
    await pg.exec("SELECT setval(pg_get_serial_sequence('events', 'seq'), (SELECT MAX(seq) FROM events))");
    await pg.exec("SELECT setval(pg_get_serial_sequence('audit_log', 'id'), (SELECT MAX(id) FROM audit_log))");
  });
  expect(stores.db.dialect).toBe("postgres");

  // events: query, full-text search (fts rebound to postgres), save, replace, count, delete
  expect((await stores.events.query([{ "#t": ["swap"] }])).map((e) => e.id)).toEqual([note.id]);
  expect((await stores.events.query([{ search: "swapped" }])).map((e) => e.id)).toEqual([note.id]);
  const n2 = a.sign({ kind: 1, created_at: T + 1, tags: [["t", "swap"]], content: "written to postgres" });
  expect((await stores.events.save(n2)).status).toBe("saved");
  expect((await stores.events.save(n2)).status).toBe("duplicate");
  expect((await stores.events.save(a.sign({ kind: 0, created_at: T + 5, content: "{}" }))).status).toBe("replaced");
  expect((await stores.events.query([{ search: "postgres" }])).map((e) => e.id)).toEqual([n2.id]);
  expect(await stores.events.count([{ authors: [a.pubkey] }])).toBe(3);
  expect(await stores.events.applyDeletion(a.sign({ kind: 5, created_at: T + 6, tags: [["e", note.id]] }))).toBe(1);
  expect((await stores.events.query([{ "#t": ["swap"] }])).map((e) => e.id)).toEqual([n2.id]);
  expect((await stores.events.stats()).sizeBytes).toBeGreaterThan(0);

  // users
  expect((await stores.users.get(a.pubkey))?.eventCount).toBe(1);
  await stores.users.touch(a.pubkey, T + 10);
  await stores.flush();
  expect((await stores.users.get(a.pubkey))?.eventCount).toBe(2);
  expect((await stores.users.getByNip05("alice"))?.pubkey).toBe(a.pubkey);
  expect((await stores.users.list({ search: a.pubkey.slice(0, 8), sort: "eventCount" })).total).toBe(1);
  expect((await stores.users.list({ tag: "none" })).total).toBe(0);
  const inv = await stores.invites.create({ createdBy: "x" });
  expect(await stores.invites.redeem(inv.code, signer().pubkey)).toBe(true);

  // kv + settings + audit
  expect(await stores.kv.get("ns", "k")).toEqual({ v: 1 });
  expect(await stores.kv.setIfAbsent("ns", "k2", 1)).toBe(true);
  expect(settings.get().info.name).toBe("sqlite relay");
  await settings.update({ info: { name: "postgres relay" } }, "me");
  expect((await pg.get<{ value: string }>("SELECT value FROM kv WHERE namespace = 'settings' AND key = 'runtime'"))?.value).toContain("postgres relay");
  expect((await stores.audit.list({}))[0].action).toBe("settings.update");
});
