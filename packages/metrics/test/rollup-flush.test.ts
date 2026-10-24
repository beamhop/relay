import { describe, expect, test } from "bun:test";
import type { Db } from "@beamhop/sdk";
import { Rollup } from "../src/rollup";

/** A Db whose writes fail with the given error code (or succeed once `code` is null), recording SQL params. */
function failingDb(state: { code: string | null; runs: unknown[][] }): Db {
  const db: Db = {
    dialect: "postgres",
    all: async () => [],
    get: async () => undefined,
    run: async (_sql: string, params?: unknown[]) => {
      if (state.code) throw Object.assign(new Error(`db error ${state.code}`), { code: state.code });
      state.runs.push(params ?? []);
      return { changes: 0 };
    },
    exec: async () => {},
    tx: (fn) => fn(db),
    migrate: async () => {},
    close: async () => {},
  };
  return db;
}

const T = 1_700_000_000;

describe("rollup flush failures", () => {
  test("a batch rejected for its content is dropped instead of re-queued forever", async () => {
    const state = { code: "22P05" as string | null, runs: [] as unknown[][] };
    const r = new Rollup(failingDb(state), T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10 });
    r.current.add("events_in", 1);
    r.closeCurrent(T);
    await expect(r.flush()).rejects.toThrow(/metrics batch dropped/);
    state.code = null;
    await r.flush();
    expect(state.runs.length).toBe(0); // nothing left to write
  });

  test("a batch dropped by a read-path flush is reported, not swallowed", async () => {
    const state = { code: "22P05" as string | null, runs: [] as unknown[][] };
    const dropped: string[] = [];
    const r = new Rollup(failingDb(state), T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10, onDropped: (m) => dropped.push(m) });
    r.current.add("events_in", 1);
    r.closeCurrent(T);
    await r.kinds({ from: T - 3600, to: T + 60 });
    expect(dropped.length).toBe(1);
    expect(dropped[0]).toMatch(/metrics batch dropped/);
  });

  test("a transient failure keeps the batch for the next attempt", async () => {
    const state = { code: "ECONNREFUSED" as string | null, runs: [] as unknown[][] };
    const r = new Rollup(failingDb(state), T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10 });
    r.current.add("events_in", 2);
    r.closeCurrent(T);
    await expect(r.flush()).rejects.toThrow(/ECONNREFUSED/);
    state.code = null;
    await r.flush();
    expect(state.runs.flat()).toContain("events_in");
  });

  test("a generic SQLITE_ERROR is retried, a constraint error drops the batch", async () => {
    const state = { code: "SQLITE_ERROR" as string | null, runs: [] as unknown[][] };
    const r = new Rollup(failingDb(state), T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10 });
    r.current.add("events_in", 3);
    r.closeCurrent(T);
    await expect(r.flush()).rejects.toThrow(/SQLITE_ERROR/);
    state.code = "SQLITE_CONSTRAINT_PRIMARYKEY";
    await expect(r.flush()).rejects.toThrow(/metrics batch dropped/);
    state.code = null;
    await r.flush();
    expect(state.runs.length).toBe(0);
  });

  test("upsert rows are written in key order", async () => {
    const state = { code: null as string | null, runs: [] as unknown[][] };
    const r = new Rollup(failingDb(state), T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10 });
    for (const n of ["zeta", "alpha", "mid"]) r.current.add(n, 1);
    r.closeCurrent(T);
    await r.flush();
    const names = state.runs[0]!.filter((v) => typeof v === "string");
    expect(names).toEqual(["alpha", "mid", "zeta"]);
  });

  test("dashboard reads during a short outage don't spend the retry budget", async () => {
    const state = { code: "SQLITE_BUSY" as string | null, runs: [] as unknown[][] };
    const r = new Rollup(failingDb(state), T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10 });
    r.current.add("events_in", 5);
    r.closeCurrent(T);
    const range = { from: T - 3600, to: T + 60 };
    // three refreshes of four widgets while the database is busy: readers neither throw nor drop the batch
    for (let i = 0; i < 3; i++) await Promise.all([r.kinds(range), r.topPubkeys(range), r.rejections(range), r.geo(range)]);
    state.code = null;
    await r.flush();
    expect(state.runs.flat()).toContain("events_in");
  });
});
