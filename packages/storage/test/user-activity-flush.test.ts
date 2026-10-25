import { describe, expect, test } from "bun:test";
import type { Db } from "@beamhop/sdk";
import { createTestStores, silentLogger, SqlUserStore } from "../src";

const pk = (i: number) => i.toString(16).padStart(64, "0");

/** The stores' database, with transactions failing while `down` (a database outage). */
async function outage() {
  const stores = await createTestStores();
  const state = { down: true, txCalls: 0 };
  const db = new Proxy(stores.db, {
    get(target, prop, receiver) {
      if (prop === "tx")
        return (fn: (d: Db) => Promise<unknown>) => {
          state.txCalls++;
          return state.down ? Promise.reject(new Error("database is locked")) : target.tx(fn);
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { stores, db, state };
}

describe("user activity flushes during a database outage", () => {
  test("one flush at a time, backoff after a failure, buffer capped; data written once the database is back", async () => {
    const { stores, db, state } = await outage();
    const users = new SqlUserStore(db, silentLogger, { flushIntervalMs: 3_600_000, maxBuffered: 10, maxPending: 50 });
    for (let i = 0; i < 200; i++) await users.touch(pk(i), 100 + i);
    await new Promise((r) => setTimeout(r, 5));
    // the buffer-size trigger fired once; every later one hit the in-flight flush or the backoff
    expect(state.txCalls).toBe(1);
    expect(await users.get(pk(49))).toMatchObject({ eventCount: 1 });
    expect(await users.get(pk(50))).toBeUndefined(); // dropped: over maxPending
    await users.touch(pk(3), 500); // known pubkeys keep counting
    expect(await users.get(pk(3))).toMatchObject({ eventCount: 2, lastSeenAt: 500 });

    state.down = false;
    await users.flush(); // explicit flushes don't wait out the backoff
    expect(state.txCalls).toBe(2);
    const row = await stores.db.get<{ n: number; total: number }>("SELECT COUNT(*) AS n, SUM(event_count) AS total FROM users");
    expect({ n: Number(row?.n), total: Number(row?.total) }).toEqual({ n: 50, total: 51 });
    await users.close();
    await stores.close();
  });

  test("concurrent flush() calls share the in-flight flush and one queued behind it", async () => {
    const { stores, db, state } = await outage();
    state.down = false;
    const users = new SqlUserStore(db, silentLogger, { flushIntervalMs: 3_600_000 });
    await users.touch(pk(1), 1);
    const first = users.flush();
    await users.touch(pk(2), 2);
    const queued = [users.flush(), users.flush(), users.flush()];
    expect(queued[1]).toBe(queued[0]);
    await Promise.all([first, ...queued]);
    expect(state.txCalls).toBe(2);
    expect((await users.get(pk(2)))?.eventCount).toBe(1);
    await users.close();
    await stores.close();
  });
});
