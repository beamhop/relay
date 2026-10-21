// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules.lifecycle` — knobs for retention sweeps, storage caps,
 * backups, Litestream monitoring and known-good marking. The schedule, target
 * and "keep N" of backups live in the core `config.backups` section.
 */
import { BlobStorageSchema, technical } from '@beamhop/core';
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

export const StorageCapSchema = z.object({
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
});
export type StorageCap = z.infer<typeof StorageCapSchema>;

export const LifecycleConfigSchema = z
  .object({
    retention: z
      .object({
        enabled: z.boolean().default(true).describe('Remove old posts according to your rules'),
        intervalMinutes: z.number().int().min(1).default(60),
        chunkSize: z.number().int().min(10).max(5000).default(500),
        maxEventsPerRun: technical(
          z.number().int().min(100).default(20_000),
          'Scan budget per relay per run; the sweep resumes from a stored cursor next run.',
        ),
      })
      .prefault({}),
    /** Storage caps keyed by relay id (`*` applies to relays without their own entry). */
    storageCaps: z.record(z.string(), StorageCapSchema).default({}),
    backups: z
      .object({
        format: technical(
          z.enum(['auto', 'sqlite', 'ndjson']).default('auto'),
          'auto: SQLite file snapshot (VACUUM INTO) on Bun+SQLite, else logical NDJSON per table.',
        ),
        includeBlobBytes: z
          .boolean()
          .default(false)
          .describe('Also copy media files to the backup storage'),
        includeMetrics: z.boolean().default(true).describe('Include chart history'),
        checkMinutes: z.number().int().min(1).default(15),
      })
      .prefault({}),
    litestream: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Watch continuous replication to a standby (Litestream)'),
        metricsUrl: z.string().default('http://127.0.0.1:9090/metrics'),
        replica: BlobStorageSchema.optional(),
        path: z.string().default('beamhop/db'),
        syncInterval: z.string().default('1s'),
        snapshotInterval: z.string().default('24h'),
        retention: z.string().default('72h'),
        lagWarnSeconds: z.number().int().positive().default(60),
        lagCriticalSeconds: z.number().int().positive().default(300),
        checkSeconds: z.number().int().positive().default(30),
      })
      .prefault({}),
    knownGood: z
      .object({
        enabled: z.boolean().default(true),
        healthySeconds: z.number().int().positive().default(300),
        checkSeconds: z.number().int().positive().default(60),
      })
      .prefault({}),
  })
  .prefault({});
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;

export const SCHEDULE_SECONDS = { hourly: 3600, daily: 86_400, weekly: 7 * 86_400 } as const;
