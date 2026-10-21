// SPDX-License-Identifier: AGPL-3.0-or-later
/** `config.modules.insights` — every field has a working default. */
import { technical } from '@beamhop/core';
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
      .prefault({}),
    prometheus: technical(
      z
        .object({
          enabled: z.boolean().default(true).describe('Offer a /metrics page for monitoring tools'),
          path: z.string().default('/metrics'),
          token: z
            .string()
            .min(16)
            .optional()
            .describe('Secret that monitoring tools must send (Bearer token)'),
        })
        .prefault({}),
      'Prometheus text exposition 0.0.4. Access requires `Authorization: Bearer <token>` or an admin principal with insights.read.',
    ),
    otlp: technical(
      z
        .object({
          endpoint: z.string().url().describe('OpenTelemetry collector address'),
          headers: z.record(z.string(), z.string()).default({}),
          intervalSeconds: z.number().int().min(10).default(60),
        })
        .optional(),
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
      .prefault({}),
  })
  .prefault({});

export type InsightsConfig = z.infer<typeof InsightsConfigSchema>;
