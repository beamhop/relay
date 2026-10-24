import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EventBus, HookRegistry, createLogger, type NostrEvent } from "@beamhop/sdk";
import { createPluginManager, type ServerPluginManager } from "../src/plugins/manager";
import { discoverPlugins } from "../src/plugins/discovery";
import { stubMetrics, stubRelay, stubSettings, stubStores, testConfig } from "./stubs";
import { calls } from "./fixtures/plugins/good/main";

const dir = join(import.meta.dir, "fixtures/plugins");
const ev = (content: string) => ({ id: "1", pubkey: "p", created_at: 0, kind: 1, tags: [], content, sig: "s" }) as NostrEvent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pm: ServerPluginManager;
let hooks: HookRegistry;
let bus: EventBus;
let stores: ReturnType<typeof stubStores>;

beforeAll(async () => {
  hooks = new HookRegistry();
  bus = new EventBus();
  stores = stubStores();
  await stores.kv.set("plugins", "enabled:broken", true);
  pm = createPluginManager({
    config: testConfig({ plugins: { dir } }),
    stores, settings: stubSettings(), hooks, bus, logger: createLogger("error"), relay: stubRelay(), metrics: stubMetrics(),
    defaultEnabled: ["single"], autoDiscoverNpm: false,
  });
  await pm.start();
});
afterAll(() => pm.stop());

describe("discovery", () => {
  test("finds folders, package main, single files; skips _ and . prefixed", () => {
    const found = discoverPlugins({ dir, packages: [], autoDiscoverNpm: false });
    expect(found.map((f) => f.id).sort()).toEqual(["bad-shape", "beamhop-plugin-good", "broken-setup", "single"]);
    expect(found.find((f) => f.id === "beamhop-plugin-good")!.entry).toEndWith("good/main.ts");
  });
});

describe("plugin manager", () => {
  test("list reports status, errors (load + setup) and default enable", () => {
    const byName = Object.fromEntries(pm.list().map((p) => [p.name, p]));
    expect(byName.good).toMatchObject({ version: "1.2.3", source: "local", enabled: false, status: "disabled" });
    expect(byName.single).toMatchObject({ enabled: true, status: "running" });
    expect(byName.broken).toMatchObject({ enabled: true, status: "error", error: "boom in setup" });
    expect(byName["bad-shape"]).toMatchObject({ status: "error" });
    expect(byName["bad-shape"].error).toContain("version");
    // failed setup cleaned up its hooks
    expect(hooks.counts.write).toBe(0);
    expect(byName.good.settingsSchema).toMatchObject({ type: "object", properties: { word: { type: "string" } } });
    expect(byName.good.uiUrl).toBe("/admin/plugins-ui/good.js?v=1.2.3");
  });

  test("enable registers hooks, routes, jobs, listeners; runs migrations; audits", async () => {
    await pm.enable("good", "admin1");
    expect(pm.get("good")).toMatchObject({ enabled: true, status: "running" });
    expect(stores.db.migrations["plugin:good"]).toEqual(["001"]);
    expect(stores.kvData.get("plugins/enabled:good")).toBe(true);
    expect(stores.auditEntries.at(-1)).toMatchObject({ actor: "admin1", action: "plugin.enable", target: "good" });

    expect((await hooks.runWrite(ev("buy spam now"), { source: "ws" })).result).toBe("reject");
    expect((await hooks.runWrite(ev("hello"), { source: "ws" })).result).toBe("next");

    const pub = await pm.handlePublic("good", new Request("http://x/plugins/good/hello?q=1"));
    expect(await pub!.json()).toEqual({ hello: "good", path: "/hello" });

    const admin = await pm.adminRoutes.fetch(new Request("http://x/good/stats"));
    expect(await admin.json()).toEqual({ word: "spam" });

    bus.emit("connection.open", { connId: "c", ip: "1", at: 0 });
    expect(calls.events).toBe(1);
    await sleep(250);
    expect(calls.jobs).toBeGreaterThan(0);

    const ui = pm.uiBundle("good")!;
    expect(ui.headers.get("content-type")).toContain("text/javascript");
    expect(await ui.text()).toContain("register");
  });

  test("settings validated, persisted and pushed to running plugin", async () => {
    await expect(pm.updateSettings("good", { word: "", limit: 99 }, "admin1")).rejects.toThrow(/invalid settings/);
    const saved = await pm.updateSettings("good", { word: "casino" }, "admin1");
    expect(saved).toEqual({ word: "casino", limit: 3 });
    expect(await pm.getSettings("good")).toEqual({ word: "casino", limit: 3 });
    expect(stores.kvData.get("plugins/settings:good")).toEqual({ word: "casino", limit: 3 });
    expect((await hooks.runWrite(ev("casino!"), { source: "ws" })).result).toBe("reject");
    expect((await hooks.runWrite(ev("spam"), { source: "ws" })).result).toBe("next");
    expect(stores.auditEntries.at(-1)).toMatchObject({ action: "plugin.settings" });
  });

  test("disable tears down and removes hooks/routes/jobs/listeners (hot)", async () => {
    await pm.disable("good", "admin1");
    expect(calls.teardown).toBe(1);
    expect(pm.get("good")).toMatchObject({ enabled: false, status: "disabled" });
    expect(hooks.counts.write).toBe(0);
    expect(await pm.handlePublic("good", new Request("http://x/plugins/good/hello"))).toBeUndefined();
    expect((await pm.adminRoutes.fetch(new Request("http://x/good/stats"))).status).toBe(404);
    expect(pm.uiBundle("good")).toBeUndefined(); // the bundle route is unauthenticated: running plugins only
    const jobs = calls.jobs;
    bus.emit("connection.open", { connId: "c", ip: "1", at: 0 });
    await sleep(250);
    expect(calls.jobs).toBe(jobs);
    expect(calls.events).toBe(1);
    expect(stores.kvData.get("plugins/enabled:good")).toBe(false);

    // re-enable without restart, persisted settings are used
    await pm.enable("good", "admin1");
    expect(calls.setup).toBe(2);
    expect((await hooks.runWrite(ev("casino"), { source: "ws" })).result).toBe("reject");
    expect(stores.db.migrations["plugin:good"]).toEqual(["001"]);
  });

  test("enabling a broken plugin reports error but does not throw away the server", async () => {
    await expect(pm.enable("broken", "admin1")).rejects.toThrow(/boom in setup/);
    expect(pm.get("broken")!.status).toBe("error");
    await expect(pm.enable("bad-shape", "admin1")).rejects.toThrow(/failed to load/);
    await expect(pm.enable("missing", "admin1")).rejects.toThrow(/not found/);
  });

  test("stop() tears down without changing persisted state", async () => {
    await pm.stop();
    expect(pm.get("good")!.status).toBe("disabled");
    expect(stores.kvData.get("plugins/enabled:good")).toBe(true);
  });
});
