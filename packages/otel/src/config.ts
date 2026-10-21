// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `modules.otel` settings. Tracing is strictly opt-in: nothing is recorded or sent
 * until an admin sets `endpoint` to a collector they run or chose.
 */
import { example, recommend, technical } from '@beamhop/core';
import { z } from 'zod';

export const OtelConfigSchema = z
  .object({
    endpoint: technical(
      example(
        z
          .string()
          .url()
          .optional()
          .describe(
            'Address of your tracing collector. Leave empty to keep tracing off: nothing is recorded or sent.',
          ),
        'http://tempo.internal:4318',
      ),
      'OTLP/HTTP JSON base URL; spans are POSTed to {endpoint}/v1/traces (metrics to {endpoint}/v1/metrics). Read at boot: setting it for the first time needs a restart.',
    ),
    headers: example(
      z
        .record(z.string(), z.string())
        .default({})
        .describe('Extra, non-secret headers sent with each export, e.g. a tenant name.'),
      { 'x-scope-orgid': 'beamhop' },
    ),
    secretHeaders: technical(
      example(
        z
          .record(z.string(), z.string())
          .default({})
          .describe(
            'Headers that carry a login key or token for your collector. Stored privately and never shown again.',
          ),
        { authorization: 'Bearer <token>' },
      ),
      'Merged over `headers` on each export; redacted in the admin app, audit log and config diffs.',
    ),
    serviceName: technical(
      z
        .string()
        .min(1)
        .max(100)
        .default('beamhop')
        .describe('Name this server appears under in your tracing tool.'),
      'Resource attribute service.name (service.instance.id is node.id).',
    ),
    sampleRatio: technical(
      recommend(
        z
          .number()
          .min(0)
          .max(1)
          .default(0.1)
          .describe(
            'Share of activity to trace, from 0 (none) to 1 (everything). Lower means less load.',
          ),
        0.1,
        'One in ten is enough to see slow paths on a busy relay',
      ),
      'Head sampling: TraceIdRatio for root spans; incoming W3C traceparent with the sampled flag is always honoured (parent-based).',
    ),
    metrics: technical(
      z
        .object({
          enabled: z
            .boolean()
            .default(false)
            .describe('Also send the numbers shown on the monitoring page to the same collector.'),
          intervalSeconds: z
            .number()
            .int()
            .min(10)
            .max(3600)
            .default(60)
            .describe('How often numbers are sent, in seconds.'),
        })
        .prefault({})
        .describe('Numbers (counters) export'),
      'OTLP/HTTP JSON metrics (cumulative) built from the insights registry, POST {endpoint}/v1/metrics. Needs the insights module; do not also set modules.insights.otlp to the same collector.',
    ),
  })
  .describe('Send traces to your own OpenTelemetry collector (off until you set an address)');

export type OtelConfig = z.output<typeof OtelConfigSchema>;
