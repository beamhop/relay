import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EventBus, HookRegistry, createLogger, type BeamhopPlugin, type PluginContext } from "@beamhop/sdk";
import { createPluginManager, type PluginManagerDeps } from "../src/plugins/manager";
import { stubMetrics, stubRelay, stubSettings, stubStores, testConfig } from "./stubs";

const race = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

function manager(plugins: BeamhopPlugin[], over: Partial<PluginManagerDeps> = {}) {
  const hooks = new HookRegistry();
  const bus = new EventBus();
  const stores = stubStores();
  const pm = createPluginManager({
    config: testConfig(), stores, settings: stubSettings(), hooks, bus, logger: createLogger("error"), relay: stubRelay(), metrics: stubMetrics(),
    plugins: plugins.map((plugin) => ({ plugin })), defaultEnabled: plugins.map((p) => p.name), timeouts: { setupMs: 100, teardownMs: 100, importMs: 100 },
    ...over,
  });
  return { pm, hooks, bus, stores };
}

describe("setup timeout", () => {
  test("a plugin whose setup hangs doesn't block start(); it is marked error and its hooks are removed", async () => {
    const plugin = {
      name: "hang", version: "1.0.0",
      async setup(ctx: PluginContext) {
        ctx.hooks.onWrite(async () => ({ action: "reject", reason: "hang plugin" }));
        await new Promise(() => {});
      },
    };
    const { pm, hooks } = manager([plugin]);
    expect(await race(pm.start(), 1000)).not.toBe("timeout");
    expect(pm.get("hang")).toMatchObject({ status: "error" });
    expect(pm.get("hang")!.error).toContain("timed out");
    expect(hooks.counts.write).toBe(0);
  });

  test("registrations made by a setup that finishes after it was abandoned are disposed at once", async () => {
    const gate = deferred();
    let jobRuns = 0;
    let listenerCalls = 0;
    let offWrite: (() => void) | undefined;
    const plugin = {
      name: "late", version: "1.0.0",
      async setup(ctx: PluginContext) {
        await gate.promise;
        offWrite = ctx.hooks.onWrite(() => ({ action: "reject", reason: "late" }));
        ctx.hooks.onQuery(() => ({ reject: "late" }));
        ctx.on("alert", () => void listenerCalls++);
        ctx.bus.on("alert", () => void listenerCalls++);
        ctx.jobs.every("tick", 100, () => void jobRuns++);
        ctx.http.get("/", (c) => c.text("late"));
      },
    };
    const { pm, hooks, bus } = manager([plugin]);
    await pm.start();
    expect(pm.get("late")!.status).toBe("error");
    gate.resolve();
    await Bun.sleep(250);
    expect(hooks.counts).toEqual({ write: 0, query: 0, visibility: 0, blob: 0 });
    bus.emit("alert", { level: "info", title: "t", message: "m" });
    expect(listenerCalls).toBe(0);
    expect(jobRuns).toBe(0);
    expect(() => offWrite?.()).not.toThrow();
    expect(await pm.handlePublic("late", new Request("http://x/plugins/late/"))).toBeUndefined();
  });

  test("disable is not queued behind a hung enable and leaves nothing live", async () => {
    let teardowns = 0;
    const plugin = {
      name: "hang", version: "1.0.0",
      async setup(ctx: PluginContext) {
        ctx.hooks.onWrite(async () => ({ action: "reject", reason: "hang plugin" }));
        await new Promise(() => {});
      },
      teardown() {
        teardowns++;
      },
    };
    const { pm, hooks, stores } = manager([plugin], { defaultEnabled: [], timeouts: { setupMs: 30_000 } });
    await pm.start();
    const enabling = pm.enable("hang", "admin").catch((e: Error) => e);
    await Bun.sleep(10);
    expect(await race(pm.disable("hang", "admin"), 300)).not.toBe("timeout");
    expect(await enabling).toMatchObject({ status: 409 });
    expect(pm.get("hang")).toMatchObject({ status: "disabled", enabled: false });
    expect(stores.kvData.get("plugins/enabled:hang")).toBe(false);
    expect(hooks.counts.write).toBe(0);
    expect(teardowns).toBe(1);
  });

  test("enabled=true is persisted only after setup succeeded", async () => {
    let fail = true;
    const plugin = {
      name: "flaky", version: "1.0.0",
      setup() {
        if (fail) throw new Error("not configured");
      },
    };
    const { pm, stores } = manager([plugin], { defaultEnabled: [] });
    await pm.start();
    await expect(pm.enable("flaky", "admin")).rejects.toThrow("not configured");
    expect(stores.kvData.has("plugins/enabled:flaky")).toBe(false);
    expect(pm.get("flaky")!.enabled).toBe(false);
    fail = false;
    await pm.enable("flaky", "admin");
    expect(stores.kvData.get("plugins/enabled:flaky")).toBe(true);
    expect(pm.get("flaky")).toMatchObject({ enabled: true, status: "running" });
  });
});

