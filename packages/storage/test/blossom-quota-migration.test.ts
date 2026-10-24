import { describe, expect, test } from "bun:test";
import { createMemoryDb } from "../src/db";
import { BLOSSOM_QUOTA_ZERO_MIGRATION_ID, NAMESPACE, UNLIMITED_QUOTA_BYTES, sqliteHasFts5, storageMigrations } from "../src/migrations";
import { createStores } from "../src/stores";
import { silentLogger } from "../src/testing";
import { ConfigSchema } from "@beamhop/sdk";

const config = ConfigSchema.parse({ database: { driver: "sqlite", sqlitePath: ":memory:" } });

describe("blossom_quota 0 → unlimited migration", () => {
  test("an upgraded relay keeps per-user quotas of 0 unlimited; other values and NULL stay as they were", async () => {
    const db = await createMemoryDb();
    // a database from before the migration
    const before = storageMigrations(await sqliteHasFts5(db)).filter((m) => m.id !== BLOSSOM_QUOTA_ZERO_MIGRATION_ID);
    await db.migrate(NAMESPACE, before);
    const pk = (c: string) => c.repeat(64);
    await db.run("INSERT INTO users (pubkey, blossom_quota) VALUES (?, 0), (?, 5000), (?, NULL)", [pk("a"), pk("b"), pk("c")]);

    const stores = await createStores(config, silentLogger, { db });
    try {
      expect((await stores.users.get(pk("a")))!.blossomQuota).toBe(UNLIMITED_QUOTA_BYTES);
      expect(UNLIMITED_QUOTA_BYTES).toBe(9007199254740991);
      expect((await stores.users.get(pk("b")))!.blossomQuota).toBe(5000);
      expect((await stores.users.get(pk("c")))!.blossomQuota).toBeNull();
      // it runs once: a quota of 0 set after the upgrade means "no uploads" and is left alone on the next boot
      await stores.users.upsert(pk("d"), { blossomQuota: 0 });
      await db.migrate(NAMESPACE, storageMigrations(true));
      expect((await stores.users.get(pk("d")))!.blossomQuota).toBe(0);
    } finally {
      await stores.close();
    }
  });

  test("the same SQL serves both dialects", () => {
    const m = storageMigrations(true).find((x) => x.id === BLOSSOM_QUOTA_ZERO_MIGRATION_ID)!;
    expect(m.up).toBe("UPDATE users SET blossom_quota = 9007199254740991 WHERE blossom_quota = 0");
  });
});
