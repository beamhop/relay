// SPDX-License-Identifier: AGPL-3.0-or-later
/** Insights runtime: flush loop, live snapshot, series queries, exporters. */
import type { Kernel, RelayId, StoreStats } from '@beamhop/core';
import { Analytics, type AnalyticsReport, dayOf } from './analytics.ts';
import { NODE, wireCollector } from './collector.ts';
import { type InsightsConfig, InsightsConfigSchema } from './config.ts';
import { type HealthReport, builtinChecks, runChecks } from './health.ts';
import { METRICS, MetricsRegistry } from './metrics.ts';
import { type FetchLike, buildOtlpPayload, exportOtlp } from './otlp.ts';
import { formatPrometheus } from './prometheus.ts';
import { type DiskProvider, readDisk } from './providers.ts';
import { type Agg, Rollups, STATE_COLLECTION, defaultAgg } from './rollup.ts';

export interface InsightsModuleOptions {
  /** Free-disk provider (the runtime may instead provide `kernel.use('runtime.disk')`). */
  disk?: DiskProvider;
  /** fetch used by the OTLP exporter (tests inject a stub). */
  fetch?: FetchLike;
}

export interface LiveRelay {
  relayId: RelayId;
  connections: number;
  eventsPerSecond: number;
  rejectedPerSecond: number;
  rejectedByReason: Record<string, number>;
  /** accepted / (accepted + rejected) over the last minute; 1 when idle. */
  acceptRatio: number;
  reqPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  bytesPerSecond: number;
  blobUploadsPerMinute: number;
  errorsPerMinute: number;
  /** errors / (accepted + rejected + REQs) over the last minute; 0 when idle. */
  errorRate: number;
  /** Posts stored for this relay and their approximate database size (refreshed every 60 s). */
  storageEvents: number | null;
  storageBytes: number | null;
  /** Uploaded files and their total size for this relay (refreshed every 10 min). */
  blobFiles: number | null;
  blobBytes: number | null;
}

export interface LiveSnapshot {
  at: number;
  relays: LiveRelay[];
  storage: { events: number; bytes: number } | null;
  disk: { freeBytes: number; totalBytes: number } | null;
}

export interface SeriesQuery {
  metric: string;
  relayId?: RelayId | null;
  labels?: Record<string, string>;
  from: number;
  to: number;
  stepSeconds?: number;
  agg?: Agg;
}

/** Service exposed as `kernel.use<InsightsService>('insights')`. */
export interface InsightsService {
  /** Overall health score with per-check details (cached ~10 s). */
  score(relayId: RelayId | null): Promise<HealthReport>;
  series(q: SeriesQuery): Promise<Array<{ t: number; v: number }>>;
  live(relayId?: RelayId): LiveSnapshot;
  analytics(relayId: RelayId, opts?: { days?: number }): Promise<AnalyticsReport>;
  /** Called after every flush with the new live snapshot (for SSE). */
  onLive(fn: (s: LiveSnapshot) => void): () => void;
  prometheus(): string;
  /** Force a flush (tests, shutdown). */
  flush(): Promise<void>;
  /** Run rollups + retention now. */
  maintain(): Promise<void>;
  /**
   * Daily availability for the public status page: share of flush windows in
   * which the relay was accepting connections (missing samples = down).
   * Days before monitoring started are omitted. Oldest first.
   */
  uptime(relayId: RelayId, days: number): Promise<Array<{ day: string; upRatio: number }>>;
  readonly registry: MetricsRegistry;
}

interface EngineLike {
  connectionCount?(relayId?: RelayId): number;
}

export const SLOW_EVERY_SECONDS = 60;
/** How often per-relay blob usage is re-counted from the blob index. */
export const BLOB_SCAN_SECONDS = 600;

export class InsightsRuntime implements InsightsService {
  readonly registry: MetricsRegistry;
  readonly analyticsStore: Analytics | null;
  readonly rollups: Rollups;
  readonly startedAt: number;
  private cleanup: Array<() => void> = [];
  private listeners = new Set<(s: LiveSnapshot) => void>();
  private scoreCache = new Map<string, { at: number; report: Promise<HealthReport> }>();
  private lastSlow = 0;
  private storage: StoreStats | null = null;
  private storageAt = 0;
  private disk: { freeBytes: number; totalBytes: number } | null = null;
  private relayStorage = new Map<RelayId, StoreStats>();
  private blobUsage = new Map<RelayId, { at: number; files: number; bytes: number }>();

