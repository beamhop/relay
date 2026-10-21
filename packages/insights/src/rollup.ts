// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Downsampling and retention.
 *
 * - Raw 10-second points live in the TimeSeriesStore for `retention.rawHours`
 *   (default 48 h), then `prune()` removes them.
 * - Every hour the previous full hour is rolled up into one DocStore document
 *   per relay per UTC day (`insights.rollups` / `<relay>:<YYYY-MM-DD>`), holding
 *   24 hourly slots per metric and aggregate. Kept for `retention.rollupDays`.
 * - `series()` reads raw points when the range is within raw retention and
 *   hourly rollups otherwise.
 */
import type { DocStore, RelayId, TimeSeriesStore } from '@beamhop/core';
import { dayOf } from './analytics.ts';
import { METRIC_DEFS } from './metrics.ts';

export const ROLLUP_COLLECTION = 'insights.rollups';
export const STATE_COLLECTION = 'insights.state';

export type Agg = 'sum' | 'avg' | 'max' | 'min' | 'last';

/** Metrics rolled up, with the aggregates kept for each. */
export const ROLLUP_METRICS: Array<{ metric: string; aggs: Agg[] }> = [
  ...[
    'connections.opened',
    'events.accepted',
    'events.rejected',
    'events.held',
    'events.deleted',
    'events.bytes',
    'req.served',
    'req.results',
    'auth.success',
    'reports',
    'blobs.uploaded',
    'blobs.uploaded_bytes',
    'blobs.deleted',
    'errors',
    'relay.up',
  ].map((metric) => ({ metric, aggs: ['sum'] as Agg[] })),
  ...[
    'connections',
    'storage.events',
    'storage.bytes',
    'disk.free',
    'disk.total',
    'health.score',
    'event.latency.p50',
    'event.latency.p95',
    'req.latency.p50',
    'req.latency.p95',
  ].map((metric) => ({ metric, aggs: ['avg', 'max', 'min', 'last'] as Agg[] })),
];

type Slots = Array<number | null>;
type RollupDoc = Record<string, Partial<Record<Agg, Slots>>>;

export function defaultAgg(metric: string): Agg {
  const def = METRIC_DEFS.get(metric);
  if (def?.type === 'counter') return 'sum';
  return 'avg';
}

export class Rollups {
  constructor(
    private ts: TimeSeriesStore,
    private docs: DocStore,
  ) {}

  /** Roll up hour starting at `hourStart` (unix seconds, aligned) for the given relays. */
  async rollupHour(hourStart: number, relays: RelayId[]): Promise<void> {
    const day = dayOf(hourStart);
    const slot = Math.floor((hourStart % 86400) / 3600);
    for (const relayId of relays) {
      const key = `${relayId}:${day}`;
      const doc = (await this.docs.get<RollupDoc>(ROLLUP_COLLECTION, key)) ?? {};
      let any = false;
      for (const { metric, aggs } of ROLLUP_METRICS) {
        for (const agg of aggs) {
          const pts = await this.ts.range({
            metric,
            labels: { relay: relayId },
            from: hourStart,
            to: hourStart + 3599,
            stepSeconds: 3600,
            agg,
          });
          const v = pts[0]?.v;
          if (v === undefined) continue;
          const m = doc[metric] ?? {};
          doc[metric] = m;
          const slots = m[agg] ?? Array.from({ length: 24 }, () => null);
          m[agg] = slots;
          slots[slot] = v;
          any = true;
        }
      }
      if (any) await this.docs.put(ROLLUP_COLLECTION, key, doc);
    }
  }

  /** Roll up every full hour since the last run (bounded by `maxHours`). */
  async catchUp(now: number, relays: RelayId[], maxHours: number): Promise<number> {
    const current = Math.floor(now / 3600) * 3600;
    const state = await this.docs.get<{ lastHour: number }>(STATE_COLLECTION, 'rollup');
    let next = state ? state.lastHour + 3600 : current - 3600;
    next = Math.max(next, current - maxHours * 3600);
    let n = 0;
    for (; next < current; next += 3600) {
      await this.rollupHour(next, relays);
      await this.docs.put(STATE_COLLECTION, 'rollup', { lastHour: next });
      n++;
    }
    return n;
  }

  async read(q: {
    metric: string;
    relayId: RelayId;
    from: number;
    to: number;
    stepSeconds: number;
    agg: Agg;
  }): Promise<Array<{ t: number; v: number }>> {
    const step = Math.max(3600, Math.ceil(q.stepSeconds / 3600) * 3600);
    const kept = ROLLUP_METRICS.find((m) => m.metric === q.metric)?.aggs ?? ['avg'];
    const storedAgg: Agg = kept.includes(q.agg) ? q.agg : (kept[0] ?? 'avg');
    const buckets = new Map<number, number[]>();
    for (let d = Math.floor(q.from / 86400) * 86400; d <= q.to; d += 86400) {
      const doc = await this.docs.get<RollupDoc>(ROLLUP_COLLECTION, `${q.relayId}:${dayOf(d)}`);
      const slots = doc?.[q.metric]?.[storedAgg];
      if (!slots) continue;
      slots.forEach((v, i) => {
        if (v === null) return;
        const t = d + i * 3600;
        if (t < q.from || t > q.to) return;
        const b = Math.floor(t / step) * step;
        let arr = buckets.get(b);
        if (!arr) {
          arr = [];
          buckets.set(b, arr);
        }
        arr.push(v);
      });
    }
    const reduce = (vs: number[]): number => {
      switch (storedAgg) {
        case 'sum':
          return vs.reduce((a, b) => a + b, 0);
        case 'max':
          return Math.max(...vs);
        case 'min':
          return Math.min(...vs);
        case 'last':
          return vs[vs.length - 1] as number;
        default:
          return vs.reduce((a, b) => a + b, 0) / vs.length;
      }
    };
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, vs]) => ({ t, v: reduce(vs) }));
  }

  async prune(now: number, rollupDays: number): Promise<number> {
    const cutoff = dayOf(now - rollupDays * 86400);
    const doomed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.docs.list(ROLLUP_COLLECTION, { cursor, limit: 500 });
      for (const { key } of page.items) {
        const day = key.slice(key.lastIndexOf(':') + 1);
        if (day < cutoff) doomed.push(key);
      }
      cursor = page.cursor;
    } while (cursor);
    let n = 0;
    for (const k of doomed) if (await this.docs.delete(ROLLUP_COLLECTION, k)) n++;
    return n;
  }
}
