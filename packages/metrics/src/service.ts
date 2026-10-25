import type {
  BlossomService, BusEvents, CoreDeps, CreateMetrics, LiveSnapshot, MetricName, MetricsService, RelayEngine, TimeRange,
} from "@beamhop/sdk";
import type { Counter, Gauge, Attributes } from "@opentelemetry/api";
import { AlertEvaluator, defaultAlertOptions, type AlertOptions } from "./alerts";
import { Collector, type Totals } from "./collector";
import { openGeoIp, type GeoLookup } from "./geo";
import { setupOtel, type OtelHandle } from "./otel";
import { detectMemoryLimit, LoopLagMonitor, realProcess, type ProcessSampler } from "./process";
import { Rollup } from "./rollup";
import { migrations } from "./schema";

export type MetricsDeps = CoreDeps & { relay: RelayEngine; blossom?: BlossomService };

export interface MetricsOptions {
  /** clock in unix ms (inject for tests) */
  now?: () => number;
  /** run internal timers on start() (default true). Tests drive `tick()`/`flush()` manually. */
  timers?: boolean;
  process?: ProcessSampler;
  /** returns event-loop lag (ms) since the previous call; defaults to a timer-drift monitor */
  loopLag?: () => number;
  /** override GeoIP lookup (tests) */
  geo?: GeoLookup;
  memoryLimitBytes?: number;
  alerts?: Partial<AlertOptions>;
  tickIntervalMs?: number;
  flushIntervalMs?: number;
  /** refresh interval for expensive store stats (event count / db size / media) */
  statsIntervalMs?: number;
  /** after stored events or blobs change, store stats refresh this soon instead of waiting out statsIntervalMs */
  statsDirtyMs?: number;
  /** max distinct pubkeys tracked per flush interval (memory bound) */
  maxPubkeysPerBucket?: number;
  /** pubkeys kept per closed hour in metrics_pubkeys */
  topPubkeysPerHour?: number;
  /** distinct rejection (code, reason) pairs per hour; the rest count as "(other)" (memory + table bound) */
  maxRejectionReasonsPerHour?: number;
  version?: string;
}

/** Internals exposed for the server (Prometheus) and tests. */
export interface MetricsServiceImpl extends MetricsService {
  tick(): void;
  flush(): Promise<void>;
  prune(): Promise<number>;
  refreshStats(): Promise<void>;
  totals(): Totals;
  customMetrics(): { counters: Map<string, { help?: string; value: number }>; gauges: Map<string, { help?: string; value: number }> };
}

const DAY_MS = 86_400_000;

