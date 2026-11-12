import { describe, expect, test } from "bun:test";
import { EventBus, HookRegistry, createLogger, DbSwitchingError, type BeamhopPlugin, type DbSwappedEvent, type Logger } from "@beamhop/sdk";
import { createBeamhop } from "../src/app";
import { INSTANCES_NS, startInstanceHeartbeat } from "../src/instances";
import { createPluginManager } from "../src/plugins/manager";
import { FakeDbSwitch } from "../../core/test/db-switch-fake";
import { stubFactories, stubMetrics, stubRelay, stubSettings, stubStores, testConfig } from "./stubs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recordingLogger() {
  const lines: { level: string; msg: string }[] = [];
  const logger: Logger = {
    debug: (msg) => void lines.push({ level: "debug", msg }),
    info: (msg) => void lines.push({ level: "info", msg }),
    warn: (msg) => void lines.push({ level: "warn", msg }),
    error: (msg) => void lines.push({ level: "error", msg }),
    child: () => logger,
  };
  return { logger, lines };
}

describe("/health during a database switch", () => {
  test("readiness stays 200 with status \"switching\" while writes are paused; liveness exposes it too", async () => {
    const sw = new FakeDbSwitch();
    const f = stubFactories();
    f.stores.dbSwitch = sw;
    const bh = await createBeamhop(testConfig(), { factories: f });
    await bh.start();
    try {
      let res = await bh.fetch(new Request("http://x/health"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, status: "ready" });

      sw.pause();
      res = await bh.fetch(new Request("http://x/health"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, status: "switching" });
      const live = await bh.fetch(new Request("http://x/health/live"));
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ ok: true, database: "switching" });

      sw.resume();
      expect(await (await bh.fetch(new Request("http://x/health"))).json()).toMatchObject({ status: "ready" });
    } finally {
      await bh.stop();
    }
  });

  test("the instance heartbeat is exposed and removed at shutdown before the database closes", async () => {
    const f = stubFactories();
    const bh = await createBeamhop(testConfig(), { factories: f });
    await bh.instances.beat();
    const list = await bh.instances.instances();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: bh.instances.id, self: true });
    await bh.stop();
    expect(f.stores.kvData.has(`${INSTANCES_NS}/instances/${bh.instances.id}`)).toBe(false);
  });
});

describe("plugins: onDatabaseSwapped", () => {
  test("each running plugin's hook runs within its budget; a throw or a timeout is logged and doesn't fail the switch", async () => {
    const sw = new FakeDbSwitch();
    const stores = { ...stubStores(), dbSwitch: sw };
    const seen: DbSwappedEvent[] = [];
    const plugins: BeamhopPlugin[] = [
      { name: "good", version: "1.0.0", async setup() {}, onDatabaseSwapped: (e) => void seen.push(e) },
      { name: "thrower", version: "1.0.0", async setup() {}, onDatabaseSwapped: () => { throw new Error("boom"); } },
      { name: "slow", version: "1.0.0", async setup() {}, onDatabaseSwapped: () => new Promise<void>(() => {}) },
      { name: "plain", version: "1.0.0", async setup() {} },
      { name: "off", version: "1.0.0", async setup() {}, onDatabaseSwapped: () => void seen.push({ from: "postgres", to: "postgres" }) },
    ];
    const { logger, lines } = recordingLogger();
    const pm = createPluginManager({
      config: testConfig(), stores, settings: stubSettings(), hooks: new HookRegistry(), bus: new EventBus(), logger,
      relay: stubRelay(), metrics: stubMetrics(), plugins: plugins.map((plugin) => ({ plugin })),
      defaultEnabled: ["good", "thrower", "slow", "plain"],
      timeouts: { databaseSwappedMs: 50 },
    });
    await pm.start();
    expect(sw.swapped.filter((h) => h.name === "plugins")).toHaveLength(1);
    const started = Date.now();
    await sw.runSwapped({ from: "sqlite", to: "postgres" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen).toEqual([{ from: "sqlite", to: "postgres" }]);
    const warns = lines.filter((l) => l.level === "warn").map((l) => l.msg);
    expect(warns.some((m) => m.includes("onDatabaseSwapped of thrower failed"))).toBe(true);
    expect(warns.some((m) => m.includes("onDatabaseSwapped of slow failed"))).toBe(true);
    await pm.stop();
    expect(sw.swapped).toHaveLength(0);
  });
});

describe("instance heartbeat", () => {
  test("instances() lists fresh heartbeats (self marked) and leaves out stale ones; stop() removes its own", async () => {
    const stores = stubStores();
    let now = 1_700_000_000_000;
    const a = startInstanceHeartbeat({ kv: stores.kv, logger: createLogger("error"), id: "a", host: "host-a", now: () => now, intervalMs: 60_000 });
    const b = startInstanceHeartbeat({ kv: stores.kv, logger: createLogger("error"), id: "b", host: "host-b", now: () => now, intervalMs: 60_000 });
    await a.beat();
    await b.beat();
    expect(await a.instances()).toEqual([
      { id: "a", seenAt: now / 1000, host: "host-a", self: true },
      { id: "b", seenAt: now / 1000, host: "host-b", self: false },
    ]);
    // b stops beating: 91 s later it no longer counts as running (a beats again)
    now += 91_000;
    await a.beat();
    expect((await a.instances()).map((i) => i.id)).toEqual(["a"]);
    // b's own view still includes itself
    expect((await b.instances()).find((i) => i.self)?.id).toBe("b");
    await a.stop();
    expect(stores.kvData.has(`${INSTANCES_NS}/instances/a`)).toBe(false);
    await b.stop();
  });

  test("beats refused during a database switch are swallowed (no warning)", async () => {
    const stores = stubStores();
    const { logger, lines } = recordingLogger();
    stores.kv.set = async () => {
      throw new DbSwitchingError();
    };
    const hb = startInstanceHeartbeat({ kv: stores.kv, logger, intervalMs: 60_000 });
    await hb.beat();
    await sleep(5);
    expect(lines.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
    await hb.stop();
  });
});
