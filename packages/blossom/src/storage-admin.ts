// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin actions for media storage (§6.1): storage tiers + "move now", cleanup
 * (orphan GC) status, and the quarantine review flow (list, safe preview,
 * release, confirm-and-block). Plus the tier health check and attention card.
 */
import {
  type ActionContext,
  type AttentionCard,
  type CardSource,
  type DiffLine,
  type HealthCheck,
  type Kernel,
  type RelayConfig,
  type RelayId,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import {
  BLOCKED,
  type BlockedRecord,
  type BlossomService,
  HELD,
  QUARANTINE,
  type QuarantineRecord,
  isAbuseMatch,
} from './service.ts';
import { TIER_CRITICAL, TIER_WARN, type TieringService } from './tiering.ts';
import { formatBytes } from './util.ts';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');
const PERSON = /^[0-9a-f]{64}$/;
const UNDO_SECONDS = 15 * 60;
/** Released quarantines (audit + undo): sha256 → ReleasedRecord. */
export const RELEASED = 'blossom.released';
/** Largest image the admin app may preview from quarantine (bytes). */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const ABUSE_TEXT = 'Matched a known-abuse list';

interface ReleasedRecord {
  previous: QuarantineRecord;
  relayId: RelayId;
  by: string;
  note?: string;
  at: number;
}

/** Structural view of the policy module's moderation queue (optional). */
interface PolicyQueueLike {
  queue?: {
    get(relayId: RelayId, id: string): Promise<{ status: string } | null>;
    setStatus(
      relayId: RelayId,
      id: string,
      status: 'pending' | 'kept' | 'removed',
      by: string,
    ): Promise<unknown>;
  };
}

function relayOf(kernel: Kernel, ctx: ActionContext): RelayConfig {
  if (!ctx.relayId) throw new Error('Pick a relay first');
  const relay = kernel.relay(ctx.relayId);
  if (!relay) throw new Error(`Unknown relay: ${ctx.relayId}`);
  return relay;
}

export type QuarantineSource = 'abuse-list' | 'rule' | 'other';

export function quarantineSource(q: QuarantineRecord): QuarantineSource {
  if (isAbuseMatch(q)) return 'abuse-list';
  return q.by ? 'rule' : 'other';
}

export interface QuarantineItem {
  sha256: string;
  size: number | null;
  type: string | null;
  /** First uploader on this relay (pubkey or "anonymous"), or null. */
  uploader: string | null;
  uploaders: number;
  /** Plain reason. Abuse matches always say only "Matched a known-abuse list". */
  reason: string;
  source: QuarantineSource;
  abuse: boolean;
  /** Images that may be previewed (blurred) with `media.quarantine-preview`. */
  previewable: boolean;
  at: number;
  technical: string;
}

export function registerStorageActions(
  kernel: Kernel,
  svc: BlossomService,
  tiering: TieringService,
): void {
  const ports = kernel.ports;

  const policyQueue = () => kernel.use<PolicyQueueLike>('policy')?.queue;
  const setQueueStatus = async (
    relayId: RelayId,
    sha256: string,
    status: 'pending' | 'kept' | 'removed',
    by: string,
  ): Promise<string | null> => {
    const q = policyQueue();
    if (!q) return null;
    const id = `blob-${sha256}`;
    const item = await q.get(relayId, id).catch(() => null);
    if (!item) return null;
    await q.setStatus(relayId, id, status, by);
    return item.status;
  };

  async function describe(relayId: RelayId, sha256: string, q: QuarantineRecord) {
    const owners = await ports.blobIndex.owners(relayId, sha256);
    const meta = owners[0] ?? (await ports.blobs.head(sha256));
    const abuse = isAbuseMatch(q);
    const type = meta?.type ?? null;
    const item: QuarantineItem = {
      sha256,
      size: meta?.size ?? null,
      type,
      uploader: owners[0]?.pubkey ?? null,
      uploaders: owners.length,
      reason: abuse ? ABUSE_TEXT : q.reason,
      source: quarantineSource(q),
      abuse,
      previewable:
        !abuse &&
        !!type &&
        type.startsWith('image/') &&
        type !== 'image/svg+xml' &&
        (meta?.size ?? Number.POSITIVE_INFINITY) <= PREVIEW_MAX_BYTES,
      at: q.at,
      technical: `docs blossom.quarantine[${sha256}] by=${q.by ?? 'unknown'} relay=${q.relayId}${abuse ? ' (hash-list match; bytes never shown)' : ''}`,
    };
    return { item, owners };
  }

  // ───────────── quarantine ─────────────

  kernel.actions.register(
    defineAction({
      id: 'media.list-quarantine',
      title: 'Quarantined files',
      description:
        'Files that were held back for review. Files that matched a known-abuse list are never shown.',
      technical:
        'docs `blossom.quarantine` filtered to blobs owned on this relay (or flagged here). source: abuse-list (media.scan pHash/dHash match), rule (policy onUpload hold/shadow), other.',
      scope: 'relay',
      permission: 'moderation.write',
      readOnly: true,
      keywords: ['quarantine', 'held', 'review', 'abuse', 'media', 'files'],
      input: z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const items: QuarantineItem[] = [];
        let cursor = input.cursor;
        let guard = 0;
        do {
          const page = await ports.docs.list<QuarantineRecord>(QUARANTINE, {
            cursor,
            limit: 200,
          });
          for (const { key, value } of page.items) {
            const d = await describe(relay.id, key, value);
            if (d.owners.length === 0 && value.relayId !== relay.id) continue;
            items.push(d.item);
            if (items.length >= input.limit) break;
          }
          cursor = page.items.length ? page.cursor : undefined;
          if (items.length >= input.limit) break;
        } while (cursor && ++guard < 50);
        items.sort((a, b) => b.at - a.at);
        return {
          output: { items, cursor: items.length >= input.limit ? cursor : undefined },
          summary: `${items.length} quarantined file${items.length === 1 ? '' : 's'}`,
        };
      },
    }),
  );

  kernel.actions.register(
    defineAction({
      id: 'media.quarantine-preview',
      title: 'Preview a quarantined picture',
      description:
        'Load a small copy of a held picture so you can decide. Not available for files that matched a known-abuse list.',
      technical: `Returns a data: URL of the image bytes (≤ ${PREVIEW_MAX_BYTES} bytes, images except SVG). Refused for abuse-list matches. Quarantined files are otherwise never served (BUD-01 GET → 403).`,
      scope: 'relay',
      permission: 'moderation.write',
      readOnly: true,
      input: z.object({ sha256: hex64 }),
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const q = await svc.quarantined(input.sha256);
        if (!q) throw new Error('This file is not quarantined');
        const { item } = await describe(relay.id, input.sha256, q);
        if (item.abuse) throw new Error('Files that matched a known-abuse list are never shown');
        if (!item.previewable || !item.type) throw new Error('This file cannot be previewed');
        const body = await ports.blobs.get(input.sha256);
        if (!body) throw new Error('The file is no longer stored');
        const bytes = new Uint8Array(await new Response(body.body).arrayBuffer());
        if (bytes.byteLength > PREVIEW_MAX_BYTES)
          throw new Error('This file is too big to preview');
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return {
          output: { dataUrl: `data:${item.type};base64,${btoa(bin)}`, type: item.type },
          summary: 'Preview loaded',
        };
      },
    }),
  );

  const ReleaseInput = z.object({
    sha256: hex64.describe('The file hash'),
    note: z.string().max(500).optional().describe('Why it is fine (kept with the decision)'),
  });

  kernel.actions.register(
    defineAction({
      id: 'media.release-quarantine',
      title: 'Release a quarantined file',
      description: 'The file was held by mistake: make it available again.',
      technical:
        'Deletes docs `blossom.quarantine[sha256]` (BUD-01 GET serves it again), records docs `blossom.released`, marks the policy queue item `blob-<sha256>` kept. Undo re-quarantines.',
      scope: 'relay',
      permission: 'moderation.write',
      bulk: true,
      keywords: ['quarantine', 'release', 'approve', 'allow', 'media'],
      input: ReleaseInput,
      async preview(input, ctx) {
        relayOf(kernel, ctx);
        const q = await svc.quarantined(input.sha256);
        if (!q)
          return [{ kind: 'info', text: 'This file is not quarantined. Nothing will change.' }];
        const lines: DiffLine[] = [
          {
            kind: 'change',
            text: 'The file will be available to everyone again',
            technical: `docs blossom.quarantine[${input.sha256}] deleted (reason was: ${q.reason})`,
          },
        ];
        if (isAbuseMatch(q)) {
          lines.push({
            kind: 'warning',
            text: `${ABUSE_TEXT}. Only release it if you are certain the match is wrong.`,
            technical: `quarantined by ${q.by ?? 'unknown'}`,
          });
        }
        return lines;
      },
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const q = await svc.quarantined(input.sha256);
        if (!q) return { output: { released: false }, summary: 'This file is not quarantined' };
        const by = ctx.principal.id;
        await ports.docs.delete(QUARANTINE, input.sha256);
        const rec: ReleasedRecord = {
          previous: q,
          relayId: relay.id,
          by,
          at: ports.clock.now(),
          ...(input.note ? { note: input.note } : {}),
        };
        await ports.docs.put(RELEASED, input.sha256, rec);
        const queueWas = await setQueueStatus(relay.id, input.sha256, 'kept', by);
        return {
          output: { released: true },
          summary: 'File released',
          undo: {
            actionId: 'media.release-quarantine',
            payload: { sha256: input.sha256, previous: q, relayId: relay.id, queueWas },
            expiresAt: ports.clock.now() + UNDO_SECONDS,
          },
        };
      },
      async undo(payload, ctx) {
        const p = payload as {
          sha256: string;
          previous: QuarantineRecord;
          relayId: RelayId;
          queueWas: 'pending' | 'kept' | 'removed' | null;
        };
        await ports.docs.put(QUARANTINE, p.sha256, p.previous);
        await ports.docs.delete(RELEASED, p.sha256);
        if (p.queueWas) await setQueueStatus(p.relayId, p.sha256, p.queueWas, ctx.principal.id);
      },
    }),
  );

  const ConfirmInput = z.object({
    sha256: hex64.describe('The file hash'),
    banUploader: z
      .boolean()
      .default(false)
      .describe('Also block whoever uploaded it from posting and uploading here'),
  });

  kernel.actions.register(
    defineAction({
      id: 'media.confirm-quarantine',
      title: 'Delete a quarantined file for good',
      description:
        'The file is not allowed: delete it and refuse it if anyone uploads it again. This cannot be undone.',
      technical:
        'Removes this relay’s BlobIndex owners (bytes erased when refCount reaches 0 and no legal hold), adds sha256 to docs `blossom.blocked` (upload/mirror of the same bytes → 403), marks the policy queue item removed, optionally runs moderation.ban-pubkey. Abuse-list matches raise a safety notification (the existing reporting hook). No undo.',
      scope: 'relay',
      permission: 'moderation.write',
      bulk: true,
      keywords: ['quarantine', 'delete', 'confirm', 'block', 'abuse', 'media'],
      input: ConfirmInput,
      async preview(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const q = await svc.quarantined(input.sha256);
        if (!q && !(await svc.blocked(input.sha256)))
          return [{ kind: 'info', text: 'This file is not quarantined. Nothing will change.' }];
        const owners = await ports.blobIndex.owners(relay.id, input.sha256);
        const total = await ports.blobIndex.refCount(input.sha256);
        const held =
          (await svc.bytesHeld(input.sha256)) || (await svc.heldAfterRemoval(input.sha256));
        const size = owners[0]?.size ?? (await ports.blobs.head(input.sha256))?.size ?? 0;
        const lines: DiffLine[] = [
          {
            kind: 'remove',
            text: `The file (${formatBytes(size)}) is deleted from this relay`,
            technical: `blobIndex.removeOwner × ${owners.length}`,
          },
          {
            kind: 'add',
            text: 'Anyone uploading the same file again is refused',
            technical: `docs blossom.blocked[${input.sha256}]`,
          },
        ];
        if (held) {
          lines.push({
            kind: 'warning',
            text: 'A legal hold keeps the stored bytes until the hold ends. Nobody can open the file meanwhile.',
            technical: 'lifecycle.holds isHeld(sha256)',
          });
        } else if (total - owners.length > 0) {
          lines.push({
            kind: 'info',
            text: 'Another relay on this server still has it, so it stays stored there (and stays quarantined).',
            technical: `refCount ${total} → ${total - owners.length}`,
          });
        }
        const people = owners.map((o) => o.pubkey).filter((p) => PERSON.test(p));
        if (input.banUploader) {
          lines.push(
            people.length && kernel.actions.get('moderation.ban-pubkey')
              ? {
                  kind: 'add',
                  text: `${people.length === 1 ? 'The uploader is' : `${people.length} uploaders are`} blocked from posting and uploading here`,
                  technical: 'moderation.ban-pubkey',
                }
              : {
                  kind: 'info',
                  text: 'Nobody to block (anonymous upload or blocking unavailable)',
                },
          );
        }
        lines.push({ kind: 'warning', text: 'This cannot be undone.' });
        return lines;
      },
      async run(input, ctx) {
        const relay = relayOf(kernel, ctx);
        const q = await svc.quarantined(input.sha256);
        const already = await svc.blocked(input.sha256);
        if (!q && !already) throw new Error('This file is not quarantined');
        const abuse = q ? isAbuseMatch(q) : (already?.abuse ?? false);
        const by = ctx.principal.id;
        const owners = await ports.blobIndex.owners(relay.id, input.sha256);
        let erased = false;
        for (const o of owners) {
          const r = await svc.removeOwnership(relay.id, o.sha256, o.pubkey, 'quarantine-confirmed');
          erased ||= r.erased;
        }
        const block: BlockedRecord = {
          relayId: relay.id,
          by,
          reason: q?.reason ?? already?.reason ?? 'Confirmed by a moderator',
          abuse,
          at: ports.clock.now(),
        };
        await ports.docs.put(BLOCKED, input.sha256, block);
        await setQueueStatus(relay.id, input.sha256, 'removed', by);
        let banned = 0;
        const people = [...new Set(owners.map((o) => o.pubkey).filter((p) => PERSON.test(p)))];
        const ban = kernel.actions.get('moderation.ban-pubkey');
        if (input.banUploader && people.length && ban) {
          const banInput = ban.input.parse({
            pubkeys: people,
            reason: 'Uploaded a file that was deleted after review',
          });
          await ban.run(banInput, ctx);
          banned = people.length;
        }
        if (abuse) {
          // Existing reporting hook: safety notification to the admins (never public).
          try {
            await kernel.notify({
              severity: 'critical',
              category: 'safety',
              title: 'A blocked image was deleted for good',
              body: 'A file that matched a known-abuse list was deleted after review and will be refused if uploaded again.',
              relayId: relay.id,
            });
          } catch (err) {
            ports.logger.log('error', 'quarantine confirm notify failed', { error: String(err) });
          }
        }
        return {
          output: { removed: owners.length, erased, blocked: true, banned },
          summary: erased
            ? 'File deleted for good and blocked'
            : owners.length
              ? 'File removed from this relay and blocked'
              : 'File blocked',
        };
      },
    }),
  );

  // ───────────── storage tiers ─────────────

  kernel.actions.register(
    defineAction({
      id: 'media.storage-tiers',
      title: 'Storage tiers',
      description:
        'How full the main and the cheaper file storage are, and when older files were last moved.',
      technical:
        'Per tier: bytes/count from the last full sweep of the blossom.tiering job (+ changes since, this process), caps from modules.blossom.tiers.*.maxBytes; job state in docs blossom.state[tiering].',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      anyRelay: true,
      keywords: ['storage', 'tier', 'cold', 'hot', 'disk', 'bucket', 'media'],
      input: z.object({}),
      async run() {
        const s = await tiering.status();
        const hot = s.tiers[0];
        return {
          output: s,
          summary:
            hot?.usedBytes != null
              ? `Main storage: ${formatBytes(hot.usedBytes)}`
              : 'Storage tiers',
        };
      },
    }),
  );

  kernel.actions.register(
    defineAction({
      id: 'media.run-tiering',
      title: 'Move older files now',
      description:
        'Move files nobody opened for a while to the cheaper storage now instead of waiting for the next automatic run.',
      technical:
        'Runs one pass of the blossom.tiering job (resumable; max 2000 scanned / 200 moved per run). Quarantined and legally held files are never moved.',
      scope: 'node',
      permission: 'media.write',
      keywords: ['storage', 'tier', 'cold', 'move', 'media'],
      input: z.object({}),
      async preview() {
        const cfg = tiering.config();
        if (!cfg.cold && !cfg.hot.maxBytes) {
          return [{ kind: 'info', text: 'Cheaper storage is not set up. Nothing will move.' }];
        }
        return [
          {
            kind: 'change',
            text: cfg.cold
              ? `Files not opened for ${cfg.cold.afterDays} days move to the cheaper storage. They keep working.`
              : 'Storage use is counted again.',
            technical: 'blossom.tiering run',
          },
        ];
      },
      async run() {
        const r = await tiering.run();
        return {
          output: {
            moved: r.moved,
            movedBytes: r.movedBytes,
            failed: r.failed,
            lastError: r.lastError ?? null,
          },
          summary:
            r.lastError && !r.moved
              ? r.lastError
              : r.moved
                ? `Moved ${r.moved} file${r.moved === 1 ? '' : 's'} (${formatBytes(r.movedBytes)})`
                : 'Nothing needed moving',
        };
      },
    }),
  );

  // ───────────── cleanup (GC) ─────────────

  kernel.actions.register(
    defineAction({
      id: 'media.cleanup-status',
      title: 'File cleanup',
      description:
        'When files nobody uses any more were last cleaned up, how much space that freed, and how many are waiting.',
      technical:
        'Orphan GC (blossom.gc): expired BlobIndex owners removed, bytes with refCount 0 erased unless under legal hold. orphans = blobs kept by a legal hold (last run) + docs blossom.held records.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      anyRelay: true,
      keywords: ['cleanup', 'gc', 'garbage', 'orphan', 'storage', 'media'],
      input: z.object({}),
      async run() {
        const st = await svc.gcState();
        const held = await ports.docs.list(HELD, { limit: 1000 });
        const output = {
          lastRun: st.lastRun ?? null,
          nextRun: st.nextRun ?? null,
          freedBytes: st.freedBytes ?? 0,
          erased: st.erased ?? 0,
          expired: st.expired ?? 0,
          scanned: st.scanned ?? 0,
          orphans: (st.keptHeld ?? 0) + held.items.length,
          heldRecords: held.items.length,
          totalFreedBytes: st.totalFreedBytes ?? 0,
          inProgress: !!st.cursor,
        };
        return {
          output,
          summary: st.lastRun
            ? `Last cleanup freed ${formatBytes(output.freedBytes)}`
            : 'Cleanup has not run yet',
        };
      },
    }),
  );
}

