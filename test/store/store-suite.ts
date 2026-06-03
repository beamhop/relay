/**
 * Shared behavioral test suite run against every EventStore implementation,
 * so MemoryEventStore and SqliteEventStore are held to identical semantics.
 */
import { describe, expect, test } from "bun:test";
import type { EventStore } from "../../src/store/store.ts";
import { clone, events } from "../fixtures.ts";

export function runStoreSuite(name: string, make: () => EventStore): void {
  describe(`${name}: EventStore behavior`, () => {
    test("stores and retrieves a regular event", () => {
      const store = make();
      expect(store.add(events.note).stored).toBe(true);
      expect(store.size()).toBe(1);
      expect(store.getById(events.note.id)).toEqual(events.note);
    });

    test("rejects duplicates by id", () => {
      const store = make();
      store.add(events.note);
      const res = store.add(events.note);
      expect(res.stored).toBe(false);
      expect(res.duplicate).toBe(true);
      expect(store.size()).toBe(1);
    });

    test("does not store ephemeral events", () => {
      const store = make();
      expect(store.add(events.ephemeral).stored).toBe(false);
      expect(store.size()).toBe(0);
    });

    test("replaceable keeps the newest by created_at", () => {
      const store = make();
      store.add(events.metadata);
      const res = store.add(events.metadataNewer);
      expect(res.stored).toBe(true);
      expect(res.replaced?.id).toBe(events.metadata.id);
      expect(store.size()).toBe(1);
      expect(store.getById(events.metadata.id)).toBeUndefined();
      expect(store.getById(events.metadataNewer.id)).toBeDefined();
    });

    test("replaceable rejects an older event", () => {
      const store = make();
      store.add(events.metadataNewer);
      expect(store.add(events.metadata).stored).toBe(false);
      expect(store.getById(events.metadataNewer.id)).toBeDefined();
      expect(store.size()).toBe(1);
    });

    test("addressable: same d-tag replaces, different d-tag coexists", () => {
      const store = make();
      store.add(events.addressable);
      store.add(events.addressableOtherD);
      expect(store.size()).toBe(2);
      const res = store.add(events.addressableNewer); // same d "slot", newer
      expect(res.replaced?.id).toBe(events.addressable.id);
      expect(store.size()).toBe(2);
      expect(store.getById(events.addressableNewer.id)).toBeDefined();
      expect(store.getById(events.addressableOtherD.id)).toBeDefined();
    });

    test("query returns events newest-first", () => {
      const store = make();
      store.add(events.note); // 1700000000
      store.add(events.reaction); // 1700000004
      const got = store.query([{}]);
      expect(got.map((e) => e.id)).toEqual([events.reaction.id, events.note.id]);
    });

    test("query honors a per-filter limit (most recent first)", () => {
      const store = make();
      store.add(events.note);
      store.add(events.reaction);
      const got = store.query([{ limit: 1 }]);
      expect(got).toHaveLength(1);
      expect(got[0]!.id).toBe(events.reaction.id);
    });

    test("query caps limit at maxLimit", () => {
      const store = make();
      store.add(events.note);
      store.add(events.reaction);
      expect(store.query([{}], 1)).toHaveLength(1);
      expect(store.query([{ limit: 5 }], 1)).toHaveLength(1);
    });

    test("query dedupes across overlapping filters", () => {
      const store = make();
      store.add(events.note);
      const got = store.query([{ kinds: [1] }, { authors: [events.note.pubkey] }]);
      expect(got).toHaveLength(1);
    });

    test("query filters by kind", () => {
      const store = make();
      store.add(events.note);
      store.add(events.contacts);
      const got = store.query([{ kinds: [3] }]);
      expect(got.map((e) => e.id)).toEqual([events.contacts.id]);
    });

    test("clear empties the store", () => {
      const store = make();
      store.add(events.note);
      store.clear();
      expect(store.size()).toBe(0);
      expect(store.query([{}])).toHaveLength(0);
    });

    test("tie-break: equal created_at keeps the lower id", () => {
      const store = make();
      // Two replaceable events, same pubkey/kind/created_at, different ids.
      const a = clone(events.metadata);
      const b = clone(events.metadata);
      a.id = "0".repeat(64);
      b.id = "f".repeat(64);
      store.add(b);
      const res = store.add(a); // a has the lower id -> replaces b
      expect(res.stored).toBe(true);
      expect(store.getById(a.id)).toBeDefined();
      expect(store.getById(b.id)).toBeUndefined();
      // adding b again now loses the tie-break
      expect(store.add(b).stored).toBe(false);
    });
  });
}
