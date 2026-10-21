// SPDX-License-Identifier: AGPL-3.0-or-later
/** Health check, attention cards and admin actions of the media pipeline. */
import {
  type ActionContext,
  type AttentionCard,
  type CardSource,
  type HealthCheck,
  type HealthResult,
  type Kernel,
  type RelayConfig,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import { processorNames } from './composite.ts';
import { MATCHES, type MatchRecord, type MediaService, mediaKind, scanGated } from './service.ts';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');

const INSTALL_SHARP =
  'sharp (optional dependency of @beamhop/media) could not be loaded. From source: `bun add sharp`. Single binary: use the release archive that ships node_modules/ next to `beamhop` (scripts/build.ts --with-sharp), or point BEAMHOP_SHARP_PATH at a node_modules containing sharp. The Docker image includes it. ffmpeg on PATH enables video transcoding.';

function relaysFor(kernel: Kernel, relayId: string | null): RelayConfig[] {
  const all = kernel.config().relays.filter((r) => r.blossom.enabled);
  return relayId ? all.filter((r) => r.id === relayId) : all;
}

const wantsImages = (r: RelayConfig) =>
  r.blossom.optimize.thumbnails || r.blossom.optimize.resize || r.goals.media >= 50;

export function mediaHealthCheck(kernel: Kernel, svc: MediaService): HealthCheck {
  return {
    id: 'media.pipeline',
    subsystem: 'blossom',
    weight: 1,
    async run(relayId): Promise<HealthResult> {
      const relays = relaysFor(kernel, relayId);
      const tools = processorNames(svc.processor);
      const supports = svc.processor?.supports ?? [];
      const q = svc.queue.stats();
      const lists = svc.lists.status();
      const technical = [
        `tools: ${tools.join(', ') || 'none'}`,
        `ops: ${supports.join(', ') || 'none'}`,
        `queue: ${q.queued} waiting, ${q.running} running, ${q.dropped} skipped, ${q.failed} failed`,
        `lists: ${lists.map((l) => `${l.source} (${l.entries.length}${l.error ? `, error: ${l.error}` : ''})`).join('; ') || 'none'}`,
      ].join(' · ');
      if (relays.length === 0) {
        return { score: 100, status: 'ok', message: 'Media hosting is turned off', technical };
      }
      const issues: Array<{ score: number; status: HealthResult['status']; message: string }> = [];
      if (relays.some(scanGated) && !supports.includes('perceptual-hash')) {
        issues.push({
          score: 20,
          status: 'critical',
          message: 'Uploads cannot be checked against blocked-image lists: image tools are missing',
        });
      }
      const gatedSources = new Set(
        relays.filter(scanGated).flatMap((r) => r.blossom.scanning.lists),
      );
      const broken = lists.filter((l) => gatedSources.has(l.source) && l.error);
      if (broken.length) {
        issues.push({
          score: broken.every((l) => l.entries.length === 0) ? 30 : 70,
          status: broken.every((l) => l.entries.length === 0) ? 'critical' : 'warn',
          message: `${broken.length} blocked-image list${broken.length === 1 ? '' : 's'} could not be loaded`,
        });
      }
      if (relays.some(wantsImages) && !supports.includes('resize')) {
        issues.push({
          score: 70,
          status: 'warn',
          message:
            'Photo thumbnails and smaller copies are unavailable (image tools not installed)',
        });
      }
      if (relays.some((r) => r.blossom.optimize.transcode) && !supports.includes('transcode')) {
        issues.push({
          score: 80,
          status: 'warn',
          message: 'Video conversion is unavailable (ffmpeg not installed)',
        });
      }
      if (q.queued >= q.maxQueued * 0.8) {
        issues.push({
          score: 60,
          status: 'warn',
          message: 'Media processing is falling behind; some copies are being skipped',
        });
      }
      if (issues.length === 0) {
        return { score: 100, status: 'ok', message: 'Media processing is working', technical };
      }
      issues.sort((a, b) => a.score - b.score);
      const worst = issues[0] as (typeof issues)[number];
      return {
        score: worst.score,
        status: worst.status,
        message: issues.map((i) => i.message).join('. '),
        technical: supports.includes('resize') ? technical : `${technical} · ${INSTALL_SHARP}`,
      };
    },
  };
}

export function mediaCards(kernel: Kernel, svc: MediaService): CardSource {
  return {
    id: 'media',
    async cards(relayId) {
      const supports = svc.processor?.supports ?? [];
      const now = kernel.ports.clock.now();
      const out: AttentionCard[] = [];
      for (const r of relaysFor(kernel, relayId)) {
        if (scanGated(r) && !supports.includes('perceptual-hash')) {
          out.push({
            id: `media.scan-unavailable:${r.id}`,
            relayId: r.id,
            severity: 'critical',
            title: 'Uploads are not being checked for abuse images',
            body: 'You set up blocked-image lists, but the image tools needed to check uploads are not installed on this server.',
            technical: INSTALL_SHARP,
            batchKey: 'media.tools-missing',
            createdAt: now,
          });
        } else if (wantsImages(r) && !supports.includes('resize')) {
          out.push({
            id: `media.sharp-missing:${r.id}`,
            relayId: r.id,
            severity: 'warning',
            title: 'Photo resizing is not available',
            body: 'Your media goals ask for thumbnails and smaller copies of photos, but the image tools are not installed. Photos are still stored and shared as they are.',
            technical: INSTALL_SHARP,
            batchKey: 'media.tools-missing',
            createdAt: now,
          });
        }
        if (r.blossom.optimize.transcode && !supports.includes('transcode')) {
          out.push({
            id: `media.ffmpeg-missing:${r.id}`,
            relayId: r.id,
            severity: 'info',
            title: 'Video conversion is not available',
            body: 'Videos are stored as uploaded. Install ffmpeg on the server to make versions that play everywhere.',
            technical:
              'No `ffmpeg` binary found on PATH (Bun runtime only; not available on Cloudflare).',
            batchKey: 'media.tools-missing',
            createdAt: now,
          });
        }
      }
      return out;
    },
  };
}

function relayOf(kernel: Kernel, ctx: ActionContext): RelayConfig {
  if (!ctx.relayId) throw new Error('Pick a relay first');
  const relay = kernel.relay(ctx.relayId);
  if (!relay) throw new Error(`Unknown relay: ${ctx.relayId}`);
  return relay;
}

async function blobType(kernel: Kernel, relayId: string, sha256: string): Promise<string> {
  const owners = await kernel.ports.blobIndex.owners(relayId, sha256);
  const o = owners[0];
  if (!o) throw new Error('This file is not on this relay');
  return o.type;
}

export function registerActions(kernel: Kernel, svc: MediaService): void {
  const Sha = z.object({ sha256: hex64.describe('The file hash') });

  kernel.actions.register(
    defineAction({
      id: 'media.rescan',
      title: 'Check a file against blocked-image lists again',
      description:
        'Re-check one image against this relay’s blocked-image lists. A match blocks it.',
      technical:
        'Recomputes pHash/dHash (DCT on 32×32 grayscale; 9×8 gradient) and compares against blossom.scanning.lists with the configured Hamming threshold; a match quarantines the blob (blob.quarantined).',
      scope: 'relay',
      permission: 'moderation.write',
      input: Sha,
      keywords: ['scan', 'csam', 'abuse', 'hash', 'phash', 'media'],
      async preview(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const type = await blobType(kernel, relay.id, input.sha256);
        if (mediaKind(type) !== 'image') {
          return [{ kind: 'info', text: 'Only images can be checked. Nothing will change.' }];
        }
        return [
          {
            kind: 'info',
            text: 'The image is checked again. If it matches a blocked image it is hidden from everyone.',
            technical: `lists: ${relay.blossom.scanning.lists.join(', ') || 'none configured'}`,
          },
        ];
      },
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const type = await blobType(kernel, relay.id, input.sha256);
        const m = await svc.scan(relay.id, input.sha256, type, { force: true });
        return {
          output: { matched: !!m, match: m },
          summary: m ? 'The file matched a blocked image and was blocked' : 'No match found',
        };
      },
    }),
  );

  kernel.actions.register(
    defineAction({
      id: 'media.regenerate-variants',
      title: 'Remake thumbnail and smaller copies',
      description:
        'Make the thumbnail and phone-sized copies of a photo (or video versions) again.',
      technical:
        'Re-runs thumbnail/resize (sharp) or transcode/poster (ffmpeg) and records results in docs `media.variants` (keyed by original sha256).',
      scope: 'relay',
      permission: 'media.write',
      input: Sha,
      keywords: ['thumbnail', 'resize', 'variants', 'transcode', 'media'],
      async preview(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const type = await blobType(kernel, relay.id, input.sha256);
        const ops = svc.variantOps(relay, type);
        if (ops.length === 0) {
          return [{ kind: 'info', text: 'No copies are made for this file. Nothing will change.' }];
        }
        return ops.map(({ op, role }) => ({
          kind: 'add' as const,
          text:
            role === 'thumbnail'
              ? 'Make a thumbnail'
              : role === 'responsive'
                ? `Make a ${op.width}px wide copy`
                : role === 'poster'
                  ? 'Make a preview picture'
                  : 'Make a version that plays everywhere',
          technical: JSON.stringify(op),
        }));
      },
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const type = await blobType(kernel, relay.id, input.sha256);
        const rec = await svc.generateVariants(relay.id, input.sha256, type, { force: true });
        const n = rec?.variants.length ?? 0;
        return {
          output: rec,
          summary: n ? `Made ${n} cop${n === 1 ? 'y' : 'ies'}` : 'No copies were made',
        };
      },
    }),
  );

  kernel.actions.register(
    defineAction({
      id: 'media.list-matches',
      title: 'Blocked-image matches',
      description: 'Uploads that matched a blocked-image list and were blocked.',
      technical: 'Reads docs `media.matches` (newest first).',
      scope: 'relay',
      permission: 'moderation.write',
      readOnly: true,
      input: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
      keywords: ['csam', 'abuse', 'matches', 'quarantine', 'media'],
      async run(input, ctx) {
        const page = await kernel.ports.docs.list<MatchRecord>(MATCHES, {
          reverse: true,
          limit: 1000,
        });
        const items = page.items
          .map((i) => i.value)
          .filter((m) => !ctx.relayId || m.relayId === ctx.relayId)
          .slice(0, input.limit);
        return {
          output: { items },
          summary: `${items.length} match${items.length === 1 ? '' : 'es'}`,
        };
      },
    }),
  );
}
