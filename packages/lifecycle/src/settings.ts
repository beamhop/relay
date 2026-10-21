// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules.lifecycle` — knobs for retention sweeps, storage caps,
 * backups, Litestream monitoring and known-good marking. The schedule, target
 * and "keep N" of backups live in the core `config.backups` section.
 */
import { BlobStorageSchema, example, labels, recommend, showWhen, technical } from '@beamhop/core';
import { z } from 'zod';

export const MODULE_ID = 'lifecycle';

/** DocStore collections owned by this module. */
export const COL = {
  /** Backup catalog (`b-<ms>-<rand>`) + `last` status (read by insights health). */
  backups: 'lifecycle.backups',
  /** Per-relay retention sweep state (cursor, last complete run). */
  retention: 'lifecycle.retention',
  /** Last restore result. */
  restore: 'lifecycle.restore',
  /** Known-good marker per boot. */
  boot: 'lifecycle.boot',
} as const;

export const DEFAULT_LOW_VALUE_KINDS = [6, 7, 16];

export const StorageCapSchema = z
  .object({
    maxBytes: z.number().int().positive().describe('Most space posts may use on this relay'),
    autoPrune: technical(
      z
        .boolean()
        .default(false)
        .describe('Remove the oldest low-value posts automatically when the limit is reached'),
      'Off by default (suggestions, not autopilot §6.8): a card proposes `lifecycle.prune-storage` instead.',
    ),
    lowValueKinds: technical(
      z
        .array(z.number().int())
        .default(DEFAULT_LOW_VALUE_KINDS)
        .describe('Kinds of posts that may be removed first (reactions, reposts)'),
      'Event kinds pruned oldest-first: 6 repost, 7 reaction, 16 generic repost.',
    ),
    targetPercent: z
      .number()
      .int()
      .min(10)
      .max(100)
      .default(90)
      .describe('Prune down to this share of the limit'),
  })
  .describe('A storage limit for one relay');
export type StorageCap = z.infer<typeof StorageCapSchema>;

