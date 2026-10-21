// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules.blossom` — node-wide media storage settings (bytes are shared
 * by every relay on the node). Per-relay switches live in `relay.blossom`.
 * Safe default: tiering off (no cold store), no storage caps.
 */
import { BlobStorageSchema, labels, recommend, technical } from '@beamhop/core';
import { z } from 'zod';

const bytes = (d: string) => z.number().int().positive().optional().describe(d);

export const ColdTierSchema = z
  .object({
    store: BlobStorageSchema.describe(
      'Where older files go. Usually a cheaper cloud bucket (for example Cloudflare R2 or S3).',
    ),
    afterDays: technical(
      z
        .number()
        .int()
        .min(1)
        .max(3650)
        .default(30)
        .describe('Move a file to cheaper storage after this many days without anyone opening it.'),
      'Days since the last GET (tracked per sha256 in docs `blossom.tiers`, else the newest BlobIndex uploadedAt).',
    ),
    minSizeBytes: technical(
      z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe(
          'Only move files at least this big, in bytes. Small files are cheap to keep close.',
        ),
      'Blobs smaller than this stay in the hot store.',
    ),
    maxBytes: bytes('Most the cheaper storage may hold, in bytes. Empty = no limit.'),
    promoteOnAccess: technical(
      z
        .boolean()
        .default(false)
        .describe('Bring a file back to fast storage when someone opens it again.'),
      'On a GET served from the cold store, copy it back to the hot store in the background (if hot has room) and delete the cold copy.',
    ),
  })
  .describe('Cheaper storage for files nobody has opened in a while');

export const TiersSchema = z
  .object({
    hot: z
      .object({
        maxBytes: technical(
          bytes('Most this server’s main file storage may hold, in bytes. Empty = no limit.'),
          'Cap on the hot BlobStore (usage counted by the tiering job).',
        ),
      })
      .prefault({})
      .describe('Main (fast) file storage'),
    cold: ColdTierSchema.optional(),
    whenHotFull: recommend(
      technical(
        labels(z.enum(['cold', 'refuse']).default('cold'), {
          cold: 'Put new uploads in the cheaper storage',
          refuse: 'Refuse new uploads with a clear message',
        }).describe('What happens to new uploads when the main storage is full.'),
        'refuse → HTTP 507 with X-Reason; cold needs tiers.cold.',
      ),
      'cold',
      'Uploads keep working while you add space.',
    ),
  })
  .prefault({})
  .describe('Fast and cheaper storage for media files');

export const BlossomConfigSchema = z
  .object({ tiers: TiersSchema })
  .prefault({})
  .describe('Media storage');

export type BlossomConfig = z.infer<typeof BlossomConfigSchema>;
export type TiersConfig = z.infer<typeof TiersSchema>;
export type ColdTierConfig = z.infer<typeof ColdTierSchema>;
