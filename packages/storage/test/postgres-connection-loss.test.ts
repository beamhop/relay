import { expect, test } from "bun:test";
import { createDb, isConnectionLoss } from "../src";

// Runs against a real database only when BEAMHOP_TEST_PG=postgres://... is set. Terminates only its own backend.
const url = process.env.BEAMHOP_TEST_PG;

test("isConnectionLoss: driver connection errors and server-side terminations, not query errors", () => {
  for (const code of ["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "CONNECT_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "08006", "57P01", "57P02", "57P03"]) {
    expect(isConnectionLoss(Object.assign(new Error("x"), { code }))).toBe(true);
  }
  for (const err of [new Error("x"), Object.assign(new Error("x"), { code: "23505" }), Object.assign(new Error("x"), { code: "57014" }), null, "CONNECTION_CLOSED"]) {
    expect(isConnectionLoss(err)).toBe(false);
  }
});

test.skipIf(!url)("postgres: a transaction whose connection dies sends nothing more and doesn't crash the process", async () => {
  const db = await createDb({ database: { driver: "postgres", sqlitePath: "", postgresUrl: url } });
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS _tx_loss_probe (v TEXT); DELETE FROM _tx_loss_probe");
    let after = false;
    const tx = db.tx(async (t) => {
      const { pid } = (await t.get<{ pid: number }>("SELECT pg_backend_pid() AS pid"))!;
      // the server ends this session (as on a restart or failover) while the transaction is open and idle
      await db.run("SELECT pg_terminate_backend(?)", [pid]);
      await Bun.sleep(300);
      after = true;
      // postgres.js used to send this to the dead connection object: a TypeError thrown from a setImmediate
      await t.run("INSERT INTO _tx_loss_probe (v) VALUES ('stale')");
      return "committed";
    });
    await expect(tx).rejects.toThrow();
    await Bun.sleep(500);
    expect(after).toBe(true);
    expect(uncaught).toEqual([]);
    // the statement went nowhere (not to a reconnected session either) and the pool still works
    expect(await db.all("SELECT v FROM _tx_loss_probe")).toEqual([]);
    expect(await db.tx(async (t) => (await t.get<{ x: number }>("SELECT 1 AS x"))?.x)).toBe(1);
  } finally {
    process.off("uncaughtException", onUncaught);
    await db.exec("DROP TABLE IF EXISTS _tx_loss_probe").catch(() => {});
    await db.close();
  }
});
