// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules.alerts`. Channels and digest cadence live in core
 * `config.alerts`; these are tuning knobs, all with working defaults.
 */
import { example, labels, technical } from '@beamhop/core';
import { z } from 'zod';

export const SeveritySchema = labels(z.enum(['info', 'warning', 'critical']), {
  info: 'Information',
  warning: 'Needs attention soon',
  critical: 'Urgent',
});
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export const AlertsModuleConfigSchema = z
  .object({
    evaluateSeconds: z
      .number()
      .int()
      .min(10)
      .max(3600)
      .default(60)
      .describe('How often Beamhop checks for problems, in seconds.'),
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
      example(
        z
          .string()
          .optional()
          .describe(
            'Contact address given to phone and browser push services, in case they need to reach you. Empty = a default.',
          ),
        'mailto:admin@example.com',
      ),
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
        .prefault({})
        .describe('Alerts sent as private Nostr messages'),
      'NIP-17 gift-wrapped DMs (kind 1059) are always stored in the local relay; these relays also receive them.',
    ),
    email: z
      .object({
        from: example(
          z
            .string()
            .default('Beamhop <alerts@localhost>')
            .describe(
              'Sender name and address on alert emails. Use an address your mail server may send from.',
            ),
          'Beamhop <alerts@relay.example.com>',
        ),
      })
      .prefault({})
      .describe('Alert emails'),
    rules: z
      .object({
        spamWave: z
          .object({
            enabled: z.boolean().default(true).describe('Warn when a spam wave is being blocked.'),
            minPerMinute: z
              .number()
              .int()
              .positive()
              .default(30)
              .describe('Ignore waves smaller than this many blocked posts a minute.'),
            factor: technical(
              z
                .number()
                .positive()
                .default(3)
                .describe('Warn when blocked posts reach this many times the usual amount.'),
              'Also requires z-score ≥ 4 vs. the seasonal baseline after warm-up.',
            ),
          })
          .prefault({})
          .describe('Spam waves'),
        errorSpike: z
          .object({
            enabled: z.boolean().default(true).describe('Warn when more errors happen than usual.'),
            minPerMinute: z
              .number()
              .int()
              .positive()
              .default(5)
              .describe('Ignore fewer errors than this per minute.'),
            criticalPerMinute: z
              .number()
              .int()
              .positive()
              .default(60)
              .describe('Send an urgent alert at this many errors per minute.'),
          })
          .prefault({})
          .describe('Error spikes'),
        connectionDrop: z
          .object({
            enabled: z
              .boolean()
              .default(true)
              .describe('Warn when far fewer people are connected than usual.'),
            minBaseline: z
              .number()
              .positive()
              .default(10)
              .describe('Only watch once at least this many people are usually connected.'),
            dropRatio: z
              .number()
              .min(0)
              .max(1)
              .default(0.3)
              .describe('Warn when connections fall to this share of normal (0.3 = 30%).'),
          })
          .prefault({})
          .describe('Connection drops'),
        diskFill: z
          .object({
            enabled: z.boolean().default(true).describe('Warn before the disk fills up.'),
            warnDays: z
              .number()
              .positive()
              .default(7)
              .describe('Warn when the disk will be full within this many days.'),
            criticalHours: z
              .number()
              .positive()
              .default(24)
              .describe('Send an urgent alert when it will be full within this many hours.'),
          })
          .prefault({})
          .describe('Disk filling up'),
        cert: z
          .object({
            enabled: z
              .boolean()
              .default(true)
              .describe('Warn before the security certificate expires.'),
            warnDays: z
              .number()
              .positive()
              .default(14)
              .describe('Warn this many days before it expires.'),
            criticalDays: z
              .number()
              .positive()
              .default(3)
              .describe('Send an urgent alert this many days before it expires.'),
          })
          .prefault({})
          .describe('Security certificate (https) expiry'),
        backup: z
          .object({
            enabled: z
              .boolean()
              .default(true)
              .describe('Warn when a backup fails or backups fall behind schedule.'),
          })
          .prefault({})
          .describe('Backups'),
        moderationBacklog: z
          .object({
            enabled: z
              .boolean()
              .default(true)
              .describe('Warn when reports waiting for review pile up.'),
          })
          .prefault({})
          .describe('Review queue'),
      })
      .prefault({})
      .describe('Which problems to watch for'),
  })
  .prefault({})
  .describe('Alert tuning');

export type AlertsModuleConfig = z.infer<typeof AlertsModuleConfigSchema>;
