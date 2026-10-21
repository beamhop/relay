// SPDX-License-Identifier: AGPL-3.0-or-later
/** `config.modules.media` — node-wide media pipeline tuning. Per-relay switches live in `relay.blossom`. */
import { labels, recommend, technical } from '@beamhop/core';
import { z } from 'zod';

export const MediaConfigSchema = z
  .object({
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(2)
      .describe('How many files are processed at the same time'),
    maxQueued: technical(
      z.number().int().min(1).max(100_000).default(200),
      'Backpressure: when this many jobs wait, new thumbnail/resize jobs are skipped (abuse scans are never skipped).',
    ).describe('How many files may wait for processing'),
    thumbnailSize: z
      .number()
      .int()
      .min(32)
      .max(1024)
      .default(320)
      .describe('Thumbnail size in pixels'),
    sizes: z
      .array(z.number().int().min(64).max(8192))
      .max(6)
      .default([640, 1280])
      .describe('Widths of the smaller copies made for phones and slow connections'),
    format: recommend(
      labels(z.enum(['webp', 'avif', 'jpeg']).default('webp'), {
        webp: 'WebP (small, works everywhere)',
        avif: 'AVIF (smallest, slower to make)',
        jpeg: 'JPEG (largest, works with very old apps)',
      }),
      'webp',
      'Small files that every current app can show.',
    ).describe('File type of the smaller copies'),
    quality: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(80)
      .describe('Quality of the copies (1–100). Lower makes smaller files but blurrier pictures.'),
    matchThreshold: technical(
      z.number().int().min(0).max(32).default(8),
      'Max Hamming distance (bits out of 64) between a pHash/dHash and a list entry to count as a match.',
    ).describe('How close a picture must be to a blocked one to be stopped'),
    scanWaitMs: technical(
      z.number().int().min(0).max(60_000).default(5000),
      'A GET for a blob whose abuse scan is still running waits up to this long, then gets 403 until the scan completes.',
    ).describe('How long a download may wait for a fresh upload to be checked'),
    listRefreshMinutes: z
      .number()
      .int()
      .min(5)
      .default(60)
      .describe('How often blocked-image lists are reloaded'),
    maxProcessBytes: z
      .number()
      .int()
      .positive()
      .default(200 * 1024 * 1024)
      .describe('Larger files are stored as-is without copies or checks'),
  })
  .prefault({})
  .describe('Photo and video processing');

export type MediaConfig = z.infer<typeof MediaConfigSchema>;
