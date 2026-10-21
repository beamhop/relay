// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * OpenTelemetry OTLP/HTTP JSON metrics exporter (fetch-based, Workers-safe).
 * Sends cumulative sums, gauges and summaries to `{endpoint}/v1/metrics`.
 */
import type { CounterView, GaugeView, Labels, SummaryView } from './metrics.ts';
import { promName } from './metrics.ts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type AnyValue = { stringValue: string };
type KeyValue = { key: string; value: AnyValue };

function attrs(labels: Labels): KeyValue[] {
  return Object.keys(labels)
    .sort()
    .map((key) => ({ key, value: { stringValue: labels[key] ?? '' } }));
}

const nanos = (seconds: number) => `${BigInt(Math.floor(seconds)) * 1_000_000_000n}`;

export interface OtlpInput {
  counters: CounterView[];
  gauges: GaugeView[];
  summaries: SummaryView[];
  /** Unix seconds when counting started (cumulative start time). */
  startTime: number;
  now: number;
  resource: Labels;
}

/** Name in OTel style: the Prometheus name without the `_total` suffix. */
function otelName(def: CounterView['def']): string {
  return promName(def).replace(/_total$/, '');
}

export function buildOtlpPayload(input: OtlpInput): unknown {
  const start = nanos(input.startTime);
  const time = nanos(input.now);
  const metrics: Record<string, unknown>[] = [];
  const byName = new Map<string, { def: CounterView['def']; points: unknown[]; kind: string }>();
  const push = (def: CounterView['def'], kind: string, point: unknown) => {
    const name = otelName(def);
    let m = byName.get(name);
    if (!m) {
      m = { def, points: [], kind };
      byName.set(name, m);
    }
    m.points.push(point);
  };
  for (const c of input.counters)
    push(c.def, 'sum', {
      attributes: attrs(c.labels),
      startTimeUnixNano: start,
      timeUnixNano: time,
      asDouble: c.total,
    });
  for (const g of input.gauges)
    push(g.def, 'gauge', { attributes: attrs(g.labels), timeUnixNano: time, asDouble: g.value });
  for (const s of input.summaries)
    push(s.def, 'summary', {
      attributes: attrs(s.labels),
      startTimeUnixNano: start,
      timeUnixNano: time,
      count: String(s.count),
      sum: s.sum,
      quantileValues: s.quantiles.map(({ q, v }) => ({ quantile: q, value: v })),
    });
  for (const [name, m] of byName) {
    const base: Record<string, unknown> = { name, description: m.def.help };
    if (m.def.unit) base.unit = m.def.unit;
    if (m.kind === 'sum')
      base.sum = { dataPoints: m.points, aggregationTemporality: 2, isMonotonic: true };
    else if (m.kind === 'gauge') base.gauge = { dataPoints: m.points };
    else base.summary = { dataPoints: m.points };
    metrics.push(base);
  }
  return {
    resourceMetrics: [
      {
        resource: { attributes: attrs(input.resource) },
        scopeMetrics: [{ scope: { name: 'beamhop.insights', version: '0.0.0' }, metrics }],
      },
    ],
  };
}

export function otlpUrl(endpoint: string): string {
  const e = endpoint.replace(/\/+$/, '');
  return e.endsWith('/v1/metrics') ? e : `${e}/v1/metrics`;
}

export async function exportOtlp(
  fetchFn: FetchLike,
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<void> {
  const res = await fetchFn(otlpUrl(endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`OTLP export failed: HTTP ${res.status}`);
}
