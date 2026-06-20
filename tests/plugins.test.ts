import { expect, test } from "bun:test";
import { testConfig, secretKey, signedEvent } from "./helpers";
import { createPluginManager } from "../src/plugins";
import { MemoryEventStore } from "../src/storage";

test("disabled plugins are removed from supported NIPs and reject their declared event kinds", async () => {
  const config = testConfig({ disabledNips: new Set(["50", "59"]) });
  const plugins = createPluginManager(config);
  expect(plugins.supportedNips()).not.toContain(50);

  const giftWrap = signedEvent(secretKey(7), { kind: 1059, tags: [["p", "0".repeat(64)]], content: "x" });
  const result = await plugins.validateEvent(giftWrap, { config, store: new MemoryEventStore(), relayUrls: ["ws://localhost:7777/"] });
  expect(result).toMatchObject({ ok: false, prefix: "unsupported" });
});

test("NIP-70 protected events require authenticated author", async () => {
  const config = testConfig();
  const plugins = createPluginManager(config);
  const event = signedEvent(secretKey(8), { kind: 1, tags: [["-"]], content: "protected" });

  const result = await plugins.validateEvent(event, { config, store: new MemoryEventStore(), relayUrls: ["ws://localhost:7777/"] });
  expect(result).toMatchObject({ ok: false, prefix: "auth-required" });
});

test("disabled NIP-70 rejects protected events instead of accepting them as normal events", async () => {
  const config = testConfig({ disabledNips: new Set(["70"]) });
  const plugins = createPluginManager(config);
  const event = signedEvent(secretKey(11), { kind: 1, tags: [["-"]], content: "protected" });

  const result = await plugins.validateEvent(event, { config, store: new MemoryEventStore(), relayUrls: ["ws://localhost:7777/"] });
  expect(result).toMatchObject({ ok: false, prefix: "unsupported" });
});
