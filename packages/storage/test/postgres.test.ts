import { expect, test } from "bun:test";
import { ConfigSchema, EventBus } from "@beamhop/sdk";
import { createDb, createSettingsService, createStores, silentLogger } from "../src";
import { signer } from "./helpers";

// Runs against a real database only when BEAMHOP_TEST_PG=postgres://... is set. Drops storage tables first!
const url = process.env.BEAMHOP_TEST_PG;

test.skipIf(!url)("postgres: end-to-end smoke", async () => {
  const config = ConfigSchema.parse({ database: { driver: "postgres", postgresUrl: url } });
  const db = await createDb(config);
  await db.exec(
    "DROP TABLE IF EXISTS event_tags, events, deleted_events, users, invites, ip_rules, kv, audit_log CASCADE; DELETE FROM _migrations WHERE namespace = 'storage'",
  ).catch(() => {});
  const stores = await createStores(config, silentLogger, { db });
  const a = signer();
  const T = 1_700_000_000;
  const n1 = a.sign({ kind: 1, created_at: T, tags: [["t", "pg"]], content: "hello postgres world" });
  const p1 = a.sign({ kind: 0, created_at: T, content: "{}" });
  const p2 = a.sign({ kind: 0, created_at: T + 1, content: "{}" });
  expect((await stores.events.save(n1)).status).toBe("saved");
  expect((await stores.events.save(n1)).status).toBe("duplicate");
  expect((await stores.events.save(p1)).status).toBe("saved");
  expect((await stores.events.save(p2)).status).toBe("replaced");
  expect((await stores.events.save(p1)).status).toBe("stale");
  expect((await stores.events.query([{ "#t": ["pg"] }])).map((e) => e.id)).toEqual([n1.id]);
  expect((await stores.events.query([{ search: "postgres" }])).map((e) => e.id)).toEqual([n1.id]);
  expect(await stores.events.count([{ authors: [a.pubkey] }])).toBe(2);
  const big = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(64, "0"));
  expect((await stores.events.query([{ ids: [...big, n1.id] }])).length).toBe(1);
  expect(await stores.events.applyDeletion(a.sign({ kind: 5, created_at: T + 2, tags: [["e", n1.id]] }))).toBe(1);
  expect((await stores.events.save(n1)).status).toBe("deleted");
  expect((await stores.events.stats()).sizeBytes).toBeGreaterThan(0);
  expect(await stores.events.kindCounts(a.pubkey)).toEqual([{ kind: 0, count: 1 }]);
  expect(await stores.kv.setIfAbsent("pg", "k", 1)).toBe(true);
  expect(await stores.kv.setIfAbsent("pg", "k", 2)).toBe(false);

  await stores.users.touch(a.pubkey, 10);
  await stores.flush();
  expect((await stores.users.get(a.pubkey))?.eventCount).toBe(1);
  const inv = await stores.invites.create({ createdBy: "x" });
  expect(await stores.invites.redeem(inv.code, a.pubkey)).toBe(true);
  expect(await stores.invites.redeem(inv.code, a.pubkey)).toBe(false);
  expect((await stores.users.list({ search: a.pubkey.slice(0, 8) })).total).toBe(1);
  const settings = await createSettingsService(stores, new EventBus());
  await settings.update({ info: { name: "pg" } }, "me");
  expect((await stores.audit.list({}))[0].action).toBe("settings.update");
  await stores.audit.record({ actor: "x", action: "old", target: null, details: {}, ip: null, at: 1 });
  expect(await stores.audit.prune(2)).toBe(1);
  expect((await stores.audit.list({ action: "old" })).length).toBe(0);
  await stores.close();
});
