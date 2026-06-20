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

test("memory store search uses content and tag terms with relevance ordering", async () => {
  const store = new MemoryEventStore();
  const highRelevance = signedEvent(secretKey(12), { kind: 1, content: "relay relay relay archive", created_at: 10 });
  const recentLowerRelevance = signedEvent(secretKey(13), { kind: 1, content: "relay update", created_at: 30 });
  const tagOnly = signedEvent(secretKey(14), { kind: 1, tags: [["t", "relay"]], content: "tagged topic", created_at: 40 });
  const unrelated = signedEvent(secretKey(15), { kind: 1, content: "unrelated note", created_at: 50 });

  await store.save(recentLowerRelevance);
  await store.save(tagOnly);
  await store.save(unrelated);
  await store.save(highRelevance);

  const limited = await store.query([{ search: "relay", limit: 2 }]);
  expect(limited.events.map((event) => event.id)).toEqual([highRelevance.id, recentLowerRelevance.id]);
  expect(limited.complete).toBe(false);

  const tagSearch = await store.query([{ search: "relay tagged" }]);
  expect(tagSearch.events.map((event) => event.id)).toEqual([tagOnly.id]);

  expect((await store.query([{ search: "relay missing" }])).events).toEqual([]);
  expect((await store.query([{ search: "domain:example.com" }])).events).toEqual([]);
});

test("memory store keeps search index in sync with replacement and deletion", async () => {
  const store = new MemoryEventStore();
  const author = secretKey(16);
  const older = signedEvent(author, { kind: 0, content: "{\"name\":\"old relay\"}", created_at: 10 });
  const newer = signedEvent(author, { kind: 0, content: "{\"name\":\"new relay\"}", created_at: 20 });
  const note = signedEvent(secretKey(17), { kind: 1, content: "delete searchable relay", created_at: 30 });

  await store.save(older);
  await store.save(newer);
  await store.save(note);

  expect((await store.query([{ search: "old" }])).events).toEqual([]);
  expect((await store.query([{ search: "new" }])).events.map((event) => event.id)).toEqual([newer.id]);

  await store.deleteEvent(note.id);
  expect((await store.query([{ search: "delete searchable" }])).events).toEqual([]);
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

test("SQLite store persists and maintains full-text search index", async () => {
  const path = `${import.meta.dir}/tmp-${crypto.randomUUID()}.sqlite`;
  const match = signedEvent(secretKey(18), { kind: 1, tags: [["t", "nostr"]], content: "persistent relay search", created_at: 10 });
  const other = signedEvent(secretKey(19), { kind: 1, content: "persistent unrelated note", created_at: 20 });

  const first = new SqliteEventStore(path);
  await first.init();
  await first.save(match);
  await first.save(other);
  await first.close();

  const second = new SqliteEventStore(path);
  await second.init();
  expect((await second.query([{ search: "relay search" }])).events.map((event) => event.id)).toEqual([match.id]);
  expect((await second.query([{ search: "nostr relay" }])).events.map((event) => event.id)).toEqual([match.id]);
  expect(await second.count([{ search: "relay search" }])).toMatchObject({ count: 1 });

  await second.deleteEvent(match.id);
  expect((await second.query([{ search: "relay search" }])).events).toEqual([]);
  await second.close();
  await deleteIfExists(path);
  await deleteIfExists(`${path}-shm`);
  await deleteIfExists(`${path}-wal`);
});

async function deleteIfExists(path: string): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) await file.delete();
}
