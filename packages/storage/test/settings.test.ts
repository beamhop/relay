import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventBus, type RuntimeSettings } from "@beamhop/sdk";
import { createSettingsService, createTestStores, deepMerge, type StorageStores } from "../src";

let stores: StorageStores;
beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

test("deepMerge replaces arrays and merges objects", () => {
  expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, d: undefined })).toEqual({ a: { b: 1, c: [3] }, d: 1 });
});

test("defaults, update merge, persistence, audit, bus + listeners", async () => {
  const bus = new EventBus();
  const settings = await createSettingsService(stores, bus);
  expect(settings.get().info.name).toBe("beamhop relay");
  expect(settings.get().limits.maxLimit).toBe(500);

  const busEvents: string[] = [];
  bus.on("settings.changed", (e) => busEvents.push(e.actor));
  const seen: RuntimeSettings[] = [];
  settings.onChange((s) => seen.push(s));

  const next = await settings.update({ info: { name: "My relay" }, moderation: { kindBlocklist: [4, 5] } }, "admin1");
  expect(next.info.name).toBe("My relay");
  expect(next.info.description).toBe("A beamhop nostr relay");
  await settings.update({ moderation: { kindBlocklist: [7] } }, "admin1");
  expect(settings.get().moderation.kindBlocklist).toEqual([7]);
  expect(busEvents).toEqual(["admin1", "admin1"]);
  expect(seen.length).toBe(2);

  // no-op update: nothing emitted / audited
  await settings.update({ info: { name: "My relay" } }, "admin1");
  expect(busEvents.length).toBe(2);
  const audit = await stores.audit.list({ action: "settings.update" });
  expect(audit.length).toBe(2);
  expect(audit[1].details.sections).toEqual(["info", "moderation"]);
  expect(audit[0].actor).toBe("admin1");

  // a fresh service loads persisted values
  const again = await createSettingsService(stores, new EventBus());
  expect(again.get().info.name).toBe("My relay");
  expect(again.get().moderation.kindBlocklist).toEqual([7]);
});

test("invalid updates are rejected and do not change state", async () => {
  const settings = await createSettingsService(stores, new EventBus());
  await expect(settings.update({ access: { mode: "nope" as never } }, "x")).rejects.toThrow();
  await expect(settings.update({ limits: { maxLimit: "1" as never } }, "x")).rejects.toThrow();
  expect(settings.get().access.mode).toBe("public");
  expect(await stores.kv.get("settings", "runtime")).toBeUndefined();
});

test("invalid stored settings fall back to defaults", async () => {
  await stores.kv.set("settings", "runtime", { access: { mode: 42 } });
  const settings = await createSettingsService(stores, new EventBus());
  expect(settings.get().access.mode).toBe("public");
});
