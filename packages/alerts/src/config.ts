// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules.alerts`. Channels and digest cadence live in core
 * `config.alerts`; these are tuning knobs, all with working defaults.
 */
import { technical } from '@beamhop/core';
import { z } from 'zod';

export const SeveritySchema = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export const AlertsModuleConfigSchema = z
  .object({
    evaluateSeconds: z.number().int().min(10).max(3600).default(60),
    minSeverity: SeveritySchema.default('warning').describe(
      'Only send notifications at or above this level (the rest wait for the digest)',
    ),
    renotifyMinutes: z
      .number()
      .int()
      .min(5)
      .default(360)
      .describe('Remind again about an ongoing problem after this many minutes'),
    digestHourUtc: z.number().int().min(0).max(23).default(9).describe('Hour the digest is sent'),
    digestWeekday: z
      .number()
      .int()
      .min(0)
      .max(6)
      .default(1)
      .describe('Day of the weekly digest (0 = Sunday)'),
    digestTips: z.boolean().default(true).describe('Add one short tip to each digest'),
    channelSeverity: z
      .record(z.string(), SeveritySchema)
      .default({})
      .describe('Per channel: lowest level it receives'),
    vapidSubject: technical(
      z.string().optional(),
      'VAPID `sub` claim (RFC 8292): mailto: or https: contact for push services.',
    ),
    nostrDm: technical(
      z
        .object({
          relays: z
            .array(z.string().url())
            .default([])
            .describe('Other relays to deliver direct messages to'),
        })
        .prefault({}),
      'NIP-17 gift-wrapped DMs (kind 1059) are always stored in the local relay; these relays also receive them.',
    ),
    email: z
      .object({
        from: z.string().default('Beamhop <alerts@localhost>'),
      })
      .prefault({}),
    rules: z
      .object({
        spamWave: z
          .object({
            enabled: z.boolean().default(true),
            minPerMinute: z.number().int().positive().default(30),
            factor: z.number().positive().default(3),
          })
          .prefault({}),
        errorSpike: z
          .object({
            enabled: z.boolean().default(true),
            minPerMinute: z.number().int().positive().default(5),
            criticalPerMinute: z.number().int().positive().default(60),
          })
          .prefault({}),
        connectionDrop: z
          .object({
            enabled: z.boolean().default(true),
            minBaseline: z.number().positive().default(10),
            dropRatio: z.number().min(0).max(1).default(0.3),
          })
          .prefault({}),
        diskFill: z
          .object({
            enabled: z.boolean().default(true),
            warnDays: z.number().positive().default(7),
            criticalHours: z.number().positive().default(24),
          })
          .prefault({}),
        cert: z
          .object({
            enabled: z.boolean().default(true),
            warnDays: z.number().positive().default(14),
            criticalDays: z.number().positive().default(3),
          })
          .prefault({}),
        backup: z.object({ enabled: z.boolean().default(true) }).prefault({}),
        moderationBacklog: z.object({ enabled: z.boolean().default(true) }).prefault({}),
      })
      .prefault({}),
  })
  .prefault({});

export type AlertsModuleConfig = z.infer<typeof AlertsModuleConfigSchema>;
