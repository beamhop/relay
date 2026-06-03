import { afterEach, describe, expect, test } from "bun:test";
import { SqliteEventStore } from "../../src/store/sqlite-store.ts";
import { runStoreSuite } from "./store-suite.ts";
import { events } from "../fixtures.ts";

const open: SqliteEventStore[] = [];
function make(): SqliteEventStore {
  const store = new SqliteEventStore(":memory:");
  open.push(store);
  return store;
}

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

runStoreSuite("SqliteEventStore", make);

describe("SqliteEventStore persistence", () => {
  test("events survive reopening the same database file", () => {
    const path = `/tmp/relay-test-${Bun.hash(events.note.id).toString(16)}.db`;
    try {
      const first = new SqliteEventStore(path);
      first.add(events.note);
      first.close();

      const second = new SqliteEventStore(path);
      expect(second.getById(events.note.id)).toBeDefined();
      expect(second.size()).toBe(1);
      second.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          require("node:fs").unlinkSync(path + suffix);
        } catch {
          /* ignore */
        }
      }
    }
  });

  test("defaults to an in-memory database", () => {
    const store = new SqliteEventStore();
    open.push(store);
    expect(store.size()).toBe(0);
  });
});
