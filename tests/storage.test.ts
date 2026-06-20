import { expect, test } from "bun:test";
import { MemoryEventStore, SqliteEventStore } from "../src/storage";
import { secretKey, signedEvent } from "./helpers";

test("memory store keeps only the newest replaceable event", async () => {
  const store = new MemoryEventStore();
  const sk = secretKey(2);
  const older = signedEvent(sk, { kind: 0, content: "{\"name\":\"old\"}", created_at: 10 });
  const newer = signedEvent(sk, { kind: 0, content: "{\"name\":\"new\"}", created_at: 20 });

  expect((await store.save(older)).stored).toBe(true);
  const result = await store.save(newer);
  expect(result.stored).toBe(true);
  expect(result.replacedIds).toEqual([older.id]);
  expect(await store.has(older.id)).toBe(false);
  expect(await store.has(newer.id)).toBe(true);
});

test("NIP-09 deletion removes author events and prevents older reinsertion", async () => {
  const store = new MemoryEventStore();
  const sk = secretKey(3);
  const note = signedEvent(sk, { kind: 1, content: "delete me", created_at: 10 });
  const deletion = signedEvent(sk, { kind: 5, tags: [["e", note.id], ["k", "1"]], created_at: 20 });

  await store.save(note);
  await store.save(deletion);
  expect(await store.applyDeletionRequest(deletion)).toBe(1);
  expect(await store.has(note.id)).toBe(false);

  const rejected = await store.save(note);
  expect(rejected.stored).toBe(false);
  expect(rejected.message).toStartWith("blocked:");
});

test("NIP-62 vanish deletes old author events and gift wraps addressed to the pubkey", async () => {
  const store = new MemoryEventStore();
  const author = secretKey(4);
  const wrapper = secretKey(5);
  const relayUrl = "ws://localhost:7777/";
  const note = signedEvent(author, { kind: 1, content: "old", created_at: 10 });
  const giftWrap = signedEvent(wrapper, { kind: 1059, tags: [["p", note.pubkey]], content: "wrapped", created_at: 11 });
  const vanish = signedEvent(author, { kind: 62, tags: [["relay", relayUrl]], created_at: 20 });

  await store.save(note);
  await store.save(giftWrap);
  await store.save(vanish);
  const deleted = await store.applyVanishRequest(vanish, [relayUrl]);

  expect(deleted).toBe(3);
  expect(await store.has(note.id)).toBe(false);
  expect(await store.has(giftWrap.id)).toBe(false);
  expect(await store.has(vanish.id)).toBe(false);
});

test("SQLite store persists accepted events", async () => {
  const path = `${import.meta.dir}/tmp-${crypto.randomUUID()}.sqlite`;
  const event = signedEvent(secretKey(6), { kind: 1, content: "persisted" });

  const first = new SqliteEventStore(path);
  await first.init();
  await first.save(event);
  await first.close();

  const second = new SqliteEventStore(path);
  await second.init();
  expect(await second.has(event.id)).toBe(true);
  await second.close();
  await deleteIfExists(path);
  await deleteIfExists(`${path}-shm`);
  await deleteIfExists(`${path}-wal`);
});

async function deleteIfExists(path: string): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) await file.delete();
}
