import { describe, expect, test } from "bun:test";
import type { Logger } from "@beamhop/sdk";
import { createMemoryDb, DbClosedError, TxAbortedError } from "../src/db";

const race = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

const recordingLogger = () => {
  const lines: { level: string; msg: string }[] = [];
  const log = (level: string) => (msg: string) => void lines.push({ level, msg });
  const logger: Logger = { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error"), child: () => logger };
  return { logger, lines };
};

describe("sqlite transaction watchdog", () => {
  test("a transaction awaiting a promise that never settles is rolled back and unrelated work resumes", async () => {
    const { logger, lines } = recordingLogger();
    const db = await createMemoryDb({ txWarnMs: 20, txTimeoutMs: 80, logger });
    await db.exec("CREATE TABLE t (x INTEGER)");
    const hung = db.tx(async (d) => {
      await d.run("INSERT INTO t VALUES (1)");
      await new Promise(() => {});
    });
    const outcome = hung.then(() => "ok", (e) => e);
    await new Promise((r) => setTimeout(r, 5));
    // an unrelated read waits for the transaction, but only until the watchdog fires
    expect(await race(db.get<{ one: number }>("SELECT 1 AS one"), 1000)).toEqual({ one: 1 });
    expect(await outcome).toBeInstanceOf(TxAbortedError);
    // the insert was rolled back
    expect(await db.all("SELECT x FROM t")).toEqual([]);
    expect(lines.some((l) => l.level === "warn" && l.msg.includes("still open"))).toBe(true);
    expect(lines.some((l) => l.level === "error" && l.msg.includes("rolled back"))).toBe(true);
    // the next transaction works normally
    await db.tx(async (d) => void (await d.run("INSERT INTO t VALUES (2)")));
    expect(await db.all("SELECT x FROM t")).toEqual([{ x: 2 }]);
  });

  test("statements issued later by the abandoned transaction reject instead of running outside of it", async () => {
    const db = await createMemoryDb({ txTimeoutMs: 40 });
    await db.exec("CREATE TABLE t (x INTEGER)");
    let resume!: () => void;
    const late: Promise<unknown>[] = [];
    const tx = db.tx(async (d) => {
      await d.run("INSERT INTO t VALUES (1)");
      await new Promise<void>((r) => (resume = r));
      // settled handlers attached right away: the calls reject synchronously
      late.push(...[d.run("INSERT INTO t VALUES (99)"), d.tx(async (n) => n.run("INSERT INTO t VALUES (98)"))].map((p) => p.then(() => "ran", (e) => e)));
    });
    await expect(tx).rejects.toBeInstanceOf(TxAbortedError);
    resume();
    await new Promise((r) => setTimeout(r, 5));
    for (const p of late) expect(await p).toBeInstanceOf(TxAbortedError);
    expect(await db.all("SELECT x FROM t")).toEqual([]);
  });

  test("a failing ROLLBACK does not replace the transaction's own error", async () => {
    const db = await createMemoryDb();
    const err = await db
      .tx(async (d) => {
        await d.exec("ROLLBACK");
        throw new Error("ORIGINAL");
      })
      .catch((e) => String(e));
    expect(err).toContain("ORIGINAL");
    // the connection is still usable
    expect(await db.tx(async (d) => d.get<{ v: number }>("SELECT 2 AS v"))).toEqual({ v: 2 });
  });

  test("a long transaction lets pending timers run before the next queued transaction starts", async () => {
    const db = await createMemoryDb({ longTxMs: 5 });
    const order: string[] = [];
    setTimeout(() => order.push("timer"), 0);
    const busy = (ms: number) => {
      const s = performance.now();
      while (performance.now() - s < ms);
    };
    const a = db.tx(async (d) => {
      await d.get("SELECT 1");
      busy(15);
      order.push("tx1");
    });
    const b = db.tx(async () => void order.push("tx2"));
    await Promise.all([a, b]);
    expect(order).toEqual(["tx1", "timer", "tx2"]);
  });
});

describe("sqlite migrations", () => {
  test("a migration another process applied after the pending list was read is not applied twice", async () => {
    const db = await createMemoryDb();
    const mig = [{ id: "001", up: "CREATE TABLE once_only (x INTEGER)" }];
    await db.migrate("ns", mig);
    // simulate the stale read: the pending list is computed from a `_migrations` snapshot taken before
    // the other process committed
    const all = db.all.bind(db);
    db.all = (async (sql: string, params?: unknown[]) =>
      sql.startsWith("SELECT id FROM _migrations") ? [] : all(sql, params)) as typeof db.all;
    await db.migrate("ns", mig);
    db.all = all;
    expect(await db.all("SELECT id FROM _migrations WHERE namespace = 'ns'")).toEqual([{ id: "001" }]);
  });
});

describe("sqlite close", () => {
  test("waits for the open transaction and queued work, then refuses new work with DbClosedError", async () => {
    const db = await createMemoryDb();
    await db.exec("CREATE TABLE t (x INTEGER)");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inTx = db.tx(async (d) => {
      await d.run("INSERT INTO t VALUES (1)");
      await gate;
      await d.run("INSERT INTO t VALUES (2)");
    });
    await new Promise((r) => setTimeout(r, 5));
    const queued = db.run("INSERT INTO t VALUES (3)");
    const closing = db.close();
    // new work after close() started is refused at once, queued work and the open transaction still finish
    await expect(db.get("SELECT 1")).rejects.toBeInstanceOf(DbClosedError);
    release();
    await inTx;
    await queued;
    await closing;
    await expect(db.all("SELECT x FROM t")).rejects.toBeInstanceOf(DbClosedError);
    await expect(db.tx(async () => {})).rejects.toBeInstanceOf(DbClosedError);
  });

  test("a transaction that never settles doesn't hold close() past closeWaitMs", async () => {
    const { logger, lines } = recordingLogger();
    const db = await createMemoryDb({ closeWaitMs: 30, logger });
    await db.exec("CREATE TABLE t (x INTEGER)");
    const hung = db.tx(async (d) => {
      await d.run("INSERT INTO t VALUES (1)");
      await new Promise(() => {});
    });
    void hung.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(await race(db.close(), 1000)).toBeUndefined();
    expect(lines.some((l) => l.level === "warn" && l.msg.includes("still queued"))).toBe(true);
  });
});
