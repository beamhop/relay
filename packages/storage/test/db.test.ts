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
