import { describe, expect, test } from "bun:test";
import { verifyEvent } from "nostr-tools/pure";
import { ConfigSchema, type DatabaseTarget, type Db, type TableProgress } from "@beamhop/sdk";
import { createStores, DatabaseCopier, inspectDatabase, openDatabase, prepareSchema, silentLogger, wipeDatabase, type StorageStores } from "../src";
import { convertValue } from "../src/transfer";
import { seed, snapshot, T, tempSqlite } from "./transfer-helpers";

const sqliteTarget = (): DatabaseTarget => ({ driver: "sqlite", sqlitePath: tempSqlite() });

/** Stores on an already-copied database (its migrations are already applied, so createStores only opens it). */
async function storesOn(db: Db): Promise<StorageStores> {
  const config = ConfigSchema.parse({ database: { driver: db.dialect, sqlitePath: ":memory:", postgresUrl: "postgres://unused" } });
  return createStores(config, silentLogger, { db });
}

async function getEvent(st: StorageStores, id: string) {
  return (await st.events.query([{ ids: [id] }]))[0];
}

async function rows(db: Db, sql: string) {
  return db.all<Record<string, unknown>>(sql);
}

describe("database transfer", () => {
  test("inspect / wipe", async () => {
    const t = sqliteTarget();
    const s = await seed(t);
    const info = await inspectDatabase(s.db, t);
    expect(info.serverVersion).toMatch(/^SQLite \d/);
    expect(info.sizeBytes).toBeGreaterThan(0);
    const names = info.tables.map((x) => x.name);
    expect(names).toContain("_migrations");
    expect(names).toContain("events");
    expect(names.some((n) => n.startsWith("events_fts"))).toBe(false);
    expect(names.some((n) => n.startsWith("sqlite_"))).toBe(false);
    expect(info.tables.find((x) => x.name === "plugin_log")?.rows).toBe(7);
    await wipeDatabase(s.db);
    expect((await inspectDatabase(s.db)).tables).toEqual([]);
    expect(await rows(s.db, "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")).toEqual([]);
    await s.stores.close();
  });

  test("value conversion", () => {
    expect(convertValue(true, "int")).toBe(1);
    expect(convertValue("42", "int")).toBe(42);
    expect(convertValue(42n, "int")).toBe(42);
    expect(convertValue("9007199254740993", "int")).toBe("9007199254740993");
    expect(convertValue(1, "bool")).toBe(1);
    expect(convertValue(false, "bool")).toBe(0);
    expect(convertValue("f", "bool")).toBe(0);
    expect(Buffer.isBuffer(convertValue(new Uint8Array([1, 2]), "bytes"))).toBe(true);
    expect(convertValue({ a: 1 }, "text")).toBe('{"a":1}');
    expect(convertValue("\ufeffx", "text")).toBe("\ufeffx");
    expect(convertValue(null, "int")).toBeNull();
  });

  test("sqlite → sqlite round trip", async () => {
    const src = sqliteTarget();
    const s = await seed(src);
    const before = await snapshot(s.stores);
    expect(before.penguin.length).toBe(41);
    expect(before.koeln.length).toBe(1);

    const tt = sqliteTarget();
    const target = await openDatabase(tt);
    await prepareSchema(target, s.recorded());
    const seen: TableProgress[][] = [];
    const copier = new DatabaseCopier(s.db, target, { logger: silentLogger, batchRows: 7, onProgress: (p) => seen.push(p) });
    await copier.bulkCopy();
    await copier.finalCopy();
    const report = await copier.verify();
    expect(report.tables.filter((t) => !t.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.map((t) => t.table)).toContain("event_tags");
    expect(report.tables.map((t) => t.table)).not.toContain("_migrations");
    expect(seen.length).toBeGreaterThan(3);
    expect(copier.progress().every((p) => p.done && p.copied === p.total)).toBe(true);

    const ts = await storesOn(target);
    expect(await snapshot(ts)).toEqual(before);
    const bom = await getEvent(ts, s.bomEvent.id);
    expect(bom?.content).toBe(s.bomEvent.content);
    expect(bom?.content.charCodeAt(0)).toBe(0xfeff);
    expect(verifyEvent({ ...bom! } as never)).toBe(true);
    for (const e of s.events) expect(verifyEvent({ ...(await getEvent(ts, e.id))! } as never)).toBe(true);
    const px = await rows(target, "SELECT id, data, flag, n, j FROM plugin_x ORDER BY id");
    expect([...(px[0].data as Uint8Array)]).toEqual([0, 1, 2, 255]);
    expect(px[0].flag).toBe(1);
    expect(px[0].n).toBe(2 ** 40);
    expect(px[1].data).toBeNull();
    expect((await ts.kv.get<{ info: { name: string } }>("settings", "runtime"))?.info.name).toBe("relay ☃");
    expect((await ts.users.get(s.b.pubkey))?.role).toBe("moderator");
    // the target keeps working: new rows get fresh keys
    const n = await ts.events.save(s.a.sign({ kind: 1, created_at: T + 500, content: "after the copy penguin" }));
    expect(n.status).toBe("saved");
    await ts.audit.record({ actor: "y", action: "after", target: null, details: {}, ip: null });
    expect((await ts.events.query([{ search: "penguin", limit: 500 }], { maxLimit: 500 })).length).toBe(42);
    await ts.close();
    await s.stores.close();
  });

  test("a non-empty target is visible to inspect and wipe makes it usable again", async () => {
    const s = await seed(sqliteTarget());
    const tt = sqliteTarget();
    const target = await openDatabase(tt);
    await prepareSchema(target, s.recorded());
    await target.run("INSERT INTO kv (namespace, key, value, updated_at) VALUES ('x', 'y', '1', 1)");
    expect((await inspectDatabase(target)).tables.some((t) => t.rows > 0)).toBe(true);
    await wipeDatabase(target);
    await prepareSchema(target, s.recorded());
    const copier = new DatabaseCopier(s.db, target, { logger: silentLogger });
    await copier.finalCopy(); // without bulkCopy: copies everything
    expect((await copier.verify()).ok).toBe(true);
    await target.close();
    await s.stores.close();
  });

  test("final copy catches up with inserts, deletions, updates and a reused seq", async () => {
    const s = await seed(sqliteTarget());
    const target = await openDatabase(sqliteTarget());
    await prepareSchema(target, s.recorded());
    const copier = new DatabaseCopier(s.db, target, { logger: silentLogger, batchRows: 5 });
    await copier.bulkCopy();

    // changes while the bulk copy was running / after it
    const added = [];
    for (let i = 0; i < 12; i++) {
      const e = s.b.sign({ kind: 1, created_at: T + 200 + i, content: `late penguin ${i}`, tags: [["t", `late${i}`]] });
      expect((await s.stores.events.save(e)).status).toBe("saved");
      added.push(e);
    }
    const victim = s.events.find((e) => e.content === "note 5 penguin")!;
    expect(await s.stores.events.applyDeletion(s.b.sign({ kind: 5, created_at: T + 300, tags: [["e", victim.id]] }))).toBe(1);
    // the highest seq is deleted and sqlite hands the same seq to the next event
    const top = await s.db.get<{ seq: number; id: string }>("SELECT seq, id FROM events ORDER BY seq DESC LIMIT 1");
    await s.db.run("DELETE FROM events WHERE seq = ?", [top!.seq]);
    const reused = s.a.sign({ kind: 1, created_at: T + 400, content: "reused seq penguin", tags: [["t", "reused"]] });
    expect((await s.stores.events.save(reused)).status).toBe("saved");
    expect((await s.db.get<{ seq: number }>("SELECT seq FROM events WHERE id = ?", [reused.id]))?.seq).toBe(top!.seq);
    await s.stores.kv.set("server", "relaySecretKey", "e".repeat(64));
    await s.stores.users.upsert(s.a.pubkey, { notes: "updated in place" });
    await s.stores.audit.record({ actor: "late", action: "late", target: null, details: {}, ip: null });
    await s.db.run("DELETE FROM audit_log WHERE action = 'a0'");
    await s.db.run("DELETE FROM plugin_log WHERE msg = 'm3'");

    await copier.finalCopy();
    const report = await copier.verify();
    expect(report.tables.filter((t) => !t.ok)).toEqual([]);

    const ts = await storesOn(target);
    expect(await snapshot(ts)).toEqual(await snapshot(s.stores));
    expect(await getEvent(ts, victim.id)).toBeUndefined();
    expect(await getEvent(ts, top!.id)).toBeUndefined();
    expect((await getEvent(ts, reused.id))?.content).toBe("reused seq penguin");
    expect((await ts.events.query([{ "#t": ["reused"] }])).map((e) => e.id)).toEqual([reused.id]);
    expect(await ts.kv.get("server", "relaySecretKey")).toBe("e".repeat(64));
    expect((await ts.users.get(s.a.pubkey))?.notes).toBe("updated in place");
    expect((await rows(target, "SELECT action FROM audit_log WHERE action IN ('a0', 'late')")).map((r) => r.action)).toEqual(["late"]);
    await ts.close();
    await s.stores.close();
  });

  test("a table the target lacks blocks the copy", async () => {
    const s = await seed(sqliteTarget());
    const target = await openDatabase(sqliteTarget());
    await prepareSchema(target, s.recorded().filter((n) => n.namespace !== "plugin_x"));
    const copier = new DatabaseCopier(s.db, target, { logger: silentLogger });
    await expect(copier.bulkCopy()).rejects.toThrow(/plugin_log, plugin_x/);
    await target.close();
    await s.stores.close();
  });

  test("abort signal stops the copy", async () => {
    const s = await seed(sqliteTarget());
    const target = await openDatabase(sqliteTarget());
    await prepareSchema(target, s.recorded());
    const ac = new AbortController();
    const copier = new DatabaseCopier(s.db, target, {
      logger: silentLogger,
      batchRows: 2,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.some((t) => t.copied > 4)) ac.abort(new Error("stop"));
      },
    });
    await expect(copier.bulkCopy()).rejects.toThrow("stop");
    await target.close();
    await s.stores.close();
  });
});

