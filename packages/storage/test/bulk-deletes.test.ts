import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { createTestStores, type StorageStores } from "../src";
import { DELETE_BATCH } from "../src/events";

const T = 1_700_000_000;
let n = 0;
const fakeEvent = (pubkey: string, created_at: number, extra: Partial<NostrEvent> = {}): NostrEvent => ({
  id: (n++).toString(16).padStart(64, "0"),
  pubkey,
  created_at,
  kind: 1,
  tags: [["t", "x"]],
  content: "",
  sig: "0".repeat(128),
  ...extra,
});
const A = "a".repeat(64);
const B = "b".repeat(64);

let stores: StorageStores;
beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

const count = async (sql: string) => Number((await stores.db.get<{ n: number }>(sql))?.n);

/** Runs `fn` and reports whether a timer scheduled just before it fired while it was still running. */
async function timerFiresDuring(fn: () => Promise<unknown>) {
  let finished = false;
  let firedWhileRunning = false;
  setTimeout(() => void (firedWhileRunning = !finished), 0);
  const result = await fn();
  finished = true;
  return { result, firedWhileRunning };
}

describe("sqlite bulk deletes run in batches", () => {
  test("purgeExpired: a pending timer fires during a large delete; the count is unchanged", async () => {
    const total = DELETE_BATCH * 4 + 7;
    for (let i = 0; i < total; i++) await stores.events.save(fakeEvent(A, T + i, { tags: [["t", "x"], ["expiration", String(T)]] }));
    await stores.events.save(fakeEvent(A, T, { tags: [["t", "x"], ["expiration", String(T + 1000)]] }));
    const { result, firedWhileRunning } = await timerFiresDuring(() => stores.events.purgeExpired(T + 1));
    expect(result).toBe(total);
    expect(firedWhileRunning).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(1);
    // the tag rows went with them (trigger), only the survivor's remain
    expect(await count("SELECT COUNT(*) AS n FROM event_tags")).toBe(1);
  });

  test("deleteByPubkey (with and without until) yields between batches", async () => {
    for (let i = 0; i < DELETE_BATCH * 3; i++) await stores.events.save(fakeEvent(A, T + i));
    await stores.events.save(fakeEvent(B, T));
    const first = await timerFiresDuring(() => stores.events.deleteByPubkey(A, T + DELETE_BATCH * 2 - 1));
    expect(first.result).toBe(DELETE_BATCH * 2);
    expect(first.firedWhileRunning).toBe(true);
    expect(await stores.events.deleteByPubkey(A)).toBe(DELETE_BATCH);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(1);
  });

  test("deleteByFilter keeps limit semantics (newest matches, selected once) across batches", async () => {
    for (let i = 0; i < DELETE_BATCH * 3; i++) await stores.events.save(fakeEvent(A, T + i));
    const limit = DELETE_BATCH * 2 + 3;
    const { result, firedWhileRunning } = await timerFiresDuring(() =>
      stores.events.deleteByFilter([{ authors: [A], limit }, { authors: [A], limit: 1 }]),
    );
    expect(result).toBe(limit);
    expect(firedWhileRunning).toBe(true);
    const left = await stores.db.get<{ n: number; newest: number }>("SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM events");
    expect(Number(left?.n)).toBe(DELETE_BATCH * 3 - limit);
    expect(Number(left?.newest)).toBe(T + DELETE_BATCH * 3 - limit - 1);
    await expect(stores.events.deleteByFilter([{}])).rejects.toThrow();
  });

  test("deleteByIds over several batches still records tombstones", async () => {
    const evs = Array.from({ length: DELETE_BATCH + 10 }, (_, i) => fakeEvent(A, T + i));
    for (const e of evs) await stores.events.save(e);
    const ids = evs.map((e) => e.id);
    const { result, firedWhileRunning } = await timerFiresDuring(() => stores.events.deleteByIds([...ids, ids[0]], { tombstone: "x" }));
    expect(result).toBe(evs.length);
    expect(firedWhileRunning).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM deleted_events")).toBe(evs.length);
    expect((await stores.events.save(evs[DELETE_BATCH + 5])).status).toBe("deleted");
  });
});