export async function createMetricsService(deps: MetricsDeps, opts: MetricsOptions = {}): Promise<MetricsServiceImpl> {
  const { config, stores, bus, relay, blossom } = deps;
  const logger = deps.logger.child("metrics");
  const now = opts.now ?? Date.now;
  const proc = opts.process ?? realProcess;
  const tickMs = opts.tickIntervalMs ?? 1000;
  const flushMs = opts.flushIntervalMs ?? 60_000;
  const statsMs = opts.statsIntervalMs ?? 60_000;
  const statsDirtyMs = Math.min(opts.statsDirtyMs ?? 5_000, statsMs);
  const retentionDays = config.metrics.retentionDays;

  await stores.db.migrate("metrics", migrations);
  const geo = opts.geo ?? (await openGeoIp(config.metrics.geoipDbPath, logger));

  const startedAt = now();
  const rollup = new Rollup(stores.db, Math.floor(startedAt / 1000), {
    maxPubkeysPerBucket: opts.maxPubkeysPerBucket ?? 10_000,
    topPubkeysPerHour: opts.topPubkeysPerHour ?? 1000,
    maxRejectionReasonsPerHour: opts.maxRejectionReasonsPerHour,
    onDropped: (message) => logger.error(message),
  });
  const collector = new Collector(startedAt, rollup, geo);
  collector.attach(bus);

  const lagMonitor = opts.loopLag ? undefined : new LoopLagMonitor();
  const loopLag = opts.loopLag ?? (() => lagMonitor!.take());
  const alerts = new AlertEvaluator(
    { ...defaultAlertOptions, memoryLimitBytes: detectMemoryLimit(opts.memoryLimitBytes), ...opts.alerts },
    (a: BusEvents["alert"]) => {
      logger.warn(`alert: ${a.title}`, { level: a.level, message: a.message });
      bus.emit("alert", a);
    },
  );

  const stats = { totalEvents: 0, dbBytes: 0, mediaBytes: 0, mediaCount: 0, at: -Infinity, inflight: false, dirty: false };
  // stored events / blobs changed: the totals are stale, so refresh sooner than statsMs
  let statsUnsubs: (() => void)[] = [];
  const watchStores = () => {
    if (statsUnsubs.length) return;
    const markDirty = () => void (stats.dirty = true);
    statsUnsubs = [
      bus.on("event.accepted", (p) => p.status !== "ephemeral" && markDirty()),
      bus.on("event.deleted", markDirty),
      bus.on("blob.uploaded", markDirty),
      bus.on("blob.deleted", markDirty),
    ];
  };
  watchStores();
  let lastCpu = proc.cpuUsage();
  let lastCpuAt = startedAt;
  const listeners = new Set<(s: LiveSnapshot) => void>();
  let snap: LiveSnapshot = emptySnapshot(startedAt);

  const customCounters = new Map<string, { help?: string; value: number; otel?: Counter }>();
  const customGauges = new Map<string, { help?: string; value: number; otel?: Gauge }>();
  let otel: OtelHandle | undefined;
  const timers: ReturnType<typeof setInterval>[] = [];
  let running = false;
  /** stats refreshes and prunes in progress: stop() awaits them before the last flush (the database closes next) */
  const inBackground = new Set<Promise<unknown>>();
  const background = (label: string, fn: () => Promise<unknown>) => {
    const p = fn().catch(() => {});
    inBackground.add(p);
    void p.then(() => inBackground.delete(p));
    deps.tasks?.track(label, p);
  };

  async function refreshStats() {
    if (stats.inflight) return;
    stats.inflight = true;
    stats.dirty = false;
    stats.at = now();
    try {
      const [ev, media] = await Promise.all([
        stores.events.stats().catch((err) => {
          logger.warn("event store stats failed", { error: String(err) });
          return undefined;
        }),
        blossom?.stats().catch((err) => {
          logger.warn("blossom stats failed", { error: String(err) });
          return undefined;
        }),
      ]);
      if (ev) {
        stats.totalEvents = ev.total;
        stats.dbBytes = ev.sizeBytes;
      }
      if (media) {
        stats.mediaBytes = media.bytes;
        stats.mediaCount = media.count;
      }
    } finally {
      stats.inflight = false;
    }
  }

  function tick() {
    const t = now();
    collector.roll(t);

    let connections = 0;
    let authed = 0;
    let subscriptions = 0;
    try {
      for (const c of relay.connections()) {
        connections++;
        if (c.authedPubkeys.length) authed++;
        subscriptions += c.subscriptions;
      }
    } catch (err) {
      logger.debug("relay.connections() failed", { error: String(err) });
    }

    const cpu = proc.cpuUsage();
    const elapsedUs = (t - lastCpuAt) * 1000;
    const cpuPercent = elapsedUs > 0 ? ((cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / elapsedUs) * 100 : 0;
    lastCpu = cpu;
    lastCpuAt = t;
    const mem = proc.memoryUsage();
    const lag = loopLag();
    const [p50, p95, p99] = collector.latency.percentiles(t, 60_000, [50, 95, 99]);

    if (t - stats.at >= (stats.dirty ? statsDirtyMs : statsMs)) background("metrics stats", refreshStats);

    snap = {
      at: Math.floor(t / 1000),
      uptimeSec: Math.floor((t - startedAt) / 1000),
      connections,
      authedConnections: authed,
      subscriptions,
      eventsInPerSec: round2(collector.eventsIn.rate()),
      eventsOutPerSec: round2(collector.eventsOut.rate()),
      reqPerSec: round2(collector.req.rate()),
      rejectedPerSec: round2(collector.rejected.rate()),
      totalEvents: stats.totalEvents,
      dbBytes: stats.dbBytes,
      mediaBytes: stats.mediaBytes,
      mediaCount: stats.mediaCount,
      cpuPercent: round2(Math.max(0, cpuPercent)),
      memoryRss: mem.rss,
      heapUsed: mem.heapUsed,
      loopLagMs: lag,
      reqLatencyP50: round2(p50),
      reqLatencyP95: round2(p95),
      reqLatencyP99: round2(p99),
    };

    const m = rollup.current;
    m.sample("connections", connections);
    m.sample("subscriptions", subscriptions);
    m.sample("cpu", snap.cpuPercent);
    m.sample("memory", mem.rss);
    m.sample("heap", mem.heapUsed);
    m.sample("loop_lag", lag);
    if (collector.req.last || p95) m.sample("req_latency_p95", snap.reqLatencyP95);
    rollup.advance(snap.at);

    alerts.evaluate(t, snap, collector.rejected.lastRate());
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (err) {
        logger.error("snapshot listener failed", { error: String(err) });
      }
    }
  }

  async function flush() {
    try {
      await rollup.flush();
    } catch (err) {
      logger.error("metrics flush failed", { error: String(err) });
    }
  }

  async function prune() {
    const before = Math.floor((now() - retentionDays * DAY_MS) / 1000);
    try {
      const n = await rollup.prune(before);
      if (n) logger.info("pruned old metrics", { rows: n, retentionDays });
      return n;
    } catch (err) {
      logger.error("metrics prune failed", { error: String(err) });
      return 0;
    }
  }

  const every = (ms: number, fn: () => unknown) => {
    const t = setInterval(fn, ms);
    (t as { unref?: () => void }).unref?.();
    timers.push(t);
  };

  const service: MetricsServiceImpl = {
    async start() {
      if (running) return;
      running = true;
      collector.attach(bus);
      watchStores();
      if (config.metrics.otel.enabled) {
        otel = await setupOtel(config.metrics.otel, () => snap, () => collector.totals, logger, opts.version);
        if (otel) {
          for (const [name, c] of customCounters) c.otel ??= otel.meter.createCounter(name, { description: c.help });
          for (const [name, g] of customGauges) g.otel ??= otel.meter.createGauge(name, { description: g.help });
        }
      }
      if (opts.timers === false) return;
      lagMonitor?.start();
      background("metrics stats", refreshStats);
      background("metrics prune", prune);
      every(tickMs, tick);
      every(flushMs, flush);
      every(DAY_MS, () => background("metrics prune", prune));
    },
    async stop() {
      if (!running) return;
      running = false;
      for (const t of timers.splice(0)) clearInterval(t);
      lagMonitor?.stop();
      collector.detach();
      for (const u of statsUnsubs.splice(0)) u();
      await Promise.all(inBackground);
      collector.roll(now());
      rollup.closeCurrent(Math.floor(now() / 1000));
      await flush();
      await otel?.shutdown();
      otel = undefined;
    },
    snapshot: () => snap,
    onSnapshot(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    series: (name: MetricName, range: TimeRange) => rollup.series(name, range),
    kinds: (range) => rollup.kinds(range),
    topPubkeys: (range, limit) => rollup.topPubkeys(range, limit),
    rejections: (range) => rollup.rejections(range),
    geo: (range) => (geo.enabled ? rollup.geo(range) : Promise.resolve([])),
    lookupIp(ip) {
      const g = geo.lookup(ip);
      return g && { country: g.country, city: g.city, lat: g.lat, lon: g.lon };
    },
    counter(name, help) {
      let c = customCounters.get(name);
      if (!c) {
        c = { help, value: 0, otel: otel?.meter.createCounter(name, { description: help }) };
        customCounters.set(name, c);
      }
      const entry = c;
      return {
        add(v = 1, attrs?: Record<string, string>) {
          if (!Number.isFinite(v) || v < 0) return;
          entry.value += v;
          rollup.current.add(name, v);
          entry.otel?.add(v, attrs as Attributes);
        },
      };
    },
    gauge(name, help) {
      rollup.gaugeNames.add(name);
      let g = customGauges.get(name);
      if (!g) {
        g = { help, value: 0, otel: otel?.meter.createGauge(name, { description: help }) };
        customGauges.set(name, g);
      }
      const entry = g;
      return {
        set(v: number, attrs?: Record<string, string>) {
          if (!Number.isFinite(v)) return;
          entry.value = v;
          rollup.current.sample(name, v);
          entry.otel?.record(v, attrs as Attributes);
        },
      };
    },
    tick,
    flush,
    prune,
    refreshStats,
    totals: () => collector.totals,
    customMetrics: () => ({ counters: customCounters, gauges: customGauges }),
  };
  return service;
}

export const createMetrics: CreateMetrics = (deps) => createMetricsService(deps);

const round2 = (n: number) => Math.round(n * 100) / 100;

function emptySnapshot(atMs: number): LiveSnapshot {
  return {
    at: Math.floor(atMs / 1000), uptimeSec: 0, connections: 0, authedConnections: 0, subscriptions: 0,
    eventsInPerSec: 0, eventsOutPerSec: 0, reqPerSec: 0, rejectedPerSec: 0, totalEvents: 0, dbBytes: 0,
    mediaBytes: 0, mediaCount: 0, cpuPercent: 0, memoryRss: 0, heapUsed: 0, loopLagMs: 0,
    reqLatencyP50: 0, reqLatencyP95: 0, reqLatencyP99: 0,
  };
}
