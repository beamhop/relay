import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseStateFile } from "@beamhop/sdk";
import { readDatabaseState, writeDatabaseState } from "../src/database-state";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, ".tmp-dbstate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;
const sqliteState = (path: string): DatabaseStateFile => ({ version: 1, current: { driver: "sqlite", sqlitePath: path }, rollbacks: [] });

describe("readDatabaseState", () => {
  test("missing file → undefined", () => {
    expect(readDatabaseState(join(dir, "nope", "database.json"))).toBeUndefined();
  });

  test("reads a valid file", () => {
    const p = join(dir, "database.json");
    const state: DatabaseStateFile = {
      version: 1,
      current: { driver: "postgres", postgresUrl: "postgres://u:p@h/db" },
      rollbacks: [{ id: "r1", target: { driver: "sqlite", sqlitePath: "/x/beamhop.db" }, frozenAt: 1700000000, replacedBy: "postgres" }],
      switchedAt: 1700000000,
    };
    writeFileSync(p, JSON.stringify(state));
    expect(readDatabaseState(p)).toEqual(state);
  });

  test("corrupt JSON throws with the path", () => {
    const p = join(dir, "database.json");
    writeFileSync(p, "{ not json");
    expect(() => readDatabaseState(p)).toThrow(p);
    expect(() => readDatabaseState(p)).toThrow(/parse/);
  });

  test("schema violations throw with the path", () => {
    const p = join(dir, "database.json");
    const bad = (v: unknown) => {
      writeFileSync(p, JSON.stringify(v));
      return () => readDatabaseState(p);
    };
    expect(bad({ version: 2, current: { driver: "sqlite", sqlitePath: "/a" }, rollbacks: [] })).toThrow(p);
    expect(bad({ version: 1, current: { driver: "postgres" }, rollbacks: [] })).toThrow(/postgresUrl/);
    expect(bad({ version: 1, current: { driver: "sqlite" }, rollbacks: [] })).toThrow(/sqlitePath/);
    expect(bad({ version: 1, current: { driver: "mysql", sqlitePath: "/a" }, rollbacks: [] })).toThrow(p);
    expect(bad([])).toThrow(p);
  });
});

describe("writeDatabaseState", () => {
  test("creates the directory (0700) and the file (0600), round-trips", async () => {
    const p = join(dir, "data", "sub", "database.json");
    const state = sqliteState("/abs/beamhop.db");
    await writeDatabaseState(p, state);
    expect(readDatabaseState(p)).toEqual(state);
    expect(mode(p)).toBe(0o600);
    expect(mode(join(dir, "data", "sub"))).toBe(0o700);
  });

  test("replaces an existing file with looser permissions and leaves it 0600", async () => {
    const p = join(dir, "database.json");
    writeFileSync(p, "old");
    chmodSync(p, 0o644);
    await writeDatabaseState(p, sqliteState("/abs/new.db"));
    expect(mode(p)).toBe(0o600);
    expect(readDatabaseState(p)?.current.sqlitePath).toBe("/abs/new.db");
  });

  test("leaves no temp files behind, and an invalid state never replaces the old file", async () => {
    const p = join(dir, "database.json");
    await writeDatabaseState(p, sqliteState("/abs/one.db"));
    await writeDatabaseState(p, sqliteState("/abs/two.db"));
    const bad = { version: 1, current: { driver: "postgres" }, rollbacks: [] } as unknown as DatabaseStateFile;
    await expect(writeDatabaseState(p, bad)).rejects.toThrow(/postgresUrl/);
    expect(readdirSync(dir)).toEqual(["database.json"]);
    expect(JSON.parse(readFileSync(p, "utf8")).current.sqlitePath).toBe("/abs/two.db");
  });

  test("a failed write leaves the old file intact and cleans up", async () => {
    const p = join(dir, "database.json");
    await writeDatabaseState(p, sqliteState("/abs/one.db"));
    // the target path is a non-empty directory: rename fails
    const blocked = join(dir, "blocked");
    mkdirSync(join(blocked, "x"), { recursive: true });
    await expect(writeDatabaseState(blocked, sqliteState("/abs/two.db"))).rejects.toThrow();
    expect(readdirSync(dir).sort()).toEqual(["blocked", "database.json"]);
    expect(readDatabaseState(p)?.current.sqlitePath).toBe("/abs/one.db");
  });
});
