// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Prometheus text exposition format 0.0.4, hand-written (no prom-client) so it
 * runs on Cloudflare Workers too.
 */
import type { CounterView, GaugeView, Labels, MetricDef, SummaryView } from './metrics.ts';
import { promName } from './metrics.ts';

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function labelName(k: string): string {
  const n = k.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[0-9]/.test(n) ? `_${n}` : n;
}

export function formatLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${labelName(k)}="${escapeLabelValue(all[k] ?? '')}"`).join(',')}}`;
}

export function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Number.POSITIVE_INFINITY) return '+Inf';
  if (v === Number.NEGATIVE_INFINITY) return '-Inf';
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
}

export interface PromInput {
  counters: CounterView[];
  gauges: GaugeView[];
  summaries: SummaryView[];
  /** Extra constant labels (e.g. node). */
  constLabels?: Labels;
}

export function formatPrometheus(input: PromInput): string {
  const groups = new Map<string, { def: MetricDef; type: string; lines: string[] }>();
  const group = (def: MetricDef, type: string) => {
    const name = promName(def);
    let g = groups.get(name);
    if (!g) {
      g = { def, type, lines: [] };
      groups.set(name, g);
    }
    return { name, g };
  };
  const cl = input.constLabels;
  for (const c of input.counters) {
    const { name, g } = group(c.def, 'counter');
    g.lines.push(`${name}${formatLabels(c.labels, cl)} ${formatValue(c.total)}`);
  }
  for (const s of input.gauges) {
    const { name, g } = group(s.def, 'gauge');
    g.lines.push(`${name}${formatLabels(s.labels, cl)} ${formatValue(s.value)}`);
  }
  for (const s of input.summaries) {
    const { name, g } = group(s.def, 'summary');
    for (const { q, v } of s.quantiles)
      g.lines.push(
        `${name}${formatLabels(s.labels, { ...cl, quantile: String(q) })} ${formatValue(v)}`,
      );
    g.lines.push(`${name}_sum${formatLabels(s.labels, cl)} ${formatValue(s.sum)}`);
    g.lines.push(`${name}_count${formatLabels(s.labels, cl)} ${formatValue(s.count)}`);
  }
  const out: string[] = [];
  for (const name of [...groups.keys()].sort()) {
    const g = groups.get(name)!;
    out.push(`# HELP ${name} ${escapeHelp(g.def.help)}`);
    out.push(`# TYPE ${name} ${g.type}`);
    out.push(...g.lines);
  }
  return `${out.join('\n')}\n`;
}
