import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@beamhop/storage";

describe("beamhop admin commands work on the stores alone", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(import.meta.dir, ".tmp-cli-admin-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("admin remove on a fresh database migrates the admin tables itself and starts nothing else", async () => {
    (globalThis as { __BEAMHOP_NO_AUTORUN__?: boolean }).__BEAMHOP_NO_AUTORUN__ = true;
    const { main } = await import("../src/cli");
    const dbPath = join(dir, "db.sqlite");
    const target = "c".repeat(64);
    const quiet = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {})];
    try {
      await main(["admin", "add", target, "--role", "moderator", "--sqlite-path", dbPath]);
      await main(["admin", "remove", target, "--sqlite-path", dbPath]);
    } finally {
      for (const q of quiet) q.mockRestore();
    }
    const db = await createDb({ database: { driver: "sqlite", sqlitePath: dbPath } });
    try {
      expect((await db.get<{ role: string | null }>("SELECT role FROM users WHERE pubkey = ?", [target]))?.role).toBeNull();
      expect((await db.all<{ action: string }>("SELECT action FROM audit_log ORDER BY id")).map((r) => r.action)).toEqual(["admin.add", "admin.remove"]);
      // only storage and admin migrations ran: no Blossom or metrics tables from a full server composition
      const namespaces = (await db.all<{ namespace: string }>("SELECT DISTINCT namespace FROM _migrations ORDER BY namespace")).map((r) => r.namespace);
      expect(namespaces).toEqual(["admin", "storage"]);
    } finally {
      await db.close();
    }
  });
});
