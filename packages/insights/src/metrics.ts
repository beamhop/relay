// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory metrics registry: counters, gauges and latency summaries keyed by
 * metric + labels. Every flush (10 s) turns the window into time-series points
 * and keeps a short ring of recent windows for live rates and health checks.
 */
import type { MetricPoint } from '@beamhop/core';
import { QuantileSketch } from './sketch.ts';

export type MetricType = 'counter' | 'gauge' | 'summary';
export type Labels = Record<string, string>;

export interface MetricDef {
  /** Time-series name, e.g. `events.accepted`. */
  id: string;
  type: MetricType;
  /** Prometheus/OTel help text (plain). */
  help: string;
  unit?: string;
}

/** Built-in metric catalog. Prometheus names derive from ids (see {@link promName}). */
export const METRICS = {
  connections: { id: 'connections', type: 'gauge', help: 'Open WebSocket connections' },
  connectionsOpened: {
    id: 'connections.opened',
    type: 'counter',
    help: 'WebSocket connections opened',
  },
  eventsAccepted: { id: 'events.accepted', type: 'counter', help: 'Events accepted and stored' },
  eventsRejected: {
    id: 'events.rejected',
    type: 'counter',
    help: 'Events rejected, by reason prefix',
  },
  eventsHeld: { id: 'events.held', type: 'counter', help: 'Events held for review' },
  eventsDeleted: { id: 'events.deleted', type: 'counter', help: 'Events deleted, by cause' },
  bytesIn: {
    id: 'events.bytes',
    type: 'counter',
    help: 'Approximate bytes of accepted events',
    unit: 'bytes',
  },
  reqServed: { id: 'req.served', type: 'counter', help: 'Subscriptions (REQ) served' },
  reqResults: { id: 'req.results', type: 'counter', help: 'Events returned to REQs' },
  eventLatency: {
    id: 'event.latency',
    type: 'summary',
    help: 'Event handling latency',
    unit: 'ms',
  },
  reqLatency: { id: 'req.latency', type: 'summary', help: 'REQ handling latency', unit: 'ms' },
  authSuccess: { id: 'auth.success', type: 'counter', help: 'Successful NIP-42 sign-ins' },
  reports: { id: 'reports', type: 'counter', help: 'Reports received (NIP-56)' },
  blobUploads: { id: 'blobs.uploaded', type: 'counter', help: 'Files uploaded' },
  blobBytes: {
    id: 'blobs.uploaded_bytes',
    type: 'counter',
    help: 'Bytes uploaded',
    unit: 'bytes',
  },
  blobDeleted: { id: 'blobs.deleted', type: 'counter', help: 'Files deleted' },
  blobQuarantined: { id: 'blobs.quarantined', type: 'counter', help: 'Files quarantined' },
  errors: { id: 'errors', type: 'counter', help: 'Internal errors, by source' },
  storageEvents: { id: 'storage.events', type: 'gauge', help: 'Stored events' },
  storageBytes: {
    id: 'storage.bytes',
    type: 'gauge',
    help: 'Approximate database size',
    unit: 'bytes',
  },
  diskFree: { id: 'disk.free', type: 'gauge', help: 'Free disk space', unit: 'bytes' },
  diskTotal: { id: 'disk.total', type: 'gauge', help: 'Total disk space', unit: 'bytes' },
  healthScore: { id: 'health.score', type: 'gauge', help: 'Overall health score (0-100)' },
  relayUp: {
    id: 'relay.up',
    type: 'gauge',
    help: 'Relay accepting connections (1) or not (0), sampled every flush',
  },
} as const satisfies Record<string, MetricDef>;

export const METRIC_DEFS: Map<string, MetricDef> = new Map(
  Object.values(METRICS).map((d) => [d.id, d as MetricDef]),
);

/** Prometheus metric name for a series id. */
export function promName(def: MetricDef): string {
  const base = `beamhop_${def.id.replace(/[^a-zA-Z0-9]+/g, '_')}`;
  const unit = def.unit === 'ms' ? '_milliseconds' : def.unit === 'bytes' ? '_bytes' : '';
  const withUnit = base.endsWith(unit) ? base : `${base}${unit}`;
  return def.type === 'counter' ? `${withUnit}_total` : withUnit;
}

