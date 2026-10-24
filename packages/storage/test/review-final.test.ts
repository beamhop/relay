import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "@beamhop/sdk";
import { createSettingsService, createTestStores, type StorageStores } from "../src";
import { toFts5Query } from "../src/events";
import { salvageSettings, SETTINGS_KEY, SETTINGS_NAMESPACE } from "../src/settings";

let stores: StorageStores;
beforeEach(async () => {
  stores = await createTestStores();
});
afterEach(async () => {
  await stores.close();
});

const LOCKED = { mode: "whitelist", authForRead: true, authForWrite: true, allowInboundToMembers: false };

describe("settings fail closed", () => {
  test("a corrupted (non-object) settings blob is locked down, not public defaults", () => {
    for (const stored of ["garbage", [1, 2], 42, true]) {
      const { settings, dropped } = salvageSettings(stored);
      expect(settings.access).toMatchObject(LOCKED);
      expect(dropped).toEqual(["(all)"]);
    }
    expect(salvageSettings(undefined).dropped).toEqual([]); // nothing stored yet: defaults
  });

  test("an invalid access mode can't leave reads public", () => {
    const { settings, dropped } = salvageSettings({ access: { mode: "private", authForRead: false } });
    expect(settings.access).toMatchObject(LOCKED);
    expect(dropped).toEqual(["access.mode"]);
  });

  test("the alert is kept in the audit log and can be re-emitted once listeners exist", async () => {
    await stores.kv.set(SETTINGS_NAMESPACE, SETTINGS_KEY, { access: { mode: "private" } });
    const service = await createSettingsService(stores, new EventBus());
    expect(service.get().access).toMatchObject(LOCKED);
    const entries = await stores.audit.list({ action: "settings.invalid" });
    expect(entries.length).toBe(1);
    const alert = service.takeStartupAlert();
    expect(alert?.level).toBe("critical");
    expect(service.takeStartupAlert()).toBeUndefined(); // once
  });
});

describe("full-text search terms", () => {
  test("short last terms match whole words; only short CJK terms stay prefix matches", () => {
    expect(toFts5Query(["ab"])).toBe('"ab"');
    expect(toFts5Query(["abc"])).toBe('"abc"*');
    expect(toFts5Query(["日本"])).toBe('"日本"*');
    expect(toFts5Query(["한"])).toBe('"한"*');
    // diacritic folding would turn "é"* into e*, matching most of the index
    expect(toFts5Query(["é"])).toBe('"é"');
    expect(toFts5Query(["жа"])).toBe('"жа"');
    expect(toFts5Query(["éle"])).toBe('"éle"*');
  });

  test("a short CJK query finds text where it starts a longer run of CJK characters", async () => {
    const { finalizeEvent, generateSecretKey } = await import("nostr-tools/pure");
    const ev = finalizeEvent({ kind: 1, content: "日本語のテキスト", tags: [], created_at: Math.floor(Date.now() / 1000) }, generateSecretKey());
    await stores.events.save(ev);
    const found = await stores.events.query([{ search: "日本", limit: 10 }]);
    expect(found.map((e) => e.id)).toEqual([ev.id]);
  });
});