// ───────────── health + cards ─────────────

export function tiersHealthCheck(tiering: TieringService): HealthCheck {
  return {
    id: 'blossom.tiers',
    subsystem: 'storage',
    weight: 1,
    async run() {
      const cfg = tiering.config();
      if (!cfg.cold && !cfg.hot.maxBytes) {
        return { score: 100, status: 'ok', message: 'No storage limits are set' };
      }
      const s = await tiering.status();
      if (s.error) {
        return {
          score: 40,
          status: 'critical',
          message: 'The cheaper file storage is not reachable',
          technical: s.error,
        };
      }
      const worst = s.tiers
        .filter((t) => t.fraction !== null)
        .sort((a, b) => (b.fraction ?? 0) - (a.fraction ?? 0))[0];
      const technical = s.tiers.map((t) => t.technical).join(' · ');
      if (!worst || (worst.fraction ?? 0) < TIER_WARN) {
        return { score: 100, status: 'ok', message: 'File storage has room', technical };
      }
      const pct = Math.round((worst.fraction ?? 0) * 100);
      const critical = (worst.fraction ?? 0) >= TIER_CRITICAL;
      return {
        score: critical ? 20 : 70,
        status: critical ? 'critical' : 'warn',
        message: `${worst.label} is ${pct}% full`,
        technical,
      };
    },
  };
}

