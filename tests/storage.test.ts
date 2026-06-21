import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { MemoryEventStore, SqliteEventStore } from "../src/storage";
import { PostgresEventStore } from "../src/storage/postgres";
import type { EventStore } from "../src/storage";
import { secretKey, signedEvent } from "./helpers";

interface Backend {
  name: string;
  durable: boolean;
  fresh: () => Promise<{ store: EventStore; cleanup: () => Promise<void> }>;
  reopen?: (token: string) => Promise<EventStore>;
  durableToken?: () => string;
}

const POSTGRES_URL = process.env.RELAY_TEST_POSTGRES_URL;
const postgresAdmin = POSTGRES_URL ? new SQL(POSTGRES_URL) : undefined;

afterAll(async () => {
  if (postgresAdmin) await postgresAdmin.close({ timeout: 5 });
});

async function deleteIfExists(path: string): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) await file.delete();
}

const memoryBackend: Backend = {
  name: "memory",
  durable: false,
  fresh: async () => {
    const store = new MemoryEventStore();
    await store.init();
    return { store, cleanup: async () => store.close() };
  },
};

function sqlitePath(): string {
  return `${import.meta.dir}/tmp-${crypto.randomUUID()}.sqlite`;
}

const sqliteBackend: Backend = {
  name: "sqlite",
  durable: true,
  fresh: async () => {
    const path = sqlitePath();
    const store = new SqliteEventStore(path);
    await store.init();
    return {
      store,
      cleanup: async () => {
        await store.close();
        await deleteIfExists(path);
        await deleteIfExists(`${path}-shm`);
        await deleteIfExists(`${path}-wal`);
      },
    };
  },
  reopen: async (path) => {
    const store = new SqliteEventStore(path);
    await store.init();
    return store;
  },
  durableToken: sqlitePath,
};

const postgresBackend: Backend | undefined = POSTGRES_URL
  ? {
      name: "postgres",
      durable: true,
      fresh: async () => {
        const store = new PostgresEventStore(POSTGRES_URL);
        await store.init();
        await postgresAdmin!`TRUNCATE events, event_tags, deleted_events, deleted_addresses, vanished_pubkeys`;
        return { store, cleanup: async () => store.close() };
      },
      reopen: async () => {
        const store = new PostgresEventStore(POSTGRES_URL);
        await store.init();
        return store;
      },
      durableToken: () => POSTGRES_URL,
    }
  : undefined;

const backends: Backend[] = [memoryBackend, sqliteBackend, ...(postgresBackend ? [postgresBackend] : [])];
const durableBackends = backends.filter((backend) => backend.durable);

if (!postgresBackend) {
  test.skip("postgres backend (set RELAY_TEST_POSTGRES_URL to run)", () => {});
}