  constructor(
    readonly kernel: Kernel,
    readonly opts: InsightsModuleOptions = {},
  ) {
    const now = kernel.ports.clock.now();
    this.startedAt = now;
    this.registry = new MetricsRegistry(now);
    const cfg = this.config();
    this.analyticsStore = cfg.analytics.enabled
      ? new Analytics(kernel.ports, {
          geo: cfg.analytics.geo,
          retentionDays: cfg.retention.analyticsDays,
        })
      : null;
    this.rollups = new Rollups(kernel.ports.metrics, kernel.ports.docs);
    this.cleanup.push(...wireCollector(kernel, this.registry, this.analyticsStore));
    for (const c of builtinChecks({
      kernel,
      registry: this.registry,
      config: () => this.config(),
      ...(opts.disk ? { disk: opts.disk } : {}),
      storageStats: () => this.storageStats(),
    }))
      kernel.health.push(c);
  }

  config(): InsightsConfig {
    return this.kernel.moduleConfig<InsightsConfig>('insights') ?? InsightsConfigSchema.parse({});
  }

  private now(): number {
    return this.kernel.ports.clock.now();
  }

  relayIds(): RelayId[] {
    const ids = new Set(this.kernel.config().relays.map((r) => r.id));
    for (const r of this.registry.relays()) if (r !== NODE) ids.add(r);
    return [...ids];
  }

  async storageStats(): Promise<StoreStats> {
    const now = this.now();
    if (!this.storage || now - this.storageAt >= SLOW_EVERY_SECONDS) {
      this.storage = await this.kernel.ports.events.stats();
      this.storageAt = now;
    }
    return this.storage;
  }