export function tiersCards(kernel: Kernel, tiering: TieringService): CardSource {
  return {
    id: 'blossom.tiers',
    async cards(relayId) {
      if (relayId) return [];
      const cfg = tiering.config();
      if (!cfg.hot.maxBytes && !cfg.cold?.maxBytes) return [];
      const s = await tiering.status();
      const out: AttentionCard[] = [];
      for (const t of s.tiers) {
        if (t.fraction === null || t.fraction < TIER_WARN) continue;
        const pct = Math.round(t.fraction * 100);
        const critical = t.fraction >= TIER_CRITICAL;
        const canMove = t.tier === 'hot' && !!cfg.cold;
        out.push({
          id: `blossom.tier-full:${t.tier}`,
          relayId: null,
          severity: critical ? 'critical' : 'warning',
          title: `${t.label} is ${pct}% full`,
          body: canMove
            ? 'Move files nobody opened for a while to the cheaper storage, or raise the limit.'
            : t.tier === 'hot'
              ? 'Add cheaper storage for older files, raise the limit, or lower your storage goal.'
              : 'Raise the limit of the cheaper storage or delete files you no longer need.',
          technical: t.technical,
          batchKey: 'blossom.tier-full',
          createdAt: kernel.ports.clock.now(),
          ...(canMove
            ? {
                primary: {
                  label: 'Move older files now',
                  actionId: 'media.run-tiering',
                  input: {},
                },
              }
            : {}),
        });
      }
      return out;
    },
  };
}