for (const backend of backends) {
  describe(`EventStore: ${backend.name}`, () => {
    test("keeps only the newest replaceable event", async () => {
      const { store, cleanup } = await backend.fresh();
      try {
        const sk = secretKey(2);
        const older = signedEvent(sk, { kind: 0, content: '{"name":"old"}', created_at: 10 });
        const newer = signedEvent(sk, { kind: 0, content: '{"name":"new"}', created_at: 20 });

        expect((await store.save(older)).stored).toBe(true);
        const result = await store.save(newer);
        expect(result.stored).toBe(true);
        expect(result.replacedIds).toEqual([older.id]);
        expect(await store.has(older.id)).toBe(false);
        expect(await store.has(newer.id)).toBe(true);

        // An older replaceable event must not resurrect a newer one.
        const stale = await store.save(older);
        expect(stale.stored).toBe(false);
      } finally {
        await cleanup();
      }
    });

    test("rejects an older addressable event for the same address", async () => {
      const { store, cleanup } = await backend.fresh();
      try {
        const sk = secretKey(7);
        const older = signedEvent(sk, { kind: 30000, tags: [["d", "x"]], content: "old", created_at: 10 });
        const newer = signedEvent(sk, { kind: 30000, tags: [["d", "x"]], content: "new", created_at: 20 });
        const otherD = signedEvent(sk, { kind: 30000, tags: [["d", "y"]], content: "other", created_at: 5 });

        await store.save(older);
        await store.save(otherD);
        const replaced = await store.save(newer);
        expect(replaced.replacedIds).toEqual([older.id]);
        expect(await store.has(newer.id)).toBe(true);
        expect(await store.has(otherD.id)).toBe(true);
      } finally {
        await cleanup();
      }
    });

    test("NIP-09 deletion removes author events and prevents older reinsertion", async () => {
      const { store, cleanup } = await backend.fresh();
      try {
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
      } finally {
        await cleanup();
      }
    });

    test("NIP-62 vanish deletes old author events and gift wraps addressed to the pubkey", async () => {
      const { store, cleanup } = await backend.fresh();
      try {
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
      } finally {
        await cleanup();
      }
    });

    test("maps NIP-01 filters to the correct event set", async () => {
      const { store, cleanup } = await backend.fresh();
      try {
        const alice = secretKey(20);
        const bob = secretKey(21);
        const a1 = signedEvent(alice, { kind: 1, tags: [["t", "nostr"]], content: "a1", created_at: 100 });
        const a2 = signedEvent(alice, { kind: 1, tags: [["t", "relay"]], content: "a2", created_at: 200 });
        const a3 = signedEvent(alice, { kind: 7, content: "a3", created_at: 300 });
        const b1 = signedEvent(bob, { kind: 1, tags: [["t", "nostr"]], content: "b1", created_at: 150 });
        for (const event of [a1, a2, a3, b1]) await store.save(event);

        const byKind = await store.query([{ kinds: [1] }]);
        expect(idset(byKind.events)).toEqual(idset([a1, a2, b1]));

        const byAuthor = await store.query([{ authors: [a1.pubkey] }]);
        expect(idset(byAuthor.events)).toEqual(idset([a1, a2, a3]));

        const byTag = await store.query([{ "#t": ["nostr"] }]);
        expect(idset(byTag.events)).toEqual(idset([a1, b1]));

        const byWindow = await store.query([{ since: 150, until: 250 }]);
        expect(idset(byWindow.events)).toEqual(idset([a2, b1]));

        const byIds = await store.query([{ ids: [a3.id, b1.id] }]);
        expect(idset(byIds.events)).toEqual(idset([a3, b1]));

        const ordered = await store.query([{ kinds: [1] }]);
        expect(ordered.events.map((event) => event.id)).toEqual([a2.id, b1.id, a1.id]);

        const limited = await store.query([{ kinds: [1], limit: 1 }]);
        expect(limited.events.map((event) => event.id)).toEqual([a2.id]);
        expect(limited.complete).toBe(false);

        expect(await store.count([{ kinds: [1] }])).toMatchObject({ count: 3 });
        expect(await store.count([{ authors: [b1.pubkey], kinds: [1] }])).toMatchObject({ count: 1 });
      } finally {
        await cleanup();
      }
    });

    test("clear() erases stored events and moderation tombstones", async () => {
      const { store, cleanup } = await backend.fresh();
      try {
        const sk = secretKey(30);
        const note = signedEvent(sk, { kind: 1, content: "wipe me", created_at: 10 });
        const deletion = signedEvent(sk, { kind: 5, tags: [["e", note.id], ["k", "1"]], created_at: 20 });

        await store.save(note);
        await store.applyDeletionRequest(deletion);
        expect(await store.has(note.id)).toBe(false);

        await store.clear();

        expect(await store.count([{}])).toMatchObject({ count: 0 });
        expect(await store.allEvents()).toEqual([]);
        // The deletion tombstone is gone, so the original note is acceptable again.
        const reinserted = await store.save(note);
        expect(reinserted.stored).toBe(true);
      } finally {
        await cleanup();
      }
    });

    test("excludes expired events from queries", async () => {
      const { store, cleanup } = await backend.fresh();
      try {
        const sk = secretKey(22);
        const future = Math.floor(Date.now() / 1000) + 3600;
        const past = Math.floor(Date.now() / 1000) - 10;
        const live = signedEvent(sk, { kind: 1, tags: [["expiration", String(future)]], content: "live", created_at: 100 });
        const expired = signedEvent(sk, { kind: 1, tags: [["expiration", String(past)]], content: "gone", created_at: 100 });

        expect((await store.save(live)).stored).toBe(true);
        expect((await store.save(expired)).stored).toBe(false);

        const result = await store.query([{ kinds: [1] }]);
        expect(idset(result.events)).toEqual(idset([live]));
      } finally {
        await cleanup();
      }
    });
  });
}

