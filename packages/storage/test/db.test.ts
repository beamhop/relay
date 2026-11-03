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

test.skipIf(process.platform === "win32")("a new sqlite database and its data dir are readable by the owner only", async () => {
  const { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createDb } = await import("../src/db");
  const root = mkdtempSync(join(tmpdir(), "beamhop-db-mode-"));
  try {
    const path = join(root, "data", "beamhop.db");
    const db = await createDb({ database: { driver: "sqlite", sqlitePath: path } });
    await db.migrate("t", [{ id: "001", up: "CREATE TABLE t_x (id INTEGER PRIMARY KEY)" }]);
    await db.run("INSERT INTO t_x DEFAULT VALUES");
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(join(root, "data"))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(mode(`${path}-wal`)).toBe(0o600);
    await db.close();
    // an existing database keeps the mode the operator gave it
    const other = join(root, "shared.db");
    writeFileSync(other, "");
    chmodSync(other, 0o640);
    await (await createDb({ database: { driver: "sqlite", sqlitePath: other } })).close();
    expect(mode(other)).toBe(0o640);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
