// SPDX-License-Identifier: AGPL-3.0-or-later
/** Read-only insights actions (§6.13). */
import { type ActionDef, defineAction } from '@beamhop/core';
import { z } from 'zod';
import { formatBytes } from './health.ts';
import type { InsightsRuntime } from './service.ts';

export function createActions(rt: InsightsRuntime): ActionDef[] {
  const overview = defineAction({
    id: 'insights.overview',
    title: 'How is my relay doing?',
    description: 'Health score, live activity and storage at a glance.',
    technical:
      'Weighted health score over all registered HealthChecks (worst-check cap), live rates from the in-memory registry (last 60 s), p50/p95 latency (last 5 min), events.stats().',
    scope: 'relay',
    permission: 'insights.read',
    readOnly: true,
    keywords: ['health', 'status', 'dashboard', 'overview', 'live'],
    input: z.object({}),
    async run(_input, ctx) {
      const health = await rt.score(ctx.relayId);
      const live = rt.live(ctx.relayId ?? undefined);
      const storage = await rt.storageStats();
      return {
        output: { health, live, storage },
        summary: `Health ${health.score}/100 — ${health.message}. ${formatBytes(storage.bytes)} used.`,
      };
    },
  });

  const series = defineAction({
    id: 'insights.series',
    title: 'Activity over time',
    description: 'A chart of one number over time, like posts or connections.',
    technical:
      'Raw 10 s points from the TimeSeriesStore within raw retention, hourly rollups (insights.rollups) beyond. Counters aggregate by sum, gauges by avg.',
    scope: 'relay',
    permission: 'insights.read',
    readOnly: true,
    keywords: ['chart', 'graph', 'history', 'metrics', 'series'],
    input: z.object({
      metric: z.string().min(1).describe('What to chart, e.g. events.accepted'),
      hours: z
        .number()
        .positive()
        .max(24 * 400)
        .default(24),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
      stepSeconds: z.number().int().positive().optional(),
      agg: z.enum(['sum', 'avg', 'max', 'min', 'last']).optional(),
      labels: z.record(z.string(), z.string()).optional(),
    }),
    async run(input, ctx) {
      const to = input.to ?? rt.kernel.ports.clock.now();
      const from = input.from ?? to - Math.round(input.hours * 3600);
      const points = await rt.series({
        metric: input.metric,
        relayId: ctx.relayId,
        from,
        to,
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.stepSeconds ? { stepSeconds: input.stepSeconds } : {}),
        ...(input.agg ? { agg: input.agg } : {}),
      });
      return {
        output: { metric: input.metric, from, to, points },
        summary: `${points.length} data points`,
      };
    },
  });

  const analytics = defineAction({
    id: 'insights.analytics',
    title: 'Community',
    description:
      'Active people, popular apps and post types, who comes back, and who uses the most storage. Stays on this server.',
    technical:
      'Daily HyperLogLog (p=12, ±1.6%) of active pubkeys (authors, NIP-42 auth, uploads); kinds; NIP-89 client tags; User-Agent products; weekly first-seen cohorts; blobIndex usage; country only from runtime header (cf-ipcountry).',
    scope: 'relay',
    permission: 'insights.read',
    readOnly: true,
    keywords: ['users', 'community', 'growth', 'retention', 'clients', 'kinds', 'analytics'],
    input: z.object({
      days: z.number().int().min(1).max(400).default(30),
    }),
    async run(input, ctx) {
      const relayId = ctx.relayId ?? rt.kernel.config().relays[0]?.id;
      if (!relayId) throw new Error('choose a relay first');
      const report = await rt.analytics(relayId, { days: input.days });
      const u = report.activeUsers;
      return {
        output: report,
        summary: `${u.daily} active today, ${u.weekly} this week, ${u.monthly} this month`,
      };
    },
  });

  return [overview, series, analytics] as unknown as ActionDef[];
}
