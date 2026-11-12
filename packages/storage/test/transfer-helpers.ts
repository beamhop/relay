import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type DatabaseTarget, type Db, type Migration, type NostrEvent } from "@beamhop/sdk";
import { createStores, recordMigrations, openDatabase, silentLogger, type StorageStores } from "../src";
import { migrateAdmin } from "../../admin-api/src/db";
import { BlobRepo } from "../../blossom/src/repo";
import { GroupRepo } from "../../core/src/nips/nip29/repo";
import { migrations as metricsMigrations } from "../../metrics/src/schema";
import { signer, type Signer } from "./helpers";

export const tempSqlite = (name = "db.sqlite") => join(mkdtempSync(join(tmpdir(), "bh-transfer-")), name);

/** a plugin-like namespace with types the core schema doesn't use (bytes, a boolean) and a table without a key */
export const PLUGIN_MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    up: {
      sqlite:
        "CREATE TABLE plugin_x (id TEXT PRIMARY KEY, data BLOB, flag BOOLEAN NOT NULL DEFAULT 0, n BIGINT, j TEXT); CREATE TABLE plugin_log (msg TEXT NOT NULL, at BIGINT NOT NULL);",
      postgres:
        "CREATE TABLE plugin_x (id TEXT PRIMARY KEY, data BYTEA, flag BOOLEAN NOT NULL DEFAULT false, n BIGINT, j JSONB); CREATE TABLE plugin_log (msg TEXT NOT NULL, at BIGINT NOT NULL);",
    },
  },
];

export interface Seeded {
  stores: StorageStores;
  db: Db;
  recorded(): { namespace: string; migrations: Migration[] }[];
  a: Signer;
  b: Signer;
  bomEvent: NostrEvent;
  events: NostrEvent[];
}

export const T = 1_700_000_000;

/** Opens stores on `target` and applies every namespace the server registers (plus the test plugin). */
export async function openSeedable(target: DatabaseTarget): Promise<Omit<Seeded, "a" | "b" | "bomEvent" | "events">> {
  const raw = await openDatabase(target);
  const rec = recordMigrations(raw);
  const config = ConfigSchema.parse({ database: { driver: target.driver, sqlitePath: target.sqlitePath ?? ":memory:", postgresUrl: target.postgresUrl } });
  const stores = await createStores(config, silentLogger, { db: rec.db });
  await migrateAdmin(stores.db);
  await new BlobRepo(stores.db).migrate();
  await new GroupRepo(stores.db).migrate();
  await stores.db.migrate("metrics", metricsMigrations);
  await stores.db.migrate("plugin_x", PLUGIN_MIGRATIONS);
  return { stores, db: stores.db, recorded: rec.recorded };
}

export async function seed(target: DatabaseTarget): Promise<Seeded> {
  const s = await openSeedable(target);
  const { stores, db } = s;
  const a = signer();
  const b = signer();
  const events: NostrEvent[] = [];
  const save = async (e: NostrEvent) => {
    const r = await stores.events.save(e);
    if (r.status !== "saved" && r.status !== "replaced") throw new Error(`seed save: ${r.status}`);
    events.push(e);
    return e;
  };
  const bomEvent = await save(a.sign({ kind: 1, created_at: T, content: "\ufeffstarts with a byte order mark" }));
  await save(a.sign({ kind: 1, created_at: T + 1, content: "\ufffereversed mark too" }));
  await save(a.sign({ kind: 1, created_at: T + 2, content: "Grüße aus Köln 🚀 日本語のテキスト searchable", tags: [["t", "ünïcode"]] }));
  await save(b.sign({ kind: 1, created_at: T + 3, content: "searchable penguin", tags: Array.from({ length: 300 }, (_, i) => ["t", `tag-${i}-${"x".repeat(50)}`]) }));
  await save(b.sign({ kind: 0, created_at: T + 4, content: JSON.stringify({ name: "b", about: "émoji 👍" }) }));
  await save(a.sign({ kind: 30023, created_at: T + 5, content: "long form searchable", tags: [["d", "article"], ["title", "x"]] }));
  for (let i = 0; i < 40; i++) await save(b.sign({ kind: 1, created_at: T + 10 + i, content: `note ${i} penguin`, tags: [["e", "0".repeat(63) + (i % 10)]] }));
  const doomed = await save(a.sign({ kind: 1, created_at: T + 60, content: "to be deleted" }));
  await stores.events.applyDeletion(a.sign({ kind: 5, created_at: T + 61, tags: [["e", doomed.id]] }));
  events.splice(events.indexOf(doomed), 1);

  await stores.users.touch(a.pubkey, T);
  await stores.users.upsert(b.pubkey, { allowed: true, role: "moderator", notes: "ünïcode note" });
  await stores.flush();
  await stores.kv.set("server", "relaySecretKey", "f".repeat(64));
  await stores.kv.set("settings", "runtime", { info: { name: "relay ☃" } });
  await stores.invites.create({ createdBy: a.pubkey, note: "hi" });
  for (let i = 0; i < 5; i++) await stores.audit.record({ actor: "x", action: `a${i}`, target: null, details: { i }, ip: null });
  await db.run("INSERT INTO admin_credentials (pubkey, password_hash, updated_at) VALUES (?, ?, ?)", [a.pubkey, "hash$1", T]);
  await db.run("INSERT INTO admin_sessions (id, pubkey, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", ["s1", a.pubkey, T, T + 9, T]);
  await db.run("INSERT INTO blossom_blobs (sha256, size, type, created_at, status, has_thumbnail) VALUES (?, ?, ?, ?, ?, ?)", ["ab".repeat(32), 123, "image/png", T, "approved", 1]);
  await db.run("INSERT INTO metrics_series (name, bucket, value) VALUES (?, ?, ?)", ["events", T, 1.5]);
  await db.run("INSERT INTO core_groups (id, name, created_at, created_by) VALUES (?, ?, ?, ?)", ["g1", "Group ⚡", T, a.pubkey]);
  await db.run("INSERT INTO plugin_x (id, data, flag, n, j) VALUES (?, ?, ?, ?, ?)", ["p1", new Uint8Array([0, 1, 2, 255]), true, 2 ** 40, '{"a":[1,2]}']);
  await db.run("INSERT INTO plugin_x (id, data, flag, n, j) VALUES (?, ?, ?, ?, ?)", ["p2", null, false, null, null]);
  for (let i = 0; i < 7; i++) await db.run("INSERT INTO plugin_log (msg, at) VALUES (?, ?)", [`m${i}`, T + i]);
  return { ...s, a, b, bomEvent, events };
}

/** Search / tag / id results a relay would give, for comparing two databases. */
export async function snapshot(stores: StorageStores) {
  const ids = (es: NostrEvent[]) => es.map((e) => e.id).sort();
  return {
    all: ids(await stores.events.query([{ limit: 5000 }], { maxLimit: 5000 })),
    penguin: ids(await stores.events.query([{ search: "penguin", limit: 500 }], { maxLimit: 500 })),
    searchable: ids(await stores.events.query([{ search: "searchable", limit: 500 }], { maxLimit: 500 })),
    koeln: ids(await stores.events.query([{ search: "Köln", limit: 500 }], { maxLimit: 500 })),
    tag: ids(await stores.events.query([{ "#t": ["ünïcode"] }])),
    bigTag: ids(await stores.events.query([{ "#t": [`tag-299-${"x".repeat(50)}`] }])),
    eTag: ids(await stores.events.query([{ "#e": ["0".repeat(63) + "3"] }])),
  };
}
