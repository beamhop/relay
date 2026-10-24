import { describe, expect, test } from "bun:test";
import { createTestStores } from "../src/testing";

describe("kv.setIfAbsent", () => {
  test("only the first writer wins; later calls leave the value alone", async () => {
    const s = await createTestStores();
    try {
      expect(await s.kv.setIfAbsent("server", "relaySecretKey", "first")).toBe(true);
      expect(await s.kv.setIfAbsent("server", "relaySecretKey", "second")).toBe(false);
      expect(await s.kv.get("server", "relaySecretKey")).toBe("first");
      // concurrent callers: exactly one write lands
      const results = await Promise.all(["a", "b", "c", "d"].map((v) => s.kv.setIfAbsent("ns", "k", v)));
      expect(results.filter(Boolean).length).toBe(1);
      expect(["a", "b", "c", "d"]).toContain((await s.kv.get<string>("ns", "k"))!);
    } finally {
      await s.close();
    }
  });
});