  async flush(): Promise<void> {
    const now = this.now();
    const engine = this.kernel.use<EngineLike>('relay.engine');
    const relays = this.relayIds();
    if (engine && typeof engine.connectionCount === 'function') {
      for (const id of relays)
        this.registry.set(METRICS.connections, { relay: id }, engine.connectionCount(id));
    }
    if (now - this.lastSlow >= SLOW_EVERY_SECONDS) {
      this.lastSlow = now;
      await this.slowGauges(relays);
    }
    const up = !!this.kernel.ws && this.kernel.isEnabled('relay');
    for (const id of relays)
      this.registry.set(METRICS.relayUp, { relay: id }, up && this.kernel.relay(id) ? 1 : 0);
    if (!this.firstSample) await this.markFirstSample(now);
    const points = this.registry.flush(now);
    if (points.length) await this.kernel.ports.metrics.record(points);
    const snap = this.live();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // listener errors never break the flush loop
      }
    }
  }

  private async slowGauges(relays: RelayId[]): Promise<void> {
    const r = this.registry;
    const k = this.kernel;
    try {
      const total = await this.storageStats();
      r.set(METRICS.storageEvents, { relay: NODE }, total.events);
      r.set(METRICS.storageBytes, { relay: NODE }, total.bytes);
      for (const id of relays) {
        const s = await k.ports.events.stats(id);
        this.relayStorage.set(id, s);
        r.set(METRICS.storageEvents, { relay: id }, s.events);
        r.set(METRICS.storageBytes, { relay: id }, s.bytes);
      }
    } catch (err) {
      k.bus.emit('error', { source: 'insights.storage', message: String(err) });
    }
    try {
      for (const id of relays) {
        const b = await this.blobStats(id);
        r.set(METRICS.blobStorageBytes, { relay: id }, b.bytes);
        r.set(METRICS.blobStorageFiles, { relay: id }, b.files);
      }
    } catch (err) {
      k.bus.emit('error', { source: 'insights.blobs', message: String(err) });
    }
    this.disk = await readDisk(k, this.opts.disk);
    if (this.disk) {
      r.set(METRICS.diskFree, { relay: NODE }, this.disk.freeBytes);
      r.set(METRICS.diskTotal, { relay: NODE }, this.disk.totalBytes);
    }
    try {
      const node = await this.score(null);
      r.set(METRICS.healthScore, { relay: NODE }, node.score);
      for (const id of relays)
        r.set(METRICS.healthScore, { relay: id }, (await this.score(id)).score);
    } catch (err) {
      k.bus.emit('error', { source: 'insights.health', message: String(err) });
    }
    await this.analyticsStore?.flush(this.now());
  }

  /** Files and bytes uploaded to a relay (blob index scan, cached 10 min, capped at 100k rows). */
  async blobStats(relayId: RelayId): Promise<{ files: number; bytes: number }> {
    const now = this.now();
    const hit = this.blobUsage.get(relayId);
    if (hit && now - hit.at < BLOB_SCAN_SECONDS) return hit;
    let files = 0;
    let bytes = 0;
    let cursor: string | undefined;
    do {
      const page = await this.kernel.ports.blobIndex.list(relayId, { cursor, limit: 500 });
      for (const o of page.items) {
        files++;
        bytes += o.size;
      }
      cursor = page.cursor;
    } while (cursor && files < 100_000);
    const out = { at: now, files, bytes };
    this.blobUsage.set(relayId, out);
    return out;
  }

  score(relayId: RelayId | null): Promise<HealthReport> {
    const key = relayId ?? '*';
    const now = this.now();
    const cached = this.scoreCache.get(key);
    if (cached && now - cached.at < 10) return cached.report;
    const report = runChecks(this.kernel, relayId, now);
    this.scoreCache.set(key, { at: now, report });
    report.catch(() => this.scoreCache.delete(key));
    return report;
  }

  live(relayId?: RelayId): LiveSnapshot {
    const r = this.registry;
    const ids = relayId ? [relayId] : this.relayIds();
    const relays = ids.map((id): LiveRelay => {
      const m = { relay: id };
      const accepted = r.rate(METRICS.eventsAccepted, m);
      const rejected = r.rate(METRICS.eventsRejected, m);
      const sk = r.recentSketch(METRICS.eventLatency, m);
      const reqs = r.rate(METRICS.reqServed, m);
      const errs = r.rate(METRICS.errors, m);
      const handled = accepted + rejected + reqs;
      const st = this.relayStorage.get(id);
      const blobs = this.blobUsage.get(id);
      return {
        relayId: id,
        connections: r.gauge(METRICS.connections, m) ?? 0,
        eventsPerSecond: round(accepted),
        rejectedPerSecond: round(rejected),
        rejectedByReason: r.breakdown(METRICS.eventsRejected, m, 'reason'),
        acceptRatio: accepted + rejected > 0 ? round(accepted / (accepted + rejected)) : 1,
        reqPerSecond: round(r.rate(METRICS.reqServed, m)),
        p50Ms: round(sk.quantile(0.5)),
        p95Ms: round(sk.quantile(0.95)),
        bytesPerSecond: round(r.rate(METRICS.bytesIn, m)),
        blobUploadsPerMinute: round(r.rate(METRICS.blobUploads, m) * 60),
        errorsPerMinute: round(errs * 60),
        errorRate: handled > 0 ? Math.round((errs / handled) * 10000) / 10000 : 0,
        storageEvents: st?.events ?? null,
        storageBytes: st?.bytes ?? null,
        blobFiles: blobs?.files ?? null,
        blobBytes: blobs?.bytes ?? null,
      };
    });
    return {
      at: this.now(),
      relays,
      storage: this.storage ? { events: this.storage.events, bytes: this.storage.bytes } : null,
      disk: this.disk,
    };
  }

  onLive(fn: (s: LiveSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async series(q: SeriesQuery): Promise<Array<{ t: number; v: number }>> {
    const cfg = this.config();
    const agg = q.agg ?? defaultAgg(q.metric);
    const span = Math.max(1, q.to - q.from);
    const step = q.stepSeconds ?? Math.max(cfg.flushSeconds, Math.ceil(span / 300));
    const rawCutoff = this.now() - cfg.retention.rawHours * 3600;
    const relayId = q.relayId ?? null;
    if (q.from >= rawCutoff || !relayId) {
      const labels = { ...q.labels, ...(relayId ? { relay: relayId } : {}) };
      return this.kernel.ports.metrics.range({
        metric: q.metric,
        labels,
        from: q.from,
        to: q.to,
        stepSeconds: step,
        agg,
      });
    }
    return this.rollups.read({
      metric: q.metric,
      relayId,
      from: q.from,
      to: q.to,
      stepSeconds: step,
      agg,
    });
  }

  async analytics(relayId: RelayId, opts?: { days?: number }): Promise<AnalyticsReport> {
    if (!this.analyticsStore) throw new Error('Community statistics are turned off');
    return this.analyticsStore.report(relayId, this.now(), opts);
  }

  prometheus(): string {
    return formatPrometheus({
      ...this.registry.snapshot(),
      constLabels: { node: this.kernel.config().node.id },
    });
  }

  async exportOtlp(): Promise<void> {
    const otlp = this.config().otlp;
    if (!otlp) return;
    const fetchFn = this.opts.fetch ?? ((i, init) => fetch(i, init));
    const payload = buildOtlpPayload({
      ...this.registry.snapshot(),
      startTime: this.startedAt,
      now: this.now(),
      resource: {
        'service.name': 'beamhop',
        'service.instance.id': this.kernel.config().node.id,
      },
    });
    await exportOtlp(fetchFn, otlp.endpoint, otlp.headers, payload);
  }

  private firstSample = 0;

  private async markFirstSample(now: number): Promise<void> {
    const docs = this.kernel.ports.docs;
    const prev = await docs.get<{ t: number }>(STATE_COLLECTION, 'firstSample');
    this.firstSample = prev?.t ?? now;
    if (!prev) await docs.put(STATE_COLLECTION, 'firstSample', { t: now });
  }

  async uptime(relayId: RelayId, days: number): Promise<Array<{ day: string; upRatio: number }>> {
    const now = this.now();
    const cfg = this.config();
    if (!this.firstSample) {
      const prev = await this.kernel.ports.docs.get<{ t: number }>(STATE_COLLECTION, 'firstSample');
      if (!prev) return [];
      this.firstSample = prev.t;
    }
    const step = cfg.flushSeconds;
    const rawCutoff = now - cfg.retention.rawHours * 3600;
    const today = Math.floor(now / 86400) * 86400;
    const out: Array<{ day: string; upRatio: number }> = [];
    const n = Math.max(1, Math.min(400, Math.floor(days)));
    for (let i = n - 1; i >= 0; i--) {
      const start = today - i * 86400;
      const end = Math.min(start + 86400, now);
      const from = Math.max(start, this.firstSample);
      if (end <= from) continue;
      const expected = Math.max(1, Math.floor((end - from) / step));
      // Hours older than raw retention come from hourly rollups; the rest from raw points.
      const rawFrom = Math.min(end, Math.max(from, Math.ceil(rawCutoff / 3600) * 3600));
      let ups = 0;
      if (rawFrom > from) {
        const rolled = await this.rollups.read({
          metric: METRICS.relayUp.id,
          relayId,
          from,
          to: rawFrom - 1,
          stepSeconds: 86400 * 2,
          agg: 'sum',
        });
        ups += rolled.reduce((a, p) => a + p.v, 0);
      }
      if (end > rawFrom) {
        const pts = await this.kernel.ports.metrics.range({
          metric: METRICS.relayUp.id,
          labels: { relay: relayId },
          from: rawFrom,
          to: end,
          stepSeconds: 86400 * 2,
          agg: 'sum',
        });
        ups += pts.reduce((a, p) => a + p.v, 0);
      }
      out.push({
        day: dayOf(start),
        upRatio: Math.round(Math.min(1, ups / expected) * 10000) / 10000,
      });
    }
    return out;
  }

  async maintain(): Promise<void> {
    const cfg = this.config();
    const now = this.now();
    await this.rollups.catchUp(now, this.relayIds(), cfg.retention.rawHours);
    await this.kernel.ports.metrics.prune(now - cfg.retention.rawHours * 3600);
    await this.rollups.prune(now, cfg.retention.rollupDays);
    await this.analyticsStore?.prune(now);
  }

  stop(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    this.listeners.clear();
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
