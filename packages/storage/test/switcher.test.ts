import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELETE_ROLLBACK_CONFIRM_PHRASE,
  WIPE_CONFIRM_PHRASE,
  type DatabaseInstanceInfo,
  type DatabaseStateFile,
  type DatabaseTarget,
  type Db,
  type DbSwappedEvent,
  type DbWritePhase,
  type NamespaceMigrations,
  type SwitchableDb,
  type TableProgress,
} from "@beamhop/sdk";
import { createMemoryDb, silentLogger } from "../src/index";
import { createDatabaseSwitcher, redactPostgresUrl, sameDatabase, TOO_MANY_CHANGES, type DatabaseCopierLike, type DatabaseSwitcherDeps, type DatabaseSwitcherOps } from "../src/switcher";
import type { DatabaseInspection, TransferOptions, VerifyReport } from "../src/transfer";

const PG_URL = "postgres://beam:s3cret-pw@db.internal:5432/beamhop";
const SQLITE_PATH = "/var/lib/beamhop/beamhop.db";

/** a Db that only records what was run on it */
class FakeDb implements Db {
  closed = false;
  runs: { sql: string; params?: unknown[] }[] = [];
  constructor(readonly dialect: "sqlite" | "postgres", readonly name: string) {}
  async all<T>() {
    return [] as T[];
  }
  async get<T>() {
    return undefined as T | undefined;
  }
  async run(sql: string, params?: unknown[]) {
    this.runs.push({ sql, params });
    return { changes: 1 };
  }
  async exec() {}
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async migrate() {}
  async close() {
    this.closed = true;
  }
}

class FakeSwitchable implements SwitchableDb {
  paused = false;
  pauseCalls = 0;
  resumeCalls = 0;
  beforeFinalCopyCalls = 0;
  swapError: Error | undefined;
  constructor(public inner: Db) {}
  get current() {
    return this.inner;
  }
  get dialect() {
    return this.inner.dialect;
  }
  get phase(): DbWritePhase {
    return this.paused ? "paused" : "normal";
  }
  all<T>(sql: string, p?: unknown[]) {
    return this.inner.all<T>(sql, p);
  }
  get<T>(sql: string, p?: unknown[]) {
    return this.inner.get<T>(sql, p);
  }
  run(sql: string, p?: unknown[]) {
    return this.inner.run(sql, p);
  }
  exec(sql: string) {
    return this.inner.exec(sql);
  }
  tx<T>(fn: (db: Db) => Promise<T>) {
    return this.inner.tx(fn);
  }
  migrate() {
    return Promise.resolve();
  }
  close() {
    return this.inner.close();
  }
  registeredMigrations(): NamespaceMigrations[] {
    return [{ namespace: "core", migrations: [{ id: "001", up: "SELECT 1" }] }];
  }
  async pauseWrites() {
    this.pauseCalls++;
    this.paused = true;
  }
  resumeWrites() {
    this.resumeCalls++;
    this.paused = false;
  }
  async runBeforeFinalCopy() {
    if (!this.paused) throw new Error("not paused");
    this.beforeFinalCopyCalls++;
  }
  async swap(next: Db) {
    if (!this.paused) throw new Error("not paused");
    if (this.swapError) throw this.swapError;
    const prev = this.inner;
    this.inner = next;
    return prev;
  }
  onBeforeFinalCopy() {
    return () => {};
  }
  onSwapped(_fn: (e: DbSwappedEvent) => void) {
    return () => {};
  }
  onPhase() {
    return () => {};
  }
}

interface FakeCopierBehaviour {
  bulk?: (signal: AbortSignal) => Promise<void>;
  final?: () => Promise<void>;
  verify?: VerifyReport;
}

