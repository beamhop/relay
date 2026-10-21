// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-service account operations behind the portal: plan/limits in plain
 * language, storage usage, blob deletion, data export and right to vanish.
 * Optional modules (policy, blossom) are used through duck-typed services so
 * this package never imports them.
 */
import {
  type ActionDef,
  type BlobOwnership,
  type Kernel,
  type NostrEvent,
  type RelayConfig,
  type RelayId,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import { type Translate, formatBytes } from './strings.ts';

/** Subset of `@beamhop/policy`'s PolicyService used here. */
export interface PolicyLike {
  resolveTier?(relayId: RelayId, pubkey: string): Promise<string>;
  redeemInvite?(
    relayId: RelayId,
    code: string,
    pubkey: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'unknown' | 'expired' | 'used-up' }>;
}

/** Subset of `@beamhop/blossom`'s BlossomService used here. */
export interface BlossomLike {
  limitsFor?(
    relay: RelayConfig,
    pubkey: string,
  ): Promise<{ quotaBytes: number; usedBytes: number }>;
  removeOwnership?(
    relayId: RelayId,
    sha256: string,
    pubkey: string,
    cause: string,
  ): Promise<{ removed: boolean; erased: boolean }>;
}

export const VANISH_LOG = 'public.vanish';

/** `kernel.use('relay.vanish')` from `@beamhop/relay` (shape only, no import). */
const RELAY_VANISH_SERVICE = 'relay.vanish';
type RelayVanish = (
  relayId: RelayId,
  pubkey: string,
  until: number,
) => Promise<{ removed: number }>;
export const FILES_LIMIT = 100;
const EXPORT_PAGE = 500;

export async function tierOf(kernel: Kernel, relay: RelayConfig, pubkey: string): Promise<string> {
  const policy = kernel.use<PolicyLike>('policy');
  if (policy?.resolveTier) return policy.resolveTier(relay.id, pubkey);
  for (const a of kernel.access) {
    const tier = await a.tierOf?.(relay.id, pubkey);
    if (tier !== undefined) return tier;
  }
  return relay.defaultTier;
}

/** true/false when an access resolver decides; open relays are always writable. */
export async function canWrite(
  kernel: Kernel,
  relay: RelayConfig,
  pubkey: string,
): Promise<boolean | null> {
  for (const a of kernel.access) {
    const r = await a.canWrite?.(relay.id, pubkey);
    if (r !== undefined) return r;
  }
  return relay.access.mode === 'open' ? true : null;
}

export async function planOf(
  kernel: Kernel,
  relay: RelayConfig,
  pubkey: string,
  t: Translate,
): Promise<{ tierName: string; lines: string[] }> {
  const tier = await tierOf(kernel, relay, pubkey);
  const def = relay.tiers.find((x) => x.id === tier);
  const lim = kernel.limits(relay.id, tier);
  const lines = [
    t('portal.plan.rate', { n: def?.eventsPerMinute ?? lim.eventsPerMinute }),
    t('portal.plan.size', { size: formatBytes(def?.maxEventBytes ?? lim.maxEventBytes) }),
  ];
  if (relay.blossom.enabled) {
    lines.push(
      t('portal.plan.fileSize', {
        size: formatBytes(def?.maxBlobBytes ?? relay.blossom.maxBlobBytes ?? lim.maxBlobBytes),
      }),
    );
  }
  const days = def?.retentionDays ?? lim.defaultRetentionDays;
  lines.push(days ? t('portal.plan.retention', { days }) : t('portal.plan.retention.forever'));
  return { tierName: def?.name ?? tier, lines };
}

export async function storageOf(
  kernel: Kernel,
  relay: RelayConfig,
  pubkey: string,
): Promise<{ used: number; quota: number }> {
  const blossom = kernel.use<BlossomLike>('blossom');
  if (blossom?.limitsFor) {
    const l = await blossom.limitsFor(relay, pubkey);
    return { used: l.usedBytes, quota: l.quotaBytes };
  }
  const tier = await tierOf(kernel, relay, pubkey);
  const def = relay.tiers.find((x) => x.id === tier);
  const lim = kernel.limits(relay.id, tier);
  return {
    used: await kernel.ports.blobIndex.usage(relay.id, pubkey),
    quota: def?.blobQuotaBytes ?? relay.blossom.defaultQuotaBytes ?? lim.defaultBlobQuotaBytes,
  };
}

export function filesOf(
  kernel: Kernel,
  relayId: RelayId,
  pubkey: string,
): Promise<BlobOwnership[]> {
  return kernel.ports.blobIndex.listByOwner(relayId, pubkey, { limit: FILES_LIMIT });
}

/** Remove the caller's ownership of a blob; bytes are erased when no owner is left. */
export async function deleteFile(
  kernel: Kernel,
  relayId: RelayId,
  sha256: string,
  pubkey: string,
): Promise<boolean> {
  const blossom = kernel.use<BlossomLike>('blossom');
  if (blossom?.removeOwnership) {
    return (await blossom.removeOwnership(relayId, sha256, pubkey, 'owner')).removed;
  }
  const { ports } = kernel;
  const removed = await ports.blobIndex.removeOwner(relayId, sha256, pubkey);
  if (!removed) return false;
  kernel.bus.emit('blob.deleted', { relayId, sha256, pubkey, cause: 'owner' });
  if ((await ports.blobIndex.refCount(sha256)) === 0) await ports.blobs.delete(sha256);
  return true;
}

/**
 * NDJSON export: one `meta` line, then every event authored by `pubkey`
 * (`{"type":"event","event":…}`), then every owned file (`{"type":"blob",…}`).
 */
export function exportStream(
  kernel: Kernel,
  relay: RelayConfig,
  pubkey: string,
  publicUrl: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const { ports } = kernel;
  async function* lines(): AsyncGenerator<string> {
    yield JSON.stringify({
      type: 'meta',
      relay: relay.info.name,
      relayId: relay.id,
      pubkey,
      exportedAt: ports.clock.now(),
      format: 'beamhop-export-v1',
    });
    const seen = new Set<string>();
    let until: number | undefined;
    for (;;) {
      const batch: NostrEvent[] = await ports.events.query(
        relay.id,
        [{ authors: [pubkey], limit: EXPORT_PAGE, ...(until !== undefined ? { until } : {}) }],
        { maxLimit: EXPORT_PAGE },
      );
      let fresh = 0;
      for (const ev of batch) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        fresh++;
        yield JSON.stringify({ type: 'event', event: ev });
      }
      if (batch.length < EXPORT_PAGE || fresh === 0) break;
      until = (batch[batch.length - 1] as NostrEvent).created_at;
    }
    let before: number | undefined;
    for (;;) {
      const page = await ports.blobIndex.listByOwner(relay.id, pubkey, {
        limit: EXPORT_PAGE,
        ...(before !== undefined ? { until: before } : {}),
      });
      let fresh = 0;
      for (const b of page) {
        const k = `blob:${b.sha256}`;
        if (seen.has(k)) continue;
        seen.add(k);
        fresh++;
        yield JSON.stringify({
          type: 'blob',
          sha256: b.sha256,
          size: b.size,
          mime: b.type,
          uploadedAt: b.uploadedAt,
          url: `${publicUrl}/${b.sha256}`,
        });
      }
      if (page.length < EXPORT_PAGE || fresh === 0) break;
      before = (page[page.length - 1] as BlobOwnership).uploadedAt;
    }
  }
  const it = lines();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const n = await it.next();
      if (n.done) ctrl.close();
      else ctrl.enqueue(enc.encode(`${n.value}\n`));
    },
  });
}

