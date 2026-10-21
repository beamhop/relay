// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional OTLP metrics: the same counters, gauges and summaries `/metrics` shows,
 * read from the insights registry (read-only) and sent to the trace collector.
 */
import { buildOtlpPayload } from '@beamhop/insights';
import type { FetchLike } from './exporter.ts';
import { type ResourceInfo, metricsUrl } from './otlp.ts';

/** What this package reads from the insights service (`kernel.use('insights')`). */
export interface InsightsLike {
  registry: {
    snapshot(): Omit<Parameters<typeof buildOtlpPayload>[0], 'startTime' | 'now' | 'resource'>;
  };
  /** Unix seconds when counting started. */
  startedAt: number;
}

export interface MetricsExportInput {
  fetch: FetchLike;
  endpoint: string;
  headers: Record<string, string>;
  insights: InsightsLike;
  resource: ResourceInfo;
  /** Unix seconds. */
  now: number;
}

/** Build and POST one cumulative OTLP metrics request. Throws on a non-2xx answer. */
export async function exportMetrics(input: MetricsExportInput): Promise<void> {
  const payload = buildOtlpPayload({
    ...input.insights.registry.snapshot(),
    startTime: input.insights.startedAt,
    now: input.now,
    resource: {
      'service.name': input.resource.serviceName,
      'service.instance.id': input.resource.instanceId,
    },
  });
  const res = await input.fetch(metricsUrl(input.endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...input.headers },
    body: JSON.stringify(payload),
  });
  await res.arrayBuffer().catch(() => undefined);
  if (!res.ok) throw new Error(`OTLP metrics export failed: HTTP ${res.status}`);
}
