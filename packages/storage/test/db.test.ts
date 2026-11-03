import { expect, test } from "bun:test";
import { createMemoryDb, toPgPlaceholders } from "../src/db";

test("migrate + crud + tx rollback", async () => {
  const db = await createMemoryDb();
  await db.migrate("t", [{ id: "001", up: "CREATE TABLE t_x (id INTEGER PRIMARY KEY, v TEXT)" }]);
  await db.migrate("t", [{ id: "001", up: "CREATE TABLE t_x (id INTEGER PRIMARY KEY, v TEXT)" }]);
  await db.run("INSERT INTO t_x (v) VALUES (?)", ["a"]);
  await expect(db.tx(async (d) => { await d.run("INSERT INTO t_x (v) VALUES (?)", ["b"]); throw new Error("x"); })).rejects.toThrow();
  expect(await db.all<{ v: string }>("SELECT v FROM t_x")).toEqual([{ v: "a" }]);
  expect(await db.get("SELECT v FROM t_x WHERE v = ?", ["zz"])).toBeUndefined();
});

test("pg placeholders", () => {
  expect(toPgPlaceholders("SELECT '?' , ? , ?")).toBe("SELECT '?' , $1 , $2");
});

test("a sqlite database (secrets: relay key, TOTP seeds) is owner-only on disk; loose modes are tightened", async () => {
  const { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createDb } = await import("../src/db");
  const root = mkdtempSync(join(tmpdir(), "beamhop-modes-"));
  const old = process.umask(0o022);
  try {
    const fresh = join(root, "data", "beamhop.db");
    const db = await createDb({ database: { driver: "sqlite", sqlitePath: fresh } } as never);
    await db.exec("CREATE TABLE x (v TEXT)");
    await db.run("INSERT INTO x VALUES (?)", ["secret"]);
    expect(statSync(join(root, "data")).mode & 0o777).toBe(0o700);
    for (const f of [fresh, `${fresh}-wal`]) expect([f, statSync(f).mode & 0o077]).toEqual([f, 0]);
    await db.close();

    const existing = join(root, "loose.db");
    writeFileSync(existing, "");
    chmodSync(existing, 0o644);
    const db2 = await createDb({ database: { driver: "sqlite", sqlitePath: existing } } as never);
    expect(statSync(existing).mode & 0o777).toBe(0o600);
    await db2.close();
  } finally {
    process.umask(old);
    rmSync(root, { recursive: true, force: true });
  }
});
