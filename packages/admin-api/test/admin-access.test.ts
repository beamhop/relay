import { describe, expect, test } from "bun:test";
import type { Db } from "@beamhop/sdk";
import { createMemoryDb } from "@beamhop/storage";
import { adminAccess, migrateAdmin, revokeAdminAccess, setAdminPassword } from "../src";

const A = "a".repeat(64);
const B = "b".repeat(64);

async function seeded(): Promise<Db> {
  const db = await createMemoryDb();
  await migrateAdmin(db);
  for (const pk of [A, B]) {
    await db.run("INSERT INTO admin_credentials (pubkey, password_hash, totp_secret, updated_at) VALUES (?, 'h', 'totp', 1)", [pk]);
    await db.run("INSERT INTO admin_passkeys (id, pubkey, public_key, created_at) VALUES (?, ?, 'k', 1)", [`pk-${pk}`, pk]);
    await db.run("INSERT INTO admin_sessions (id, pubkey, created_at, expires_at, last_seen_at) VALUES (?, ?, 1, 9999999999, 1)", [`s-${pk}`, pk]);
    await db.run("INSERT INTO admin_push_subscriptions (endpoint, pubkey, subscription, created_at, session_id) VALUES (?, ?, '{}', 1, ?)", [`https://push.test/${pk}`, pk, `s-${pk}`]);
  }
  return db;
}
const count = async (db: Db, table: string, pk: string) => Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE pubkey = ?`, [pk]))!.n);

describe("admin access without the HTTP app (CLI helpers)", () => {
  test("revokeAdminAccess ends sessions with their push devices and drops every login factor of that admin only", async () => {
    const db = await seeded();
    await revokeAdminAccess(adminAccess(db), A);
    for (const table of ["admin_credentials", "admin_passkeys", "admin_sessions", "admin_push_subscriptions"]) {
      expect([table, await count(db, table, A), await count(db, table, B)]).toEqual([table, 0, 1]);
    }
  });

  test("setAdminPassword signs the admin out everywhere and keeps second factors unless asked to reset them", async () => {
    const db = await seeded();
    const before = Math.floor(Date.now() / 1000);
    await setAdminPassword(adminAccess(db), A, "h1");
    const cred = await db.get<{ password_hash: string; totp_secret: string | null; password_set_at: number }>(
      "SELECT password_hash, totp_secret, password_set_at FROM admin_credentials WHERE pubkey = ?",
      [A],
    );
    expect(cred!.password_hash).toBe("h1");
    // the reset time retires trusted-device cookies issued before it
    expect(Number(cred!.password_set_at)).toBeGreaterThanOrEqual(before);
    expect(cred!.totp_secret).toBe("totp");
    expect([await count(db, "admin_sessions", A), await count(db, "admin_push_subscriptions", A), await count(db, "admin_passkeys", A)]).toEqual([0, 0, 1]);

    await setAdminPassword(adminAccess(db), A, "h2", { resetSecondFactors: true });
    expect((await db.get<{ totp_secret: string | null }>("SELECT totp_secret FROM admin_credentials WHERE pubkey = ?", [A]))!.totp_secret).toBeNull();
    expect(await count(db, "admin_passkeys", A)).toBe(0);
    expect([await count(db, "admin_sessions", B), await count(db, "admin_passkeys", B)]).toEqual([1, 1]);
  });
});
