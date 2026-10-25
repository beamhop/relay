import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db, NostrEvent, SaveResult } from "@beamhop/sdk";
import { createTestStores, type StorageStores } from "../src";
import { SAVE_BATCH_MAX } from "../src/events";
import { signer } from "./helpers";

const T = 1_700_000_000;

const race = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

let stores: StorageStores;
let raw: Db;
/** transactions started on the raw database */
let txs: number;
beforeEach(async () => {
  stores = await createTestStores();
  raw = (stores.events as unknown as { db: Db }).db;
  txs = 0;
  const tx = raw.tx.bind(raw);
  raw.tx = (fn) => {
    txs++;
    return tx(fn);
  };
});
afterEach(async () => {
  await stores.close();
});

describe("sqlite group commit", () => {
  test("concurrent saves share transactions; each is stored", async () => {
    const a = signer();
    const evs = Array.from({ length: 50 }, (_, i) => a.sign({ kind: 1, created_at: T + i, content: `n${i}` }));
    const res = await Promise.all(evs.map((e) => stores.events.save(e)));
    expect(res.every((r) => r.status === "saved")).toBe(true);
    // the first commits alone, the other 49 wait for it and commit together
    expect(txs).toBe(2);
    expect(await stores.events.count([{ authors: [a.pubkey] }])).toBe(50);
  });

  test("a batch holds at most SAVE_BATCH_MAX saves", async () => {
    const a = signer();
    const n = 1 + SAVE_BATCH_MAX * 2 + 1;
    const evs = Array.from({ length: n }, (_, i) => a.sign({ kind: 1, created_at: T + i }));
    await Promise.all(evs.map((e) => stores.events.save(e)));
    expect(txs).toBe(4);
    expect(await stores.events.count([{ authors: [a.pubkey] }])).toBe(n);
  });

  test("a save arriving while nothing runs commits right away, alone", async () => {
    const a = signer();
    for (let i = 0; i < 3; i++) expect((await stores.events.save(a.sign({ kind: 1, created_at: T + i }))).status).toBe("saved");
    expect(txs).toBe(3);
  });

  test("saves in one batch see each other: duplicates and replaceable versions", async () => {
    const a = signer();
    const e = a.sign({ kind: 1, created_at: T });
    const older = a.sign({ kind: 0, created_at: T, content: "old" });
    const newer = a.sign({ kind: 0, created_at: T + 1, content: "new" });
    const [first, ...rest] = await Promise.all([stores.events.save(a.sign({ kind: 1, created_at: T - 1 })), stores.events.save(e), stores.events.save(e), stores.events.save(older), stores.events.save(newer)]);
    expect(first.status).toBe("saved");
    expect(rest.map((r) => r.status)).toEqual(["saved", "duplicate", "saved", "replaced"]);
    expect((await stores.events.query([{ kinds: [0], authors: [a.pubkey] }])).map((x) => x.content)).toEqual(["new"]);
  });

  test("a failing save is rolled back and rejects alone", async () => {
    const a = signer();
    const evs = Array.from({ length: 6 }, (_, i) => a.sign({ kind: 1, created_at: T + i, tags: [["t", "x"]] }));
    const bad = evs[3];
    const store = stores.events as unknown as { saveIn: (tx: Db, e: NostrEvent) => Promise<SaveResult> };
    const saveIn = store.saveIn.bind(store);
    store.saveIn = async (tx, e) => {
      const r = await saveIn(tx, e);
      if (e.id === bad.id) throw new Error("boom");
      return r;
    };
    const res = await Promise.allSettled(evs.map((e) => stores.events.save(e)));
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect(String((res[3] as PromiseRejectedResult).reason)).toContain("boom");
    // its row and tag rows were rolled back to the savepoint; the others in the batch are stored
    expect(await stores.events.getById(bad.id)).toBeUndefined();
    expect(await stores.events.count([{ "#t": ["x"] }])).toBe(5);
  });

  test("a transaction failing as a whole rejects every save in it", async () => {
    const a = signer();
    const evs = Array.from({ length: 4 }, (_, i) => a.sign({ kind: 1, created_at: T + i }));
    const first = stores.events.save(evs[0]);
    const tx = raw.tx;
    raw.tx = () => Promise.reject(new Error("disk full"));
    const rest = Promise.allSettled(evs.slice(1).map((e) => stores.events.save(e)));
    // the first was handed to the real tx() before the swap, the others' batch after it
    expect((await first).status).toBe("saved");
    expect((await rest).map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    raw.tx = tx;
    // the queue keeps working afterwards
    expect((await stores.events.save(evs[1])).status).toBe("saved");
  });

  test("a save from inside a transaction joins it while a batch waits behind it (no deadlock)", async () => {
    const a = signer();
    const inside = a.sign({ kind: 1, created_at: T });
    const outside = a.sign({ kind: 1, created_at: T + 1 });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const outer = raw.tx(async () => {
      await held;
      return stores.events.save(inside);
    });
    // queued while the outer transaction is open: its batch transaction waits for the outer one
    const queued = stores.events.save(outside);
    release();
    expect(await race(outer, 2000)).toEqual({ status: "saved" });
    expect(await race(queued, 2000)).toEqual({ status: "saved" });
  });
});