export interface VanishResult {
  events: number;
  files: number;
}

/** NIP-62 right to vanish on one relay: all events up to `until` and every owned file. */
export async function vanish(
  kernel: Kernel,
  relayId: RelayId,
  pubkey: string,
  until: number,
  request?: NostrEvent,
): Promise<VanishResult> {
  const { ports } = kernel;
  const relayVanish = kernel.use<RelayVanish>(RELAY_VANISH_SERVICE);
  let events: number;
  let files = 0;
  if (relayVanish) {
    // Same path as a NIP-62 request to the relay: legal holds, gift wraps
    // addressed to the person, and their files/media via `user.vanished`.
    files = (await ports.blobIndex.listByOwner(relayId, pubkey, { until, limit: 100_000 })).length;
    events = (await relayVanish(relayId, pubkey, until)).removed;
  } else {
    events = await ports.events.vanish(relayId, pubkey, until);
    for (let guard = 0; guard < 1000; guard++) {
      const owned = await ports.blobIndex.listByOwner(relayId, pubkey, { limit: 200 });
      if (owned.length === 0) break;
      let removed = 0;
      for (const b of owned) if (await deleteFile(kernel, relayId, b.sha256, pubkey)) removed++;
      files += removed;
      if (removed === 0) break;
    }
    kernel.bus.emit('event.deleted', { relayId, ids: [], cause: 'nip62' });
  }
  await ports.docs.put(VANISH_LOG, `${relayId}:${pubkey}`, {
    at: ports.clock.now(),
    until,
    events,
    files,
    request: request ?? null,
  });
  return { events, files };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Admin action mirroring the portal's "delete everything" (e.g. for email requests). */
export function createAccountActions(kernel: Kernel): ActionDef[] {
  const def = defineAction({
    id: 'portal.right-to-vanish',
    title: 'Delete everything a person stored',
    description:
      'Permanently removes all posts and files of one person from this relay and refuses them in the future.',
    technical: 'NIP-62 right to vanish: EventStore.vanish(pubkey, until) + removal of owned blobs.',
    scope: 'relay',
    permission: 'users.write',
    sensitive: true,
    keywords: ['vanish', 'gdpr', 'erase', 'delete user', 'nip-62'],
    input: z.object({
      relayId: z.string().optional(),
      pubkey: z.string().regex(HEX64, 'expected a 64-character hex public key'),
      until: z.number().int().positive().optional(),
    }),
    async preview(input, ctx) {
      const relayId = ctx.relayId ?? input.relayId;
      if (!relayId) throw new Error('choose a relay first');
      const n = await kernel.ports.events.count(relayId, [{ authors: [input.pubkey] }]);
      const files = await kernel.ports.blobIndex.listByOwner(relayId, input.pubkey, {
        limit: 1000,
      });
      return [
        { kind: 'remove', text: `${n} posts and ${files.length} files will be deleted for good` },
        { kind: 'warning', text: 'This cannot be undone.' },
      ];
    },
    async run(input, ctx) {
      const relayId = ctx.relayId ?? input.relayId;
      if (!relayId) throw new Error('choose a relay first');
      const r = await vanish(
        kernel,
        relayId,
        input.pubkey,
        input.until ?? kernel.ports.clock.now(),
      );
      return { output: r, summary: `Removed ${r.events} posts and ${r.files} files` };
    },
  });
  return [def as unknown as ActionDef];
}
