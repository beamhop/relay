// SPDX-License-Identifier: AGPL-3.0-or-later
/** `config.modules.insights` — every field has a working default. */
import { example, showWhen, technical } from '@beamhop/core';
import { z } from 'zod';

export const InsightsConfigSchema = z
  .object({
    flushSeconds: z
      .number()
      .int()
      .min(1)
      .max(300)
      .default(10)
      .describe('How often live numbers are saved'),
    retention: z
      .object({
        rawHours: z
          .number()
          .int()
          .min(1)
          .default(48)
          .describe('How long detailed (10-second) numbers are kept'),
        rollupDays: z
          .number()
          .int()
          .min(1)
          .default(400)
          .describe('How long hourly summaries are kept'),
        analyticsDays: z
          .number()
          .int()
          .min(7)
          .default(400)
          .describe('How long community statistics are kept'),
      })
      .prefault({})
      .describe('How long statistics are kept'),
    prometheus: technical(
      z
        .object({
          enabled: z.boolean().default(true).describe('Offer a /metrics page for monitoring tools'),
          path: showWhen(
            example(
              z
                .string()
                .default('/metrics')
                .describe(
                  'Web address path of the monitoring page. Change it if /metrics is taken.',
                ),
              '/metrics',
            ),
            { path: 'enabled', equals: true },
          ),
          token: showWhen(
            z
              .string()
              .min(16)
              .optional()
              .describe('Password that monitoring tools must send (at least 16 characters).'),
            { path: 'enabled', equals: true },
          ),
        })
        .prefault({})
        .describe('Monitoring page for tools like Prometheus or Grafana'),
      'Prometheus text exposition 0.0.4. Access requires `Authorization: Bearer <token>` or an admin principal with insights.read.',
    ),
    otlp: technical(
      z
        .object({
          endpoint: example(
            z
              .string()
              .url()
              .describe('Address of your monitoring collector that should receive the numbers.'),
            'https://otel-collector.example.com:4318',
          ),
          headers: example(
            z
              .record(z.string(), z.string())
              .default({})
              .describe('Extra headers to send, e.g. a login key your collector requires.'),
            { authorization: 'Bearer <token>' },
          ),
          intervalSeconds: z
            .number()
            .int()
            .min(10)
            .default(60)
            .describe('How often numbers are sent, in seconds.'),
        })
        .optional()
        .describe('Send numbers to an OpenTelemetry collector (leave empty to turn off)'),
      'OTLP/HTTP JSON metrics export (POST {endpoint}/v1/metrics), cumulative temporality.',
    ),
    storageBudgetBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Space you are willing to use for the database (used when free disk is unknown)'),
    analytics: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Count active users, popular apps and kinds (stays on this server)'),
        geo: z
          .boolean()
          .default(true)
          .describe('Count visitors by country when your host provides it'),
      })
      .prefault({})
      .describe('Community statistics (stay on this server)'),
  })
  .prefault({})
  .describe('Statistics and monitoring');

export type InsightsConfig = z.infer<typeof InsightsConfigSchema>;