describe("teardown and import timeouts", () => {
  test("a hung teardown doesn't block disable or stop", async () => {
    const plugin = { name: "slowdown", version: "1.0.0", setup() {}, teardown: () => new Promise<void>(() => {}) };
    const { pm } = manager([plugin]);
    await pm.start();
    expect(await race(pm.disable("slowdown", "admin"), 1000)).not.toBe("timeout");
    expect(pm.get("slowdown")!.status).toBe("disabled");
    await pm.enable("slowdown", "admin");
    expect(await race(pm.stop(), 1000)).not.toBe("timeout");
  });

  test("a plugin module whose top-level code hangs is reported as failed to load", async () => {
    const { pm } = manager([], { plugins: undefined, config: testConfig({ plugins: { dir: join(import.meta.dir, "fixtures/plugins-hang") } }), autoDiscoverNpm: false });
    expect(await race(pm.start(), 1000)).not.toBe("timeout");
    const [p] = pm.list();
    expect(p).toMatchObject({ name: "hang", status: "error" });
    expect(p.error).toContain("timed out");
  });
});

describe("scoped bus, jobs and settings listeners", () => {
  test("a bus listener registered with ctx.bus.on is removed on disable", async () => {
    const bus = new EventBus();
    let seen = 0;
    const plugin = { name: "listener", version: "1.0.0", setup: (ctx: PluginContext) => void ctx.bus.on("alert", () => void seen++) };
    const { pm } = manager([plugin], { bus });
    await pm.start();
    bus.emit("alert", { level: "info", title: "t", message: "m" });
    await pm.disable("listener", "admin");
    bus.emit("alert", { level: "info", title: "t", message: "m" });
    expect(seen).toBe(1);
  });

  test("plugins may raise alerts but not emit core events", async () => {
    const bus = new EventBus();
    const alerts: string[] = [];
    bus.on("alert", (a) => void alerts.push(a.title));
    let coreEmit: unknown;
    const plugin = {
      name: "emitter", version: "1.0.0",
      setup(ctx: PluginContext) {
        ctx.bus.emit("alert", { level: "warning", title: "from plugin", message: "m" });
        try {
          (ctx.bus.emit as (n: string, p: unknown) => void)("user.deleted", { pubkey: "p", actor: "x" });
        } catch (err) {
          coreEmit = err;
        }
      },
    };
    const { pm } = manager([plugin], { bus });
    await pm.start();
    expect(alerts).toEqual(["from plugin"]);
    expect(coreEmit).toBeInstanceOf(Error);
  });

  test("disable waits for a job run in progress before teardown", async () => {
    const order: string[] = [];
    const plugin = {
      name: "worker", version: "1.0.0",
      setup(ctx: PluginContext) {
        ctx.jobs.every("work", 100, async () => {
          order.push("job start");
          await Bun.sleep(50);
          order.push("job end");
        });
      },
      teardown: () => void order.push("teardown"),
    };
    const { pm } = manager([plugin], { timeouts: { teardownMs: 1000 } });
    await pm.start();
    await Bun.sleep(120);
    await pm.disable("worker", "admin");
    expect(order).toEqual(["job start", "job end", "teardown"]);
  });

  test("a rejecting async settings listener is caught", async () => {
    let called = 0;
    const plugin = {
      name: "settings", version: "1.0.0",
      setup(ctx: PluginContext) {
        ctx.settings.onChange(async () => {
          called++;
          throw new Error("listener bug");
        });
      },
    };
    const { pm } = manager([plugin]);
    await pm.start();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await pm.updateSettings("settings", { a: 1 }, "admin");
      await Bun.sleep(5);
      expect(called).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