async function setup(o: {
  initial?: DatabaseTarget;
  envPinned?: boolean;
  instances?: DatabaseInstanceInfo[];
  targetTables?: { name: string; rows: number }[];
  copier?: FakeCopierBehaviour;
  writeStateError?: Error;
  state?: DatabaseStateFile;
  pauseBudgetMs?: number;
  openError?: Error;
} = {}) {
  const oldDb = await createMemoryDb();
  await oldDb.exec("CREATE TABLE kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (namespace, key))");
  const db = new FakeSwitchable(oldDb);
  const audits: { actor: string; action: string; details: Record<string, unknown> }[] = [];
  let state: DatabaseStateFile | undefined = o.state;
  const opened: FakeDb[] = [];
  const wiped: Db[] = [];
  const removed: string[] = [];
  const schemaFor: NamespaceMigrations[][] = [];
  const switched: DatabaseTarget[] = [];
  let lastProgress: TableProgress[] = [];
  const ops: DatabaseSwitcherOps = {
    async openDatabase(t) {
      if (o.openError) throw o.openError;
      const d = new FakeDb(t.driver, t.postgresUrl ?? t.sqlitePath ?? "");
      opened.push(d);
      return d;
    },
    async inspectDatabase(d): Promise<DatabaseInspection> {
      if (d === oldDb) return { serverVersion: "SQLite 3", tables: [{ name: "events", rows: 3 }], sizeBytes: 4096 };
      return { serverVersion: "PostgreSQL 17", tables: wiped.includes(d) ? [] : (o.targetTables ?? []) };
    },
    async wipeDatabase(d) {
      wiped.push(d);
    },
    async prepareSchema(_t, ns) {
      schemaFor.push(ns);
    },
    createCopier(_s, _t, opts: TransferOptions): DatabaseCopierLike {
      const tables: TableProgress[] = [{ table: "events", total: 3, copied: 0, done: false }];
      return {
        progress: () => tables,
        async bulkCopy() {
          tables[0] = { ...tables[0], copied: 3, done: true };
          opts.onProgress?.(tables);
          lastProgress = tables;
          await o.copier?.bulk?.(opts.signal!);
        },
        async finalCopy() {
          await o.copier?.final?.();
        },
        async verify() {
          return o.copier?.verify ?? { ok: true, tables: [{ table: "events", sourceRows: 3, targetRows: 3, ok: true }] };
        },
      };
    },
    async removeFile(p) {
      removed.push(p);
    },
  };
  const deps: DatabaseSwitcherDeps = {
    db,
    logger: silentLogger,
    initial: o.initial ?? { driver: "sqlite", sqlitePath: SQLITE_PATH },
    envPinned: o.envPinned ?? false,
    defaultPostgresUrl: PG_URL,
    readState: () => state,
    writeState: async (s) => {
      if (o.writeStateError) throw o.writeStateError;
      state = s;
    },
    instances: async () => o.instances ?? [{ id: "me", seenAt: 0, self: true }],
    audit: async (e) => {
      audits.push(e);
    },
    onSwitched: (t) => switched.push(t),
    pauseBudgetMs: o.pauseBudgetMs,
    ops,
  };
  const sw = createDatabaseSwitcher(deps);
  return { sw, db, oldDb, audits, opened, wiped, removed, schemaFor, switched, getState: () => state, lastProgress: () => lastProgress };
}

const PG_TARGET: DatabaseTarget = { driver: "postgres", postgresUrl: PG_URL };

