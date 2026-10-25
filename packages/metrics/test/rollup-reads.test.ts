import { describe, expect, test } from "bun:test";
import type { Db } from "@beamhop/sdk";
import { LONG_RANGE_CACHE_MS, Rollup } from "../src/rollup";

/** Records reads and transactions; reads return no rows. */
function countingDb() {
  const calls = { all: 0, tx: 0 };
  const db: Db = {
    dialect: "sqlite",
    all: async () => (calls.all++, []),
    get: async () => undefined,
    run: async () => ({ changes: 0 }),
    exec: async () => {},
    tx: (fn) => (calls.tx++, fn(db)),
    migrate: async () => {},
    close: async () => {},
  };
  return { db, calls };
}

const T = 1_700_000_000;
const DAY = 86_400;

describe("rollup dashboard reads", () => {
  test("no write transaction for a read when nothing is pending", async () => {
    const { db, calls } = countingDb();
    const r = new Rollup(db, T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10 });
    const range = { from: T - 3600, to: T };
    await Promise.all([r.kinds(range), r.topPubkeys(range), r.rejections(range), r.geo(range)]);
    expect(calls.tx).toBe(0);
    r.hour.kind(1);
    await r.kinds(range);
    expect(calls.tx).toBe(1);
  });

  test("breakdowns over more than a day are cached per range and limit; shorter ranges are not", async () => {
    const { db, calls } = countingDb();
    let now = T * 1000;
    const r = new Rollup(db, T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10, now: () => now });
    const week = { from: T - 7 * DAY, to: T };
    await Promise.all([r.topPubkeys(week, 10), r.rejections(week), r.geo(week)]);
    expect(calls.all).toBe(3);
    // the same hours (the range end moved within the hour) and limit: cached
    await Promise.all([r.topPubkeys({ ...week, to: T + 60 }, 10), r.rejections(week), r.geo(week)]);
    expect(calls.all).toBe(3);
    await r.topPubkeys(week, 20);
    expect(calls.all).toBe(4);
    now += LONG_RANGE_CACHE_MS;
    await r.topPubkeys(week, 10);
    expect(calls.all).toBe(5);
    const day = { from: T - DAY, to: T };
    await r.topPubkeys(day, 10);
    await r.topPubkeys(day, 10);
    expect(calls.all).toBe(7);
  });
});