export function seriesKey(id: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${id}{${parts.join(',')}}`;
}

/** Number of flushed windows kept in memory (30 × 10 s = 5 minutes). */
export const RING = 30;

interface CounterSeries {
  def: MetricDef;
  labels: Labels;
  total: number;
  delta: number;
  ring: number[];
}

interface GaugeSeries {
  def: MetricDef;
  labels: Labels;
  value: number;
}

interface SummarySeries {
  def: MetricDef;
  labels: Labels;
  count: number;
  sum: number;
  window: QuantileSketch;
  ring: QuantileSketch[];
}

export interface CounterView {
  def: MetricDef;
  labels: Labels;
  total: number;
}
export interface GaugeView {
  def: MetricDef;
  labels: Labels;
  value: number;
}
export interface SummaryView {
  def: MetricDef;
  labels: Labels;
  count: number;
  sum: number;
  /** Quantiles over the recent window (last 5 minutes). */
  quantiles: Array<{ q: number; v: number }>;
}

export const QUANTILES = [0.5, 0.95, 0.99];

export class MetricsRegistry {
  private counters = new Map<string, CounterSeries>();
  private gauges = new Map<string, GaugeSeries>();
  private summaries = new Map<string, SummarySeries>();
  /** End times (seconds) of flushed windows, aligned with rings. */
  private flushTimes: number[] = [];
  private windowStart: number;
  /** Bound on distinct label sets per metric (cardinality guard). */
  readonly maxSeriesPerMetric = 200;
  private perMetric = new Map<string, number>();

  constructor(now: number) {
    this.windowStart = now;
  }

  private admit(def: MetricDef): boolean {
    const n = this.perMetric.get(def.id) ?? 0;
    if (n >= this.maxSeriesPerMetric) return false;
    this.perMetric.set(def.id, n + 1);
    return true;
  }

  inc(def: MetricDef, labels: Labels, n = 1): void {
    const key = seriesKey(def.id, labels);
    let s = this.counters.get(key);
    if (!s) {
      if (!this.admit(def)) return;
      s = { def, labels, total: 0, delta: 0, ring: [] };
      this.counters.set(key, s);
    }
    s.total += n;
    s.delta += n;
  }

  set(def: MetricDef, labels: Labels, value: number): void {
    const key = seriesKey(def.id, labels);
    let s = this.gauges.get(key);
    if (!s) {
      if (!this.admit(def)) return;
      s = { def, labels, value };
      this.gauges.set(key, s);
    }
    s.value = value;
  }

  add(def: MetricDef, labels: Labels, delta: number): void {
    const key = seriesKey(def.id, labels);
    const cur = this.gauges.get(key)?.value ?? 0;
    this.set(def, labels, Math.max(0, cur + delta));
  }

  observe(def: MetricDef, labels: Labels, value: number): void {
    const key = seriesKey(def.id, labels);
    let s = this.summaries.get(key);
    if (!s) {
      if (!this.admit(def)) return;
      s = { def, labels, count: 0, sum: 0, window: new QuantileSketch(), ring: [] };
      this.summaries.set(key, s);
    }
    s.count++;
    s.sum += value;
    s.window.add(value);
  }

  gauge(def: MetricDef, labels: Labels): number | undefined {
    return this.gauges.get(seriesKey(def.id, labels))?.value;
  }

  /**
   * Close the current window: returns time-series points (counter deltas,
   * gauge values, summary quantiles) and rotates the in-memory rings.
   */
  flush(now: number): MetricPoint[] {
    const points: MetricPoint[] = [];
    for (const s of this.counters.values()) {
      points.push({ metric: s.def.id, labels: s.labels, t: now, v: s.delta });
      s.ring.push(s.delta);
      if (s.ring.length > RING) s.ring.shift();
      s.delta = 0;
    }
    for (const s of this.gauges.values()) {
      points.push({ metric: s.def.id, labels: s.labels, t: now, v: s.value });
    }
    for (const s of this.summaries.values()) {
      const w = s.window;
      if (w.count > 0) {
        points.push({ metric: `${s.def.id}.p50`, labels: s.labels, t: now, v: w.quantile(0.5) });
        points.push({ metric: `${s.def.id}.p95`, labels: s.labels, t: now, v: w.quantile(0.95) });
        points.push({ metric: `${s.def.id}.count`, labels: s.labels, t: now, v: w.count });
      }
      s.ring.push(w);
      if (s.ring.length > RING) s.ring.shift();
      s.window = new QuantileSketch();
    }
    this.flushTimes.push(now);
    if (this.flushTimes.length > RING) this.flushTimes.shift();
    this.windowStart = now;
    return points;
  }

  /** Seconds covered by the last `windows` flushed windows (plus nothing of the open one). */
  private span(windows: number): number {
    const n = Math.min(windows, this.flushTimes.length);
    if (n === 0) return 0;
    const end = this.flushTimes[this.flushTimes.length - 1] as number;
    const startIdx = this.flushTimes.length - n - 1;
    const start = startIdx >= 0 ? (this.flushTimes[startIdx] as number) : end - n * 10;
    return Math.max(1, end - start);
  }

  /** Sum of a counter over the last `windows` flushed windows, filtered by label subset. */
  recentSum(def: MetricDef, match: Labels, windows = 6): number {
    let total = 0;
    for (const s of this.counters.values()) {
      if (s.def.id !== def.id || !matches(s.labels, match)) continue;
      const ring = s.ring.slice(-windows);
      for (const v of ring) total += v;
    }
    return total;
  }

  /** Per-second rate over the last `windows` flushed windows. */
  rate(def: MetricDef, match: Labels, windows = 6): number {
    const span = this.span(windows);
    return span === 0 ? 0 : this.recentSum(def, match, windows) / span;
  }

  /** Recent per-label breakdown of a counter (e.g. rejections by reason). */
  breakdown(def: MetricDef, match: Labels, label: string, windows = 6): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.counters.values()) {
      if (s.def.id !== def.id || !matches(s.labels, match)) continue;
      const k = s.labels[label] ?? '';
      const v = s.ring.slice(-windows).reduce((a, b) => a + b, 0);
      if (v > 0) out[k] = (out[k] ?? 0) + v;
    }
    return out;
  }

  /** Quantile over recent windows (including the open one). */
  recentQuantile(def: MetricDef, match: Labels, q: number, windows = RING): number {
    const sk = this.recentSketch(def, match, windows);
    return sk.quantile(q);
  }

  recentSketch(def: MetricDef, match: Labels, windows = RING): QuantileSketch {
    const merged = new QuantileSketch();
    for (const s of this.summaries.values()) {
      if (s.def.id !== def.id || !matches(s.labels, match)) continue;
      for (const w of s.ring.slice(-windows)) merged.merge(w);
      merged.merge(s.window);
    }
    return merged;
  }

  /** Cumulative views for exposition (Prometheus / OTLP). */
  snapshot(): { counters: CounterView[]; gauges: GaugeView[]; summaries: SummaryView[] } {
    return {
      counters: [...this.counters.values()].map((s) => ({
        def: s.def,
        labels: s.labels,
        total: s.total,
      })),
      gauges: [...this.gauges.values()].map((s) => ({
        def: s.def,
        labels: s.labels,
        value: s.value,
      })),
      summaries: [...this.summaries.values()].map((s) => {
        const sk = new QuantileSketch();
        for (const w of s.ring) sk.merge(w);
        sk.merge(s.window);
        return {
          def: s.def,
          labels: s.labels,
          count: s.count,
          sum: s.sum,
          quantiles: QUANTILES.map((q) => ({ q, v: sk.quantile(q) })),
        };
      }),
    };
  }

  /** Relay ids that have any series. */
  relays(): string[] {
    const out = new Set<string>();
    for (const m of [this.counters, this.gauges, this.summaries] as Array<
      Map<string, { labels: Labels }>
    >)
      for (const s of m.values()) if (s.labels.relay) out.add(s.labels.relay);
    return [...out];
  }
}

export function matches(labels: Labels, match: Labels): boolean {
  for (const [k, v] of Object.entries(match)) if (labels[k] !== v) return false;
  return true;
}