for (const backend of durableBackends) {
  describe(`EventStore durability: ${backend.name}`, () => {
    test("persists accepted events across reopen", async () => {
      const token = backend.durableToken!();
      const event = signedEvent(secretKey(6), { kind: 1, content: "persisted" });
      const cleanupPaths: string[] = [];

      const first = await backend.reopen!(token);
      try {
        // For postgres the token is a shared URL; ensure a clean slate first.
        if (backend.name === "postgres") await postgresAdmin!`TRUNCATE events, event_tags, deleted_events, deleted_addresses, vanished_pubkeys`;
        await first.save(event);
      } finally {
        await first.close();
      }

      const second = await backend.reopen!(token);
      try {
        expect(await second.has(event.id)).toBe(true);
      } finally {
        await second.close();
      }

      if (backend.name === "sqlite") {
        cleanupPaths.push(token, `${token}-shm`, `${token}-wal`);
        for (const path of cleanupPaths) await deleteIfExists(path);
      }
    });
  });
}

// Search relevance ordering is backend-specific. Memory and SQLite share the custom scorer; the
// Postgres backend uses tsvector ranking, so it is asserted on matched membership instead.

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
  const older = signedEvent(author, { kind: 0, content: '{"name":"old relay"}', created_at: 10 });
  const newer = signedEvent(author, { kind: 0, content: '{"name":"new relay"}', created_at: 20 });
  const note = signedEvent(secretKey(17), { kind: 1, content: "delete searchable relay", created_at: 30 });

  await store.save(older);
  await store.save(newer);
  await store.save(note);

  expect((await store.query([{ search: "old" }])).events).toEqual([]);
  expect((await store.query([{ search: "new" }])).events.map((event) => event.id)).toEqual([newer.id]);

  await store.deleteEvent(note.id);
  expect((await store.query([{ search: "delete searchable" }])).events).toEqual([]);
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

if (postgresBackend) {
  describe("EventStore search: postgres", () => {
    test("matches NIP-50 search via tsvector and counts results", async () => {
      const { store, cleanup } = await postgresBackend.fresh();
      try {
        const match = signedEvent(secretKey(40), { kind: 1, tags: [["t", "nostr"]], content: "persistent relay search", created_at: 10 });
        const tagMatch = signedEvent(secretKey(41), { kind: 1, tags: [["t", "relay"]], content: "tagged topic", created_at: 20 });
        const other = signedEvent(secretKey(42), { kind: 1, content: "unrelated note", created_at: 30 });
        for (const event of [match, tagMatch, other]) await store.save(event);

        expect(idset((await store.query([{ search: "relay search" }])).events)).toEqual(idset([match]));
        expect(idset((await store.query([{ search: "relay" }])).events)).toEqual(idset([match, tagMatch]));
        expect((await store.query([{ search: "absent" }])).events).toEqual([]);
        // Extension tokens (domain:, language:, ...) carry no lexemes and must not match.
        expect((await store.query([{ search: "domain:example.com" }])).events).toEqual([]);
        expect(await store.count([{ search: "relay" }])).toMatchObject({ count: 2 });

        await store.deleteEvent(match.id);
        expect(idset((await store.query([{ search: "relay" }])).events)).toEqual(idset([tagMatch]));
      } finally {
        await cleanup();
      }
    });

    test("isolates its tables in a dedicated schema, ignoring a conflicting public.events", async () => {
      // Reproduces the cutover bug: the database already held a prior relay's public.events with a
      // different shape. A schema-scoped store must create + use its own tables and never touch it.
      await postgresAdmin!`DROP TABLE IF EXISTS public.events CASCADE`;
      await postgresAdmin!`CREATE TABLE public.events (id text PRIMARY KEY, legacy_pubkey text, kind int)`;
      await postgresAdmin!`INSERT INTO public.events VALUES ('legacy', 'oldpk', 1)`;
      const store = new PostgresEventStore(POSTGRES_URL!, "beamhop_test");
      await store.init();
      try {
        const event = signedEvent(secretKey(43), { kind: 1, content: "schema isolation", created_at: 10 });
        expect((await store.save(event)).stored).toBe(true);
        expect(idset((await store.query([{ ids: [event.id] }])).events)).toEqual([event.id]);
        expect(await store.count([{ kinds: [1] }])).toMatchObject({ count: 1 });
        // The legacy public.events row is untouched and invisible to the store.
        const [legacy] = await postgresAdmin!`SELECT count(*)::int AS n FROM public.events`;
        expect(legacy.n).toBe(1);
      } finally {
        await store.close();
        await postgresAdmin!`DROP SCHEMA IF EXISTS beamhop_test CASCADE`;
        await postgresAdmin!`DROP TABLE IF EXISTS public.events CASCADE`;
      }
    });
  });
}

function idset(events: { id: string }[]): string[] {
  return events.map((event) => event.id).sort();
}
