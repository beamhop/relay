// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Home tiles from the insights module (`insights.overview` + `insights.series`).
 * Returns null when the module is not installed; the tiles then fall back to
 * numbers counted from the live channel.
 */
import type { ApiClient } from './api/client.ts';
import type { CatalogAction } from './api/types.ts';

export interface Insights {
  connections: number;
  eventsPerSecond: number;
  errorsPerMinute: number;
  storageBytes: number | null;
  series: { connections: number[]; events: number[]; errors: number[] };
}

interface Overview {
  live: {
    relays: Array<{
      connections: number;
      eventsPerSecond: number;
      errorsPerMinute: number;
      rejectedPerSecond: number;
    }>;
  };
  storage: { bytes: number } | null;
}

const SERIES: Array<[keyof Insights['series'], string]> = [
  ['connections', 'connections'],
  ['events', 'events.accepted'],
  ['errors', 'events.rejected'],
];

export async function loadInsights(
  api: ApiClient,
  catalog: CatalogAction[],
): Promise<Insights | null> {
  const overview = catalog.find((a) => a.id === 'insights.overview');
  if (!overview || !api.relayId) return null;
  const o = (await api.run<Overview>('insights.overview', {}, overview.scope)).output;
  const sum = (f: (r: Overview['live']['relays'][number]) => number) =>
    Math.round(o.live.relays.reduce((a, r) => a + f(r), 0) * 10) / 10;
  const out: Insights = {
    connections: sum((r) => r.connections),
    eventsPerSecond: sum((r) => r.eventsPerSecond),
    errorsPerMinute: sum((r) => r.errorsPerMinute + r.rejectedPerSecond * 60),
    storageBytes: o.storage?.bytes ?? null,
    series: { connections: [], events: [], errors: [] },
  };
  const series = catalog.find((a) => a.id === 'insights.series');
  if (series) {
    await Promise.all(
      SERIES.map(async ([k, metric]) => {
        try {
          const r = await api.run<{ points: Array<{ t: number; v: number }> }>(
            'insights.series',
            { metric, hours: 1 },
            series.scope,
          );
          out.series[k] = r.output.points.map((p) => p.v);
        } catch {
          // keep empty: the tile shows a flat line
        }
      }),
    );
  }
  return out;
}
