import { describe, expect, test } from "bun:test";
import { createTestStores } from "../src/testing";
import { signer } from "./helpers";

describe("events.kindCounts", () => {
  test("counts one pubkey's stored events per kind, most frequent first, others' events left out", async () => {
    const s = await createTestStores();
    try {
      const a = signer();
      const b = signer();
      const T = 1_700_000_000;
      for (let i = 0; i < 3; i++) await s.events.save(a.sign({ kind: 1, created_at: T + i, content: `n${i}` }));
      await s.events.save(a.sign({ kind: 7, created_at: T, content: "+" }));
      await s.events.save(a.sign({ kind: 0, created_at: T, content: "{}" }));
      await s.events.save(b.sign({ kind: 1, created_at: T, content: "other" }));
      expect(await s.events.kindCounts(a.pubkey)).toEqual([
        { kind: 1, count: 3 },
        { kind: 0, count: 1 },
        { kind: 7, count: 1 },
      ]);
      expect(await s.events.kindCounts("f".repeat(64))).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

describe("audit.prune", () => {
  test("deletes entries older than the cutoff across several batches and keeps the rest", async () => {
    const s = await createTestStores();
    try {
      const old = 2500; // more than one batch
      for (let i = 0; i < old; i++) await s.audit.record({ actor: "a", action: "old", target: null, details: {}, ip: null, at: 1000 + (i % 10) });
      await s.audit.record({ actor: "a", action: "new", target: null, details: {}, ip: null, at: 5000 });
      await s.audit.record({ actor: "a", action: "edge", target: null, details: {}, ip: null, at: 2000 });
      expect(await s.audit.prune(2000)).toBe(old);
      expect((await s.audit.list({ limit: 1000 })).map((e) => e.action)).toEqual(["edge", "new"]);
      expect(await s.audit.prune(2000)).toBe(0);
    } finally {
      await s.close();
    }
  });
});
