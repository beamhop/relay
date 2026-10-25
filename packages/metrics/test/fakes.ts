import {
  ConfigSchema, EventBus, HookRegistry, createLogger, RuntimeSettingsSchema,
  type BlossomService, type ConnectionSummary, type EventStore, type EventStoreStats, type NostrEvent, type RelayEngine,
  type SettingsService, type Stores,
} from "@beamhop/sdk";
import { createMemoryDb } from "@beamhop/storage";
import { createMetricsService, type MetricsOptions } from "../src";
import type { GeoLookup } from "../src/geo";

export class FakeClock {
  constructor(public ms = Date.UTC(2026, 0, 1, 12, 0, 0)) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
  get sec() {
    return Math.floor(this.ms / 1000);
  }
}

export function fakeEventStore(stats: EventStoreStats = { total: 0, byKind: [], sizeBytes: 0 }) {
  const store = { calls: 0, stats: async () => (store.calls++, stats) };
  return store as unknown as EventStore & { calls: number };
}

export function fakeRelay(conns: Partial<ConnectionSummary>[] = []) {
  const relay = {
    conns,
    connections: () =>
      relay.conns.map((c, i) => ({
        id: String(i), ip: "1.1.1.1", authedPubkeys: [], subscriptions: 0, connectedAt: 0, messagesIn: 0, messagesOut: 0, ...c,
      })),
  };
  return relay as unknown as RelayEngine & { conns: Partial<ConnectionSummary>[] };
}

export function fakeBlossom(count = 0, bytes = 0) {
  const blossom = { calls: 0, stats: async () => (blossom.calls++, { count, bytes, byType: [] }) };
  return blossom as unknown as BlossomService & { calls: number };
}

export function fakeProcess() {
  const p = { user: 0, system: 0, rss: 100 * 1048576, heapUsed: 50 * 1048576 };
  return {
    state: p,
    cpuUsage: () => ({ user: p.user, system: p.system }),
    memoryUsage: () => ({ rss: p.rss, heapUsed: p.heapUsed }),
  };
}

export const fakeGeo = (table: Record<string, { country: string; countryName: string; city?: string; lat: number; lon: number }>): GeoLookup => ({
  enabled: true,
  lookup: (ip) => table[ip],
});

export function ev(kind: number, pubkey = "a".repeat(64)): NostrEvent {
  return { id: Math.random().toString(16).slice(2).padEnd(64, "0"), pubkey, created_at: 0, kind, tags: [], content: "", sig: "" };
}

export async function setup(o: { config?: Record<string, unknown>; relay?: RelayEngine; blossom?: BlossomService; options?: MetricsOptions } = {}) {
  const clock = new FakeClock();
  const db = await createMemoryDb();
  const events = fakeEventStore({ total: 42, byKind: [], sizeBytes: 4096 });
  const bus = new EventBus();
  const settings: SettingsService = {
    get: () => RuntimeSettingsSchema.parse({}),
    update: async () => RuntimeSettingsSchema.parse({}),
    onChange: () => () => {},
  };
  const proc = fakeProcess();
  const relay = o.relay ?? fakeRelay();
  const alerts: unknown[] = [];
  bus.on("alert", (a) => void alerts.push(a));
  const metrics = await createMetricsService(
    {
      config: ConfigSchema.parse(o.config ?? {}),
      stores: { db, events } as unknown as Stores,
      settings,
      hooks: new HookRegistry(),
      bus,
      logger: createLogger("error"),
      relay,
      blossom: o.blossom,
    },
    { now: clock.now, timers: false, process: proc, loopLag: () => 0, memoryLimitBytes: 1024 * 1048576, ...o.options },
  );
  /** advance the fake clock by `sec` seconds, ticking once per second */
  const run = (sec: number, perSecond?: () => void) => {
    for (let i = 0; i < sec; i++) {
      perSecond?.();
      clock.advance(1000);
      metrics.tick();
    }
  };
  return { clock, db, events, bus, proc, relay, metrics, alerts, run };
}