export const LifecycleConfigSchema = z
  .object({
    retention: z
      .object({
        enabled: z.boolean().default(true).describe('Remove old posts according to your rules'),
        intervalMinutes: z
          .number()
          .int()
          .min(1)
          .default(60)
          .describe('How often old posts are cleaned up, in minutes.'),
        chunkSize: technical(
          z
            .number()
            .int()
            .min(10)
            .max(5000)
            .default(500)
            .describe(
              'How many posts are removed in one step. Smaller steps are gentler on a busy server.',
            ),
          'Delete batch size per transaction.',
        ),
        maxEventsPerRun: technical(
          z
            .number()
            .int()
            .min(100)
            .default(20_000)
            .describe('Most posts checked per clean-up round; the rest wait for the next round.'),
          'Scan budget per relay per run; the sweep resumes from a stored cursor next run.',
        ),
      })
      .prefault({})
      .describe('Removing old posts'),
    /** Storage caps keyed by relay id (`*` applies to relays without their own entry). */
    storageCaps: technical(
      z
        .record(z.string(), StorageCapSchema)
        .default({})
        .describe('Storage limits per relay. Use "*" for every relay without its own limit.'),
      'Keyed by relay id; `*` is the fallback entry.',
    ),
    backups: z
      .object({
        format: recommend(
          technical(
            labels(z.enum(['auto', 'sqlite', 'ndjson']).default('auto'), {
              auto: 'Automatic (recommended)',
              sqlite: 'Database file copy',
              ndjson: 'Portable text export',
            }),
            'auto: SQLite file snapshot (VACUUM INTO) on Bun+SQLite, else logical NDJSON per table.',
          ),
          'auto',
          'Picks the fastest format your database supports.',
        ).describe('How the backup is written. Automatic picks the best one for your database.'),
        includeBlobBytes: z
          .boolean()
          .default(false)
          .describe('Also copy media files to the backup storage'),
        includeMetrics: z.boolean().default(true).describe('Include chart history'),
        includeSecrets: technical(
          z
            .boolean()
            .default(false)
            .describe('Keep passwords and keys in backups that are not encrypted'),
          'Without ports.keyWrapper archives are not encrypted, so secret-looking config fields (password, token, secret, key, salt, webhook, URL credentials) are masked unless this is on. Encrypted archives always keep them.',
        ),
        checkMinutes: z
          .number()
          .int()
          .min(1)
          .default(15)
          .describe('How often Beamhop checks whether a backup is due, in minutes.'),
      })
      .prefault({})
      .describe('Backup details (when and where are set under Backups)'),
    litestream: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Watch continuous replication to a standby (Litestream)'),
        metricsUrl: showWhen(
          example(
            technical(
              z
                .string()
                .default('http://127.0.0.1:9090/metrics')
                .describe('Where Beamhop reads the replication status from.'),
              'Litestream Prometheus metrics endpoint (litestream `addr`).',
            ),
            'http://127.0.0.1:9090/metrics',
          ),
          { path: 'enabled', equals: true },
        ),
        replica: showWhen(
          BlobStorageSchema.optional().describe(
            'Where the standby copy is stored. Empty = the backup storage.',
          ),
          { path: 'enabled', equals: true },
        ),
        path: showWhen(
          example(
            z
              .string()
              .default('beamhop/db')
              .describe('Folder inside the storage bucket for the copy.'),
            'beamhop/db',
          ),
          { path: 'enabled', equals: true },
        ),
        syncInterval: showWhen(
          technical(
            example(
              z
                .string()
                .default('1s')
                .describe(
                  'How often changes are copied, e.g. 1s or 10s. Shorter means less to lose.',
                ),
              '1s',
            ),
            'Litestream `sync-interval` (Go duration).',
          ),
          { path: 'enabled', equals: true },
        ),
        snapshotInterval: showWhen(
          technical(
            example(
              z.string().default('24h').describe('How often a full copy is made, e.g. 24h.'),
              '24h',
            ),
            'Litestream `snapshot-interval` (Go duration).',
          ),
          { path: 'enabled', equals: true },
        ),
        retention: showWhen(
          technical(
            example(
              z.string().default('72h').describe('How far back you can restore, e.g. 72h.'),
              '72h',
            ),
            'Litestream `retention` (Go duration).',
          ),
          { path: 'enabled', equals: true },
        ),
        lagWarnSeconds: showWhen(
          z
            .number()
            .int()
            .positive()
            .default(60)
            .describe('Warn when the copy falls this many seconds behind.'),
          { path: 'enabled', equals: true },
        ),
        lagCriticalSeconds: showWhen(
          z
            .number()
            .int()
            .positive()
            .default(300)
            .describe('Send an urgent alert when the copy falls this many seconds behind.'),
          { path: 'enabled', equals: true },
        ),
        checkSeconds: showWhen(
          z
            .number()
            .int()
            .positive()
            .default(30)
            .describe('How often the copy is checked, in seconds.'),
          { path: 'enabled', equals: true },
        ),
      })
      .prefault({})
      .describe('Live copy of the database to a standby server'),
    knownGood: technical(
      z
        .object({
          enabled: z
            .boolean()
            .default(true)
            .describe(
              'Remember settings that ran without problems, so safe mode can go back to them.',
            ),
          healthySeconds: z
            .number()
            .int()
            .positive()
            .default(300)
            .describe('How long the relay must run without urgent problems to count as healthy.'),
          checkSeconds: z
            .number()
            .int()
            .positive()
            .default(60)
            .describe('How often health is checked for this, in seconds.'),
        })
        .prefault({})
        .describe('Last known good settings (for safe mode)'),
      'After healthySeconds without a critical health result, admin.config.markKnownGood() is called; `beamhop --safe` boots that revision.',
    ),
  })
  .prefault({})
  .describe('Clean-up, storage limits and backups');
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;

export const SCHEDULE_SECONDS = { hourly: 3600, daily: 86_400, weekly: 7 * 86_400 } as const;
