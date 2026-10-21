// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin actions, health check and GC job for Blossom media hosting. */
import {
  type ActionContext,
  type BlobOwnership,
  type DiffLine,
  type HealthCheck,
  type Kernel,
  type RelayConfig,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import type { BlossomService } from './service.ts';
import { formatBytes } from './util.ts';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');

function relayOf(kernel: Kernel, ctx: ActionContext): RelayConfig {
  if (!ctx.relayId) throw new Error('Pick a relay first');
  const relay = kernel.relay(ctx.relayId);
  if (!relay) throw new Error(`Unknown relay: ${ctx.relayId}`);
  return relay;
}

const UNDO_SECONDS = 15 * 60;

export function registerActions(kernel: Kernel, svc: BlossomService): void {
  const ports = kernel.ports;

  const DeleteInput = z.object({
    sha256: hex64.describe('The file hash'),
    pubkey: hex64.optional().describe('Only remove this person’s copy (default: everyone’s)'),
    reason: z.string().max(500).optional(),
  });

  const targets = async (relayId: string, input: z.infer<typeof DeleteInput>) =>
    (await ports.blobIndex.owners(relayId, input.sha256)).filter(
      (o) => !input.pubkey || o.pubkey === input.pubkey,
    );

  kernel.actions.register(
    defineAction({
      id: 'media.delete-blob',
      title: 'Delete a media file',
      description: 'Remove a file from this relay. It is erased from storage once nobody uses it.',
      technical:
        'Removes BlobIndex ownership rows for (relay, sha256[, pubkey]); bytes are GC’d from the BlobStore when refCount reaches 0 (BUD-02 delete semantics).',
      scope: 'relay',
      permission: 'media.write',
      input: DeleteInput,
      bulk: true,
      keywords: ['blob', 'blossom', 'file', 'remove', 'media'],
      shortcut: '#',
      async preview(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const rows = await targets(relay.id, input);
        if (rows.length === 0) {
          return [{ kind: 'info', text: 'This file is not on this relay. Nothing will change.' }];
        }
        const size = rows[0]?.size ?? 0;
        const total = await ports.blobIndex.refCount(input.sha256);
        const lines: DiffLine[] = [
          {
            kind: 'remove',
            text: `Remove ${rows.length === 1 ? 'one upload' : `${rows.length} uploads`} of this file (${formatBytes(size)})`,
            technical: `blobIndex.removeOwner × ${rows.length} for ${input.sha256}`,
          },
        ];
        lines.push(
          total - rows.length <= 0
            ? {
                kind: 'warning',
                text: 'The file will be erased from storage. This cannot be undone.',
                technical: 'refCount → 0: BlobStore.delete',
              }
            : {
                kind: 'info',
                text: 'The file stays stored because it is still used elsewhere.',
                technical: `refCount ${total} → ${total - rows.length}`,
              },
        );
        return lines;
      },
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const rows = await targets(relay.id, input);
        let erased = false;
        for (const o of rows) {
          const r = await svc.removeOwnership(relay.id, o.sha256, o.pubkey, 'admin');
          erased ||= r.erased;
        }
        const summary =
          rows.length === 0
            ? 'Nothing to delete'
            : erased
              ? 'File deleted and erased from storage'
              : 'File removed from this relay';
        return {
          output: { removed: rows.length, erased },
          summary,
          undo:
            rows.length && !erased
              ? {
                  actionId: 'media.delete-blob',
                  payload: { rows },
                  expiresAt: ports.clock.now() + UNDO_SECONDS,
                }
              : undefined,
        };
      },
      async undo(payload) {
        const { rows } = payload as { rows: BlobOwnership[] };
        const sha = rows[0]?.sha256;
        if (!sha || !(await ports.blobs.head(sha))) {
          throw new Error('The file was erased from storage and cannot be restored');
        }
        for (const o of rows) await ports.blobIndex.addOwner(o);
      },
    }),
  );

  kernel.actions.register(
    defineAction({
      id: 'media.list-blobs',
      title: 'List media files',
      description: 'See files uploaded to this relay, optionally for one person.',
      technical: 'BlobIndex.list / listByOwner for the relay (BUD-02 /list equivalent).',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({
        pubkey: hex64.optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      keywords: ['blob', 'blossom', 'files', 'uploads', 'media'],
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        let items: BlobOwnership[];
        let cursor: string | undefined;
        if (input.pubkey) {
          items = await ports.blobIndex.listByOwner(relay.id, input.pubkey, {
            limit: input.limit,
          });
        } else {
          const page = await ports.blobIndex.list(relay.id, {
            cursor: input.cursor,
            limit: input.limit,
          });
          items = page.items;
          cursor = page.cursor;
        }
        const quarantined = new Set<string>();
        for (const i of items) if (await svc.quarantined(i.sha256)) quarantined.add(i.sha256);
        return {
          output: {
            items: items.map((i) => ({ ...i, quarantined: quarantined.has(i.sha256) })),
            cursor,
          },
          summary: `${items.length} file${items.length === 1 ? '' : 's'}`,
        };
      },
    }),
  );

  const QuotaInput = z.object({
    pubkey: hex64.describe('Whose storage limit to change'),
    quotaBytes: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('New limit in bytes, or empty to go back to their tier’s default'),
  });

  const describeQuota = (q: number | undefined, fallback: number) =>
    q === undefined ? `tier default (${formatBytes(fallback)})` : formatBytes(q);

  kernel.actions.register(
    defineAction({
      id: 'media.set-quota',
      title: 'Change someone’s storage limit',
      description: 'Give one person more (or less) space for media uploads on this relay.',
      technical:
        'Per-pubkey override stored in docs `blossom.quotas`; beats tier.blobQuotaBytes, relay blossom.defaultQuotaBytes and limits.defaultBlobQuotaBytes.',
      scope: 'relay',
      permission: 'media.write',
      input: QuotaInput,
      keywords: ['quota', 'storage', 'limit', 'blossom', 'media'],
      async preview(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const limits = await svc.limitsFor(relay, input.pubkey);
        const current = await svc.quotaOverride(relay.id, input.pubkey);
        const tierDefault = await defaultQuota(relay, input.pubkey);
        const next = input.quotaBytes ?? undefined;
        const lines: DiffLine[] = [
          {
            kind: 'change',
            text: `Storage limit: ${describeQuota(current, tierDefault)} → ${describeQuota(next, tierDefault)}`,
            technical: `docs ${'blossom.quotas'}[${relay.id}:${input.pubkey}].quotaBytes: ${current ?? 'unset'} → ${next ?? 'unset'}`,
          },
        ];
        const effective = next ?? tierDefault;
        if (limits.usedBytes > effective) {
          lines.push({
            kind: 'warning',
            text: `They already use ${formatBytes(limits.usedBytes)}, so new uploads will be refused. Existing files stay.`,
          });
        }
        return lines;
      },
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const previous = await svc.quotaOverride(relay.id, input.pubkey);
        await svc.setQuotaOverride(relay.id, input.pubkey, input.quotaBytes);
        return {
          output: { previous: previous ?? null, quotaBytes: input.quotaBytes },
          summary:
            input.quotaBytes === null
              ? 'Storage limit reset to tier default'
              : `Storage limit set to ${formatBytes(input.quotaBytes)}`,
          undo: {
            actionId: 'media.set-quota',
            payload: { relayId: relay.id, pubkey: input.pubkey, quotaBytes: previous ?? null },
            expiresAt: ports.clock.now() + UNDO_SECONDS,
          },
        };
      },
      async undo(payload) {
        const p = payload as { relayId: string; pubkey: string; quotaBytes: number | null };
        await svc.setQuotaOverride(p.relayId, p.pubkey, p.quotaBytes);
      },
    }),
  );

  /** Quota the person would have without an override. */
  async function defaultQuota(relay: RelayConfig, pubkey: string): Promise<number> {
    const tier = await svc.tierOf(relay, pubkey);
    const tierDef = relay.tiers.find((t) => t.id === tier);
    return (
      tierDef?.blobQuotaBytes ??
      relay.blossom.defaultQuotaBytes ??
      kernel.limits(relay.id, tier).defaultBlobQuotaBytes
    );
  }
}

export function blossomHealthCheck(kernel: Kernel): HealthCheck {
  return {
    id: 'blossom.storage',
    subsystem: 'blossom',
    weight: 1,
    async run(relayId) {
      const relay = relayId ? kernel.relay(relayId) : undefined;
      if (relay && !relay.blossom.enabled) {
        return { score: 100, status: 'ok', message: 'Media hosting is turned off' };
      }
      const started = kernel.ports.clock.nowMs();
      try {
        await kernel.ports.blobs.list({ limit: 1 });
      } catch (err) {
        return {
          score: 0,
          status: 'critical',
          message: 'Media storage is not reachable',
          technical: `${kernel.ports.blobs.kind} BlobStore.list failed: ${String(err)}`,
        };
      }
      const ms = kernel.ports.clock.nowMs() - started;
      const slow = ms > 2000;
      return {
        score: slow ? 70 : 100,
        status: slow ? 'warn' : 'ok',
        message: slow ? 'Media storage is responding slowly' : 'Media storage is working',
        technical: `${kernel.ports.blobs.kind} BlobStore.list in ${ms} ms`,
      };
    },
  };
}
