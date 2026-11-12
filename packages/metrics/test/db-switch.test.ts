import { describe, expect, test } from "bun:test";
import { ConfigSchema, EventBus, HookRegistry, RuntimeSettingsSchema, type Logger, type SettingsService, type Stores } from "@beamhop/sdk";
import { createMemoryDb } from "@beamhop/storage";
import { createMetricsService } from "../src";
import { FakeDbSwitch, pausableDb } from "../../core/test/db-switch-fake";
import { ev, FakeClock, fakeEventStore, fakeProcess, fakeRelay } from "./fakes";

async function setup() {
  const sw = new FakeDbSwitch();
  const clock = new FakeClock();
  const db = pausableDb(await createMemoryDb(), sw);
  const bus = new EventBus();
  const errors: string[] = [];
  const logger: Logger = { debug() {}, info() {}, warn() {}, error: (m) => void errors.push(m), child: () => logger };
  const settings: SettingsService = { get: () => RuntimeSettingsSchema.parse({}), update: async () => RuntimeSettingsSchema.parse({}), onChange: () => () => {} };
  const metrics = await createMetricsService(
    {
      config: ConfigSchema.parse({}),
      stores: { db, events: fakeEventStore(), dbSwitch: sw } as unknown as Stores,
      settings,
      hooks: new HookRegistry(),
      bus,
      logger,
      relay: fakeRelay(),
    },
    { now: clock.now, timers: false, process: fakeProcess(), loopLag: () => 0, memoryLimitBytes: 1024 * 1048576 },
  );
  const accept = (n: number) => {
    for (let i = 0; i < n; i++) bus.emit("event.accepted", { event: ev(1), status: "saved", source: "ws" });
  };
  /** ticks once per second for `sec` seconds */
  const run = (sec: number) => {
    for (let i = 0; i < sec; i++) {
      clock.advance(1000);
      metrics.tick();
    }
  };
  const stored = async () =>
    Number((await db.get<{ v: number }>("SELECT COALESCE(SUM(value), 0) AS v FROM metrics_series WHERE name = 'events_in'"))?.v ?? 0);
  return { sw, metrics, accept, run, stored, errors, db };
}

describe("metrics during a database switch", () => {
  test("flushes refused while paused keep their data (past the retry budget), with no error log", async () => {
    const h = await setup();
    h.accept(3);
    h.run(61);
    h.sw.pause();
    // more refused flushes than the retry budget of ordinary failures
    for (let i = 0; i < 15; i++) await h.metrics.flush();
    expect(await h.stored()).toBe(0);
    expect(h.errors).toEqual([]);
    h.sw.resume();
    await h.metrics.flush();
    expect(await h.stored()).toBe(3);
  });

  test("onBeforeFinalCopy writes buffered rollups to the database before the final copy", async () => {
    const h = await setup();
    expect(h.sw.before.map((x) => x.name)).toContain("metrics");
    h.accept(2);
    h.run(61);
    h.sw.pause();
    await h.metrics.flush(); // refused
    expect(await h.stored()).toBe(0);
    await h.sw.runBeforeFinalCopy();
    expect(await h.stored()).toBe(2);
    await h.sw.runSwapped();
    h.sw.resume();
  });

  test("stop() unregisters the hooks", async () => {
    const h = await setup();
    await h.metrics.start();
    await h.metrics.stop();
    expect(h.sw.before).toHaveLength(0);
    expect(h.sw.swapped).toHaveLength(0);
  });
});