// Runs against a real database only when BEAMHOP_TEST_PG=postgres://... is set. Wipes that database!
const pgUrl = process.env.BEAMHOP_TEST_PG;

describe.skipIf(!pgUrl)("database transfer (postgres)", () => {
  const pgTarget = (): DatabaseTarget => ({ driver: "postgres", postgresUrl: pgUrl });

  test("sqlite → postgres → sqlite round trip", async () => {
    const s = await seed(sqliteTarget());
    const before = await snapshot(s.stores);

    const pg = await openDatabase(pgTarget());
    await wipeDatabase(pg);
    const pgInfo = await inspectDatabase(pg);
    expect(pgInfo.serverVersion).toMatch(/^PostgreSQL \d/);
    expect(pgInfo.tables).toEqual([]);
    await prepareSchema(pg, s.recorded());
    const c1 = new DatabaseCopier(s.db, pg, { logger: silentLogger, batchRows: 9 });
    await c1.bulkCopy();
    // a change between the phases
    const late = s.a.sign({ kind: 1, created_at: T + 900, content: "\ufefflate penguin", tags: [["t", "late"]] });
    expect((await s.stores.events.save(late)).status).toBe("saved");
    await c1.finalCopy();
    const r1 = await c1.verify();
    expect(r1.tables.filter((t) => !t.ok)).toEqual([]);

    const ps = await storesOn(pg);
    const mid = await snapshot(s.stores);
    expect(mid.penguin.length).toBe(before.penguin.length + 1);
    expect(await snapshot(ps)).toEqual(mid);
    for (const id of [s.bomEvent.id, late.id]) {
      const e = await getEvent(ps, id);
      expect(e?.content.charCodeAt(0)).toBe(0xfeff);
      expect(verifyEvent({ ...e! } as never)).toBe(true);
    }
    const px = await rows(pg, "SELECT id, data, flag, n, j FROM plugin_x ORDER BY id");
    expect(Buffer.isBuffer(px[0].data)).toBe(true);
    expect([...(px[0].data as Buffer)]).toEqual([0, 1, 2, 255]);
    expect(px[0].flag).toBe(true);
    expect(px[0].n).toBe(2 ** 40);
    expect(px[0].j).toEqual({ a: [1, 2] });
    // sequences moved past the copied keys
    expect((await ps.events.save(s.b.sign({ kind: 1, created_at: T + 901, content: "new on pg" }))).status).toBe("saved");
    await ps.audit.record({ actor: "pg", action: "pg.after", target: null, details: {}, ip: null });

    // and back to a fresh sqlite file
    const back = await openDatabase(sqliteTarget());
    await prepareSchema(back, s.recorded());
    const c2 = new DatabaseCopier(pg, back, { logger: silentLogger, batchRows: 11 });
    await c2.bulkCopy();
    await c2.finalCopy();
    const r2 = await c2.verify();
    expect(r2.tables.filter((t) => !t.ok)).toEqual([]);
    const bs = await storesOn(back);
    expect(await snapshot(bs)).toEqual(await snapshot(ps));
    const px2 = await rows(back, "SELECT id, data, flag, n, j FROM plugin_x ORDER BY id");
    expect([...(px2[0].data as Uint8Array)]).toEqual([0, 1, 2, 255]);
    expect(px2[0].flag).toBe(1);
    expect(JSON.parse(px2[0].j as string)).toEqual({ a: [1, 2] });
    expect(verifyEvent({ ...(await getEvent(bs, s.bomEvent.id))! } as never)).toBe(true);
    await bs.close();
    await ps.close();
    await s.stores.close();
  });

  test("postgres source: final copy reconciles deletions and late rows", async () => {
    const pg = await openDatabase(pgTarget());
    await wipeDatabase(pg);
    await pg.close();
    const s = await seed(pgTarget());
    const target = await openDatabase(sqliteTarget());
    await prepareSchema(target, s.recorded());
    const copier = new DatabaseCopier(s.db, target, { logger: silentLogger, batchRows: 4 });
    await copier.bulkCopy();
    const victim = s.events.find((e) => e.content === "note 7 penguin")!;
    expect(await s.stores.events.applyDeletion(s.b.sign({ kind: 5, created_at: T + 300, tags: [["e", victim.id]] }))).toBe(1);
    // a row committed below the high-water mark after the bulk pass (concurrent BIGSERIAL transactions do this)
    await s.db.run("INSERT INTO audit_log (id, at, actor, action, details) VALUES (?, ?, ?, ?, ?)", [-5, T, "x", "late-low", "{}"]);
    await copier.finalCopy();
    const report = await copier.verify();
    expect(report.tables.filter((t) => !t.ok)).toEqual([]);
    const ts = await storesOn(target);
    expect(await snapshot(ts)).toEqual(await snapshot(s.stores));
    expect(await getEvent(ts, victim.id)).toBeUndefined();
    expect((await rows(target, "SELECT action FROM audit_log WHERE id = -5")).map((r) => r.action)).toEqual(["late-low"]);
    await ts.close();
    await s.stores.close();
  });
});
