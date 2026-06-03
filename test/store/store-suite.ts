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

    test("delete removes an event and reports whether it existed", () => {
      const store = make();
      store.add(events.note);
      expect(store.delete(events.note.id)).toBe(true);
      expect(store.size()).toBe(0);
      expect(store.getById(events.note.id)).toBeUndefined();
      expect(store.delete(events.note.id)).toBe(false);
    });

    test("delete frees a replaceable slot so an older event can be re-added", () => {
      const store = make();
      store.add(events.metadataNewer);
      // Older event normally loses, but after deleting the holder it can be stored.
      expect(store.add(events.metadata).stored).toBe(false);
      expect(store.delete(events.metadataNewer.id)).toBe(true);
      expect(store.add(events.metadata).stored).toBe(true);
      expect(store.getById(events.metadata.id)).toBeDefined();
    });

    test("delete frees an addressable slot", () => {
      const store = make();
      store.add(events.addressableNewer);
      expect(store.delete(events.addressableNewer.id)).toBe(true);
      expect(store.add(events.addressable).stored).toBe(true);
    });

    test("deleteByAuthor removes only that author's events", () => {
      const store = make();
      const other = clone(events.note);
      other.id = "1".repeat(64);
      other.pubkey = "2".repeat(64);
      store.add(events.note);
      store.add(other);
      expect(store.deleteByAuthor(events.note.pubkey)).toBe(1);
      expect(store.getById(events.note.id)).toBeUndefined();
      expect(store.getById(other.id)).toBeDefined();
    });

    test("deleteByAuthor honors the until bound (inclusive)", () => {
      const store = make();
      store.add(events.note); // created_at 1700000000
      store.add(events.reaction); // created_at 1700000004 (kind 7, same author)
      const removed = store.deleteByAuthor(events.note.pubkey, 1700000000);
      expect(removed).toBe(1);
      expect(store.getById(events.note.id)).toBeUndefined();
      expect(store.getById(events.reaction.id)).toBeDefined();
    });

    test("count returns the true match count, ignoring limit", () => {
      const store = make();
      store.add(events.note);
      store.add(events.reaction);
      expect(store.count([{}])).toBe(2);
      expect(store.count([{ limit: 1 }])).toBe(2);
      expect(store.count([{ kinds: [1] }])).toBe(1);
    });

    test("count dedupes across overlapping filters", () => {
      const store = make();
      store.add(events.note);
      expect(store.count([{ kinds: [1] }, { authors: [events.note.pubkey] }])).toBe(1);
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