describe("database switcher", () => {
  test("happy path: copies, swaps, persists, freezes the old db and resumes writes", async () => {
    const s = await setup();
    const started = await s.sw.start({ target: PG_TARGET }, "owner-pk");
    expect(started.to.postgresUrl).toBe("postgres://beam:***@db.internal:5432/beamhop");
    expect(JSON.stringify(started)).not.toContain("s3cret-pw");
    await s.sw.whenIdle();
    const job = s.sw.job(started.id)!;
    expect(job.phase).toBe("done");
    expect(job.error).toBeUndefined();
    expect(job.cancellable).toBe(false);
    expect(job.pausedMs).toBeGreaterThanOrEqual(0);
    expect(job.tables[0]).toMatchObject({ table: "events", copied: 3, done: true });
    expect(s.db.paused).toBe(false);
    expect(s.db.beforeFinalCopyCalls).toBe(1);
    expect(s.db.current).toBe(s.opened[0]);
    expect(s.schemaFor[0][0].namespace).toBe("core");
    const state = s.getState()!;
    expect(state.current).toEqual(PG_TARGET);
    expect(state.rollbacks).toHaveLength(1);
    expect(state.rollbacks[0]).toMatchObject({ target: { driver: "sqlite", sqlitePath: SQLITE_PATH }, replacedBy: "postgres" });
    // freeze marker written into the old db, which is then closed
    expect(s.switched).toEqual([PG_TARGET]);
    expect(s.audits.map((a) => a.action)).toEqual(["db.switch.start", "db.switch.done"]);
    expect(JSON.stringify(s.audits)).not.toContain("s3cret-pw");
    const st = await s.sw.status();
    expect(st.current).toEqual({ driver: "postgres", postgresUrl: "postgres://beam:***@db.internal:5432/beamhop" });
    expect(st.rollbacks[0].target.sqlitePath).toBe(SQLITE_PATH);
    expect(JSON.stringify(st)).not.toContain("s3cret-pw");
  });

  test("the freeze marker lands in the old database", async () => {
    const s = await setup();
    let marker: unknown;
    const run = s.oldDb.run.bind(s.oldDb);
    s.oldDb.run = async (sql, params) => {
      const r = await run(sql, params);
      marker = await s.oldDb.get<{ value: string }>("SELECT value FROM kv WHERE namespace = 'server' AND key = 'frozenAt'");
      return r;
    };
    const j = await s.sw.start({ target: PG_TARGET }, "owner");
    await s.sw.whenIdle();
    expect(s.sw.job(j.id)!.phase).toBe("done");
    expect(JSON.parse((marker as { value: string }).value)).toMatchObject({ replacedBy: "postgres" });
  });

  test("a non-empty target needs the wipe confirmation, then is wiped", async () => {
    const s = await setup({ targetTables: [{ name: "events", rows: 10 }] });
    await expect(s.sw.start({ target: PG_TARGET }, "owner")).rejects.toMatchObject({ code: "db_target_not_empty" });
    expect(s.opened[0].closed).toBe(true);
    expect(s.audits).toHaveLength(0);
    await expect(s.sw.start({ target: PG_TARGET, wipeConfirm: "yes" }, "owner")).rejects.toMatchObject({ code: "db_target_not_empty" });
    const j = await s.sw.start({ target: PG_TARGET, wipeConfirm: WIPE_CONFIRM_PHRASE }, "owner");
    await s.sw.whenIdle();
    expect(s.sw.job(j.id)!.phase).toBe("done");
    expect(s.wiped).toContain(s.opened[2]);
  });

  test("env pinned: refused, and status says why", async () => {
    const s = await setup({ envPinned: true });
    await expect(s.sw.start({ target: PG_TARGET }, "owner")).rejects.toMatchObject({ code: "db_switch_refused" });
    expect(s.opened).toHaveLength(0);
    expect((await s.sw.status()).blockedReason).toContain("environment variables");
  });

  test("another live instance: refused", async () => {
    const s = await setup({ instances: [{ id: "me", seenAt: 1, self: true }, { id: "other", seenAt: 1, self: false, host: "box2" }] });
    await expect(s.sw.start({ target: PG_TARGET }, "owner")).rejects.toThrow(/other instance/);
    expect((await s.sw.status()).blockedReason).toContain("1 other instance");
  });

  test("the current database and rollback files are refused as targets", async () => {
    const s = await setup({
      state: {
        version: 1,
        current: { driver: "sqlite", sqlitePath: SQLITE_PATH },
        rollbacks: [{ id: "r1", target: { driver: "sqlite", sqlitePath: "/var/lib/beamhop/old.db" }, frozenAt: 1, replacedBy: "postgres" }],
      },
    });
    await expect(s.sw.start({ target: { driver: "sqlite", sqlitePath: SQLITE_PATH } }, "owner")).rejects.toThrow(/already uses/);
    await expect(s.sw.start({ target: { driver: "sqlite", sqlitePath: `${SQLITE_PATH}-wal` } }, "owner")).rejects.toThrow(/already uses/);
    await expect(s.sw.start({ target: { driver: "sqlite", sqlitePath: "/var/lib/beamhop/old.db" } }, "owner")).rejects.toThrow(/rollback point/);
    await expect(s.sw.start({ target: { driver: "sqlite", sqlitePath: "relative.db" } }, "owner")).rejects.toMatchObject({ code: "db_target_invalid" });
    const t = await s.sw.test({ driver: "sqlite", sqlitePath: SQLITE_PATH });
    expect(t).toMatchObject({ ok: false, sameAsCurrent: true });
  });

  test("an unreachable target is refused", async () => {
    const s = await setup({ openError: new Error(`connect ECONNREFUSED for ${PG_URL}`) });
    const err = await s.sw.start({ target: PG_TARGET }, "owner").catch((e: Error) => e);
    expect((err as Error).message).toContain("cannot open the target database");
    expect((err as Error).message).not.toContain("s3cret-pw");
    const t = await s.sw.test(PG_TARGET);
    expect(t.reachable).toBe(false);
    expect(t.errors.join()).not.toContain("s3cret-pw");
  });

  test("postgresUrl \"env\" and the redacted prefill both mean the configured URL", async () => {
    const s = await setup();
    const t = await s.sw.test({ driver: "postgres", postgresUrl: "env" });
    expect(t).toMatchObject({ ok: true, reachable: true, empty: true, serverVersion: "PostgreSQL 17" });
    expect(s.opened[0].name).toBe(PG_URL);
    await s.sw.test({ driver: "postgres", postgresUrl: redactPostgresUrl(PG_URL) });
    expect(s.opened[1].name).toBe(PG_URL);
    expect(s.opened.every((d) => d.closed)).toBe(true);
  });

  test("cancel during the bulk copy: nothing paused, target cleaned up and closed", async () => {
    const s = await setup({
      copier: {
        bulk: (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    });
    const j = await s.sw.start({ target: PG_TARGET }, "owner");
    while (s.sw.job(j.id)!.phase !== "bulk_copy") await Bun.sleep(1);
    expect(s.sw.job(j.id)!.cancellable).toBe(true);
    expect(s.sw.cancel(j.id)).toBe(true);
    await s.sw.whenIdle();
    const v = s.sw.job(j.id)!;
    expect(v.phase).toBe("cancelled");
    expect(s.sw.cancel(j.id)).toBe(false);
    expect(s.db.pauseCalls).toBe(0);
    expect(s.db.current).toBe(s.oldDb);
    expect(s.opened[0].closed).toBe(true);
    expect(s.wiped).toContain(s.opened[0]);
    expect(s.getState()).toBeUndefined();
    expect(s.audits.map((a) => a.action)).toEqual(["db.switch.start", "db.switch.failed"]);
  });

  test("an over-budget pause gives up: writes resumed, old database kept", async () => {
    const s = await setup({ pauseBudgetMs: 30, copier: { final: () => Bun.sleep(300) } });
    const j = await s.sw.start({ target: PG_TARGET }, "owner");
    await s.sw.whenIdle();
    const v = s.sw.job(j.id)!;
    expect(v.phase).toBe("failed");
    expect(v.error).toBe(TOO_MANY_CHANGES);
    expect(v.pausedMs).toBeLessThan(250);
    expect(s.db.paused).toBe(false);
    expect(s.db.resumeCalls).toBe(1);
    expect(s.db.current).toBe(s.oldDb);
    expect(s.opened[0].closed).toBe(true);
    expect(s.getState()).toBeUndefined();
    expect(s.switched).toHaveLength(0);
  });

  test("a verify failure keeps the old database", async () => {
    const s = await setup({ copier: { verify: { ok: false, tables: [{ table: "users", sourceRows: 5, targetRows: 4, ok: false }] } } });
    const j = await s.sw.start({ target: PG_TARGET }, "owner");
    await s.sw.whenIdle();
    const v = s.sw.job(j.id)!;
    expect(v.phase).toBe("failed");
    expect(v.error).toContain("verification failed: users (5 source rows, 4 copied)");
    expect(s.db.paused).toBe(false);
    expect(s.db.current).toBe(s.oldDb);
    expect(s.audits.at(-1)!.action).toBe("db.switch.failed");
  });

  test("a failing swap hook: writes resumed, still on the old database", async () => {
    const s = await setup();
    s.db.swapError = new Error("rebind hook events failed");
    const j = await s.sw.start({ target: PG_TARGET }, "owner");
    await s.sw.whenIdle();
    const v = s.sw.job(j.id)!;
    expect(v.phase).toBe("failed");
    expect(v.error).toContain("rebind hook events failed");
    expect(s.db.paused).toBe(false);
    expect(s.db.current).toBe(s.oldDb);
    expect(s.opened[0].closed).toBe(true);
    expect(s.getState()).toBeUndefined();
  });

  test("a persist failure after the swap: done with a warning, running on the new database", async () => {
    const s = await setup({ writeStateError: new Error("EACCES: permission denied") });
    const j = await s.sw.start({ target: PG_TARGET }, "owner");
    await s.sw.whenIdle();
    const v = s.sw.job(j.id)!;
    expect(v.phase).toBe("done");
    expect(v.error).toContain("done with warning");
    expect(v.error).toContain("EACCES");
    expect(s.db.paused).toBe(false);
    expect(s.db.current).toBe(s.opened[0]);
    expect(s.switched).toEqual([PG_TARGET]);
  });

  test("one job at a time", async () => {
    let release!: () => void;
    const s = await setup({ copier: { bulk: () => new Promise<void>((r) => (release = r)) } });
    const j = await s.sw.start({ target: PG_TARGET }, "owner");
    await expect(s.sw.start({ target: { driver: "postgres", postgresUrl: "postgres://x:y@other/db" } }, "owner")).rejects.toMatchObject({ code: "db_switch_busy" });
    expect((await s.sw.status()).blockedReason).toContain("already running");
    while (!release) await Bun.sleep(1);
    release();
    await s.sw.whenIdle();
    expect(s.sw.job(j.id)!.phase).toBe("done");
  });

  test("deleteRollback: sqlite files and siblings, postgres wipe, confirmation, current refused", async () => {
    const s = await setup({
      initial: PG_TARGET,
      state: {
        version: 1,
        current: PG_TARGET,
        rollbacks: [
          { id: "lite", target: { driver: "sqlite", sqlitePath: SQLITE_PATH }, frozenAt: 1, replacedBy: "postgres" },
          { id: "pg", target: { driver: "postgres", postgresUrl: "postgres://u:oldpw@old-host/beamhop" }, frozenAt: 2, replacedBy: "sqlite" },
          { id: "cur", target: { driver: "postgres", postgresUrl: "postgres://other:pw@db.internal:5432/beamhop" }, frozenAt: 3, replacedBy: "postgres" },
        ],
      },
    });
    await expect(s.sw.deleteRollback("lite", "nope", "owner")).rejects.toMatchObject({ code: "db_confirm_mismatch" });
    await expect(s.sw.deleteRollback("missing", DELETE_ROLLBACK_CONFIRM_PHRASE, "owner")).rejects.toMatchObject({ code: "db_rollback_not_found" });
    await expect(s.sw.deleteRollback("cur", DELETE_ROLLBACK_CONFIRM_PHRASE, "owner")).rejects.toThrow(/uses now/);
    await s.sw.deleteRollback("lite", DELETE_ROLLBACK_CONFIRM_PHRASE, "owner");
    expect(s.removed).toEqual([SQLITE_PATH, `${SQLITE_PATH}-wal`, `${SQLITE_PATH}-shm`, `${SQLITE_PATH}-journal`]);
    await s.sw.deleteRollback("pg", DELETE_ROLLBACK_CONFIRM_PHRASE, "owner");
    expect(s.wiped).toContain(s.opened[0]);
    expect(s.opened[0].closed).toBe(true);
    expect(s.getState()!.rollbacks.map((r) => r.id)).toEqual(["cur"]);
    expect(s.audits.map((a) => a.action)).toEqual(["db.rollback.delete", "db.rollback.delete"]);
    expect(JSON.stringify(s.audits)).not.toContain("oldpw");
    const st = await s.sw.status();
    expect(JSON.stringify(st)).not.toContain(":pw@");
  });

  test("testing a sqlite path that doesn't exist yet doesn't create it", async () => {
    const s = await setup();
    const dir = mkdtempSync(join(tmpdir(), "bh-switch-"));
    const path = join(dir, "new.db");
    expect(await s.sw.test({ driver: "sqlite", sqlitePath: path })).toMatchObject({ ok: true, reachable: true, empty: true });
    expect(existsSync(path)).toBe(false);
    expect(s.opened).toHaveLength(0);
    expect(await s.sw.test({ driver: "sqlite", sqlitePath: join(dir, "missing-dir", "x.db") })).toMatchObject({ ok: false, reachable: false });
    writeFileSync(path, "");
    expect((await s.sw.test({ driver: "sqlite", sqlitePath: path })).reachable).toBe(true);
    expect(s.opened).toHaveLength(1);
  });
});

describe("redaction and identity", () => {
  test.each([
    ["postgres://u:pw@h/db", "postgres://u:***@h/db"],
    ["postgresql://u:p%40ss@h:6543/db?sslmode=require", "postgresql://u:***@h:6543/db?sslmode=require"],
    ["postgres://u:p@ss@h/db", "postgres://u:***@h/db"],
    ["postgres://h/db?user=u&password=pw", "postgres://h/db?user=u&password=***"],
    ["postgres://u@h/db", "postgres://u@h/db"],
  ])("%s", (url, want) => {
    expect(redactPostgresUrl(url)).toBe(want);
  });

  test("sameDatabase ignores credentials and the default port", () => {
    expect(sameDatabase({ driver: "postgres", postgresUrl: "postgres://a:1@H/db" }, { driver: "postgres", postgresUrl: "postgresql://b:2@h:5432/db" })).toBe(true);
    expect(sameDatabase({ driver: "postgres", postgresUrl: "postgres://a:1@h/db" }, { driver: "postgres", postgresUrl: "postgres://a:1@h/db2" })).toBe(false);
    expect(sameDatabase({ driver: "sqlite", sqlitePath: "/a/b.db" }, { driver: "sqlite", sqlitePath: "/a/./b.db" })).toBe(true);
    expect(sameDatabase({ driver: "sqlite", sqlitePath: "/a/b.db" }, { driver: "postgres", postgresUrl: "postgres://h/b" })).toBe(false);
  });
});
