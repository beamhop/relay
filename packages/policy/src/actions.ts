// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin actions (§6.13) for moderation, users, access and personas.
 * Every state change has a plain preview diff and an undo where feasible.
 */
import {
  type ActionContext,
  type ActionDef,
  type BeamhopConfig,
  type DiffLine,
  type NostrEvent,
  PersonaSchema,
  type RelayConfig,
  type RelayId,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import { explainLimits } from './goals.ts';
import type { QueueItem, QueueStatus } from './moderation.ts';
import {
  applyPersona,
  applyPersonaModules,
  diffPersonaModules,
  diffRelayConfig,
  personaInfo,
  personaPresets,
} from './personas.ts';
import type { PolicyRuntime } from './runtime.ts';
import type { AllowEntry, BanEntry, InviteEntry, MuteEntry, TierEntry } from './state.ts';
import { HEX64, plural, shortKey } from './util.ts';

/** Undo window for actions (seconds), §6.3. */
export const UNDO_SECONDS = 300;

const Pubkey = z.string().regex(HEX64, 'expected a 64-character hex public key');
const Pubkeys = z.array(Pubkey).min(1).max(1000);

/** Minimal contract expected from the admin-api config service (`kernel.use('admin.config')`). */
export interface AdminConfigService {
  apply(
    next: BeamhopConfig,
    meta: { principalId: string; summary: string; reason?: string },
  ): Promise<unknown>;
}

function relayOf(rt: PolicyRuntime, ctx: ActionContext): RelayConfig {
  if (!ctx.relayId) throw new Error('choose a relay first');
  const relay = rt.relay(ctx.relayId);
  if (!relay) throw new Error(`unknown relay ${ctx.relayId}`);
  return relay;
}

function undoToken(rt: PolicyRuntime, actionId: string, payload: unknown) {
  return { actionId, payload, expiresAt: rt.kernel.ports.clock.now() + UNDO_SECONDS };
}

function needRelay(ctx: ActionContext): RelayId {
  if (!ctx.relayId) throw new Error('choose a relay first');
  return ctx.relayId;
}

export function createActions(rt: PolicyRuntime): ActionDef[] {
  const ports = rt.kernel.ports;
  const now = () => ports.clock.now();
  const days = () => rt.config().recycleDays;

  // ── moderation ──

  const queueAction = defineAction({
    id: 'moderation.queue',
    title: 'Review queue',
    description: 'Posts, reports and files waiting for a decision.',
    technical:
      'Lists policy.queue items (held events, NIP-56 kind 1984 reports, quarantined blobs).',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['reports', 'moderation', 'queue', 'review'],
    input: z.object({
      status: z.enum(['pending', 'kept', 'removed']).default('pending'),
      batchKey: z.string().optional(),
      limit: z.number().int().positive().max(500).default(50),
    }),
    async run(input, ctx) {
      const items = await rt.queue.list(needRelay(ctx), {
        status: input.status as QueueStatus,
        batchKey: input.batchKey,
      });
      return {
        output: { items: items.slice(0, input.limit), total: items.length },
        summary: `${plural(items.length, 'item')} ${input.status}`,
      };
    },
  });

  const keep = defineAction({
    id: 'moderation.keep',
    title: 'Keep',
    description: 'Mark items as fine. Held posts become visible.',
    technical: 'Sets queue status to kept; held events are saved to the event store.',
    scope: 'relay',
    permission: 'moderation.write',
    bulk: true,
    shortcut: 'e',
    keywords: ['approve', 'keep', 'allow'],
    input: z.object({ itemIds: z.array(z.string()).min(1) }),
    async preview(input, ctx) {
      const relayId = needRelay(ctx);
      const lines: DiffLine[] = [];
      for (const id of input.itemIds) {
        const item = await rt.queue.get(relayId, id);
        if (!item) lines.push({ kind: 'warning', text: `Item ${id} was not found` });
        else
          lines.push({
            kind: 'change',
            text:
              item.type === 'event'
                ? 'This held post will become visible'
                : `"${item.reason}" will be marked as fine`,
            technical: `policy.queue[${id}].status: ${item.status} → kept`,
          });
      }
      return lines;
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const prev: Array<{ id: string; status: QueueStatus }> = [];
      const saved: string[] = [];
      for (const id of input.itemIds) {
        const item = await rt.queue.get(relayId, id);
        if (!item) continue;
        if (item.type === 'event' && item.event && item.status !== 'kept') {
          const res = await ports.events.save(relayId, item.event);
          if (res.status === 'saved') saved.push(item.event.id);
        }
        prev.push({ id, status: item.status });
        await rt.queue.setStatus(relayId, id, 'kept', ctx.principal.id);
      }
      return {
        output: { kept: prev.length },
        summary: `Kept ${plural(prev.length, 'item')}`,
        undo: undoToken(rt, 'moderation.keep', { prev, saved }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      const p = payload as { prev: Array<{ id: string; status: QueueStatus }>; saved: string[] };
      if (p.saved.length) await ports.events.deleteByIds(relayId, p.saved);
      for (const x of p.prev) await rt.queue.setStatus(relayId, x.id, x.status, ctx.principal.id);
    },
  });

  const remove = defineAction({
    id: 'moderation.remove',
    title: 'Remove',
    description: `Hide posts or files. They stay in the recycle bin for ${days()} days.`,
    technical:
      'Soft delete: event copied to policy.recycle then deleteByIds (no tombstone); blobs stop being served (onBlobServe) and owners are removed on purge.',
    scope: 'relay',
    permission: 'moderation.write',
    bulk: true,
    shortcut: 'x',
    keywords: ['delete', 'remove', 'hide', 'takedown'],
    input: z
      .object({
        itemIds: z.array(z.string()).default([]),
        eventIds: z.array(z.string().regex(HEX64)).default([]),
        reason: z.string().max(500).optional(),
      })
      .refine((x) => x.itemIds.length + x.eventIds.length > 0, 'nothing to remove'),
    async preview(input, ctx) {
      const relayId = needRelay(ctx);
      let posts = input.eventIds.length;
      let files = 0;
      const lines: DiffLine[] = [];
      for (const id of input.itemIds) {
        const item = await rt.queue.get(relayId, id);
        if (!item) {
          lines.push({ kind: 'warning', text: `Item ${id} was not found` });
        } else if (item.eventId) posts++;
        else if (item.sha256) files++;
        else
          lines.push({
            kind: 'info',
            text: `The report about ${shortKey(item.pubkey ?? '')} is about an account; use “Block account” to stop them`,
          });
      }
      if (posts)
        lines.unshift({
          kind: 'remove',
          text: `${plural(posts, 'post')} will be hidden (restorable for ${days()} days)`,
          technical: `deleteByIds(${posts}) + policy.recycle`,
        });
      if (files)
        lines.unshift({
          kind: 'remove',
          text: `${plural(files, 'file')} will stop being served (restorable for ${days()} days)`,
          technical: `onBlobServe reject + policy.recycle (${files})`,
        });
      return lines;
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const by = ctx.principal.id;
      const recycled: string[] = [];
      const prev: Array<{ id: string; status: QueueStatus }> = [];
      const removeEventById = async (id: string, event?: NostrEvent) => {
        if (await rt.state.isRecycled(relayId, id)) return;
        const e = event ?? (await ports.events.getById(relayId, id));
        if (!e) return;
        await rt.queue.removeEvent(relayId, e, by, input.reason);
        recycled.push(id);
      };
      for (const id of input.itemIds) {
        const item = await rt.queue.get(relayId, id);
        if (!item) continue;
        if (item.eventId) {
          // Held events were never stored visibly: recycle the copy we have.
          const stored = await ports.events.getById(relayId, item.eventId);
          if (stored) await removeEventById(item.eventId, stored);
          else if (item.event && !(await rt.state.isRecycled(relayId, item.eventId))) {
            await rt.state.putRecycled(relayId, {
              id: item.eventId,
              type: 'event',
              event: item.event,
              removedAt: now(),
              purgeAt: now() + days() * 86400,
              by,
              ...(input.reason ? { reason: input.reason } : {}),
            });
            recycled.push(item.eventId);
          }
        } else if (item.sha256) {
          if (!(await rt.state.isRecycled(relayId, item.sha256))) {
            await rt.queue.removeBlob(relayId, item.sha256, by, input.reason);
            recycled.push(item.sha256);
          }
        }
        prev.push({ id, status: item.status });
        await rt.queue.setStatus(relayId, id, 'removed', by);
      }
      for (const id of input.eventIds) await removeEventById(id);
      return {
        output: { removed: recycled },
        summary: `Removed ${plural(recycled.length, 'item')} (restorable for ${days()} days)`,
        undo: undoToken(rt, 'moderation.remove', { recycled, prev }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      const p = payload as { recycled: string[]; prev: Array<{ id: string; status: QueueStatus }> };
      for (const id of p.recycled) await rt.queue.restore(relayId, id);
      for (const x of p.prev) await rt.queue.setStatus(relayId, x.id, x.status, ctx.principal.id);
    },
  });

  const restore = defineAction({
    id: 'moderation.restore',
    title: 'Restore from recycle bin',
    description: 'Bring back removed posts or files.',
    technical:
      'Re-saves the event from policy.recycle (refused if the author deleted it via NIP-09/62) or unblocks the blob.',
    scope: 'relay',
    permission: 'moderation.write',
    bulk: true,
    shortcut: 'u',
    keywords: ['undelete', 'restore', 'recycle bin'],
    input: z.object({ ids: z.array(z.string().regex(HEX64)).min(1) }),
    async preview(input, ctx) {
      const relayId = needRelay(ctx);
      const lines: DiffLine[] = [];
      for (const id of input.ids) {
        const e = await rt.state.getRecycled(relayId, id);
        lines.push(
          e
            ? {
                kind: 'add',
                text:
                  e.type === 'event'
                    ? 'A removed post will be visible again'
                    : 'A removed file will be served again',
                technical: `policy.recycle[${id}] → restore`,
              }
            : { kind: 'warning', text: `${shortKey(id)} is not in the recycle bin` },
        );
      }
      return lines;
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const restored: Array<{ id: string; reason?: string }> = [];
      const failed: Array<{ id: string; reason: string }> = [];
      for (const id of input.ids) {
        const r = await rt.queue.restore(relayId, id);
        if (r.ok) restored.push({ id, reason: r.entry.reason });
        else failed.push({ id, reason: r.reason });
      }
      return {
        output: { restored: restored.map((x) => x.id), failed },
        summary: `Restored ${plural(restored.length, 'item')}${failed.length ? `, ${failed.length} could not be restored` : ''}`,
        undo: undoToken(rt, 'moderation.restore', { ids: restored.map((x) => x.id) }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      for (const id of (payload as { ids: string[] }).ids) {
        const e = await ports.events.getById(relayId, id);
        if (e) await rt.queue.removeEvent(relayId, e, ctx.principal.id, 'undo restore');
        else await rt.queue.removeBlob(relayId, id, ctx.principal.id, 'undo restore');
      }
    },
  });

  const recycleBin = defineAction({
    id: 'moderation.recycle-bin',
    title: 'Recycle bin',
    description: 'Removed posts and files you can still restore.',
    technical: 'Lists policy.recycle entries with purge dates.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    input: z.object({}),
    async run(_input, ctx) {
      const items = (await rt.state.listRecycled(needRelay(ctx))).sort(
        (a, b) => b.removedAt - a.removedAt,
      );
      return { output: { items }, summary: plural(items.length, 'item') };
    },
  });

  const ban = defineAction({
    id: 'moderation.ban-pubkey',
    title: 'Block account',
    description: 'Stop these accounts from posting or uploading here.',
    technical: 'Adds pubkeys to policy.bans (EVENT/AUTH/upload rejected with "blocked:").',
    scope: 'relay',
    permission: 'moderation.write',
    bulk: true,
    shortcut: '#',
    keywords: ['ban', 'block', 'spammer'],
    input: z.object({
      pubkeys: Pubkeys,
      reason: z.string().max(500).optional(),
      removeRecent: z.boolean().default(false),
    }),
    async preview(input, ctx) {
      const relay = relayOf(rt, ctx);
      const lines: DiffLine[] = [];
      let fresh = 0;
      for (const pk of input.pubkeys) {
        if (rt.isOwner(relay, pk))
          lines.push({ kind: 'warning', text: 'You cannot block the relay owner' });
        else if (!(await rt.state.isBanned(relay.id, pk))) fresh++;
      }
      lines.unshift({
        kind: 'add',
        text: `${plural(fresh, 'account')} will be blocked`,
        technical: `policy.bans += ${fresh}`,
      });
      if (input.removeRecent) {
        let n = 0;
        for (const pk of input.pubkeys)
          n += await ports.events.count(relay.id, [{ authors: [pk] }]);
        lines.push({
          kind: 'remove',
          text: `Their posts (up to ${Math.min(n, 500 * input.pubkeys.length)}) will be hidden (restorable for ${days()} days)`,
          technical: 'deleteByIds + policy.recycle, max 500 per account',
        });
      }
      return lines;
    },
    async run(input, ctx) {
      const relay = relayOf(rt, ctx);
      const prev: Array<{ pubkey: string; entry: BanEntry | null }> = [];
      const removed: string[] = [];
      for (const pk of input.pubkeys) {
        if (rt.isOwner(relay, pk)) continue;
        prev.push({ pubkey: pk, entry: (await rt.state.getBan(relay.id, pk)) ?? null });
        await rt.state.ban(relay.id, {
          pubkey: pk,
          at: now(),
          by: ctx.principal.id,
          ...(input.reason ? { reason: input.reason } : {}),
        });
        if (input.removeRecent) {
          const events = await ports.events.query(relay.id, [{ authors: [pk], limit: 500 }]);
          for (const e of events) {
            await rt.queue.removeEvent(
              relay.id,
              e,
              ctx.principal.id,
              input.reason ?? 'account blocked',
            );
            removed.push(e.id);
          }
        }
      }
      rt.clearTierCache();
      return {
        output: { banned: prev.map((p) => p.pubkey), removed: removed.length },
        summary: `Blocked ${plural(prev.length, 'account')}${removed.length ? ` and hid ${plural(removed.length, 'post')}` : ''}`,
        undo: undoToken(rt, 'moderation.ban-pubkey', { prev, removed }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      const p = payload as {
        prev: Array<{ pubkey: string; entry: BanEntry | null }>;
        removed: string[];
      };
      for (const x of p.prev) {
        if (x.entry) await rt.state.ban(relayId, x.entry);
        else await rt.state.unban(relayId, x.pubkey);
      }
      for (const id of p.removed) await rt.queue.restore(relayId, id);
    },
  });

  const unban = defineAction({
    id: 'moderation.unban-pubkey',
    title: 'Unblock account',
    description: 'Let these accounts post again.',
    technical: 'Removes pubkeys from policy.bans.',
    scope: 'relay',
    permission: 'moderation.write',
    bulk: true,
    keywords: ['unban', 'unblock'],
    input: z.object({ pubkeys: Pubkeys }),
    async preview(input, ctx) {
      const relayId = needRelay(ctx);
      let n = 0;
      for (const pk of input.pubkeys) if (await rt.state.isBanned(relayId, pk)) n++;
      return [
        {
          kind: 'remove',
          text: `${plural(n, 'account')} will be able to post again`,
          technical: `policy.bans -= ${n}`,
        },
      ];
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const prev: BanEntry[] = [];
      for (const pk of input.pubkeys) {
        const entry = await rt.state.getBan(relayId, pk);
        if (!entry) continue;
        prev.push(entry);
        await rt.state.unban(relayId, pk);
      }
      return {
        output: { unbanned: prev.map((p) => p.pubkey) },
        summary: `Unblocked ${plural(prev.length, 'account')}`,
        undo: undoToken(rt, 'moderation.unban-pubkey', { prev }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      for (const e of (payload as { prev: BanEntry[] }).prev) await rt.state.ban(relayId, e);
    },
  });

  const mute = defineAction({
    id: 'moderation.mute-pubkey',
    title: 'Mute account',
    description: 'Their posts look sent to them but nobody else sees them.',
    technical: 'Shadow mode: EVENT answered OK but not stored or broadcast (policy.mutes).',
    scope: 'relay',
    permission: 'moderation.write',
    bulk: true,
    keywords: ['mute', 'shadow ban', 'silence'],
    input: z.object({
      pubkeys: Pubkeys,
      hours: z
        .number()
        .int()
        .positive()
        .max(24 * 365)
        .optional(),
    }),
    async preview(input) {
      return [
        {
          kind: 'add',
          text: `${plural(input.pubkeys.length, 'account')} will be muted${input.hours ? ` for ${plural(input.hours, 'hour')}` : ''}`,
          technical: `policy.mutes += ${input.pubkeys.length}${input.hours ? ` (until now+${input.hours}h)` : ''}`,
        },
      ];
    },
    async run(input, ctx) {
      const relay = relayOf(rt, ctx);
      const prev: Array<{ pubkey: string; entry: MuteEntry | null }> = [];
      for (const pk of input.pubkeys) {
        if (rt.isOwner(relay, pk)) continue;
        prev.push({ pubkey: pk, entry: (await rt.state.getMute(relay.id, pk)) ?? null });
        await rt.state.mute(relay.id, {
          pubkey: pk,
          at: now(),
          by: ctx.principal.id,
          ...(input.hours ? { until: now() + input.hours * 3600 } : {}),
        });
      }
      return {
        output: { muted: prev.map((p) => p.pubkey) },
        summary: `Muted ${plural(prev.length, 'account')}`,
        undo: undoToken(rt, 'moderation.mute-pubkey', { prev }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      for (const x of (payload as { prev: Array<{ pubkey: string; entry: MuteEntry | null }> })
        .prev) {
        if (x.entry) await rt.state.mute(relayId, x.entry);
        else await rt.state.unmute(relayId, x.pubkey);
      }
    },
  });

  const unmute = defineAction({
    id: 'moderation.unmute-pubkey',
    title: 'Unmute account',
    description: 'Their posts are visible to everyone again.',
    technical: 'Removes pubkeys from policy.mutes.',
    scope: 'relay',
    permission: 'moderation.write',
    bulk: true,
    input: z.object({ pubkeys: Pubkeys }),
    async preview(input) {
      return [
        {
          kind: 'remove',
          text: `${plural(input.pubkeys.length, 'account')} will be unmuted`,
          technical: `policy.mutes -= ${input.pubkeys.length}`,
        },
      ];
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const prev: MuteEntry[] = [];
      for (const pk of input.pubkeys) {
        const e = await rt.state.getMute(relayId, pk);
        if (!e) continue;
        prev.push(e);
        await rt.state.unmute(relayId, pk);
      }
      return {
        output: { unmuted: prev.map((p) => p.pubkey) },
        summary: `Unmuted ${plural(prev.length, 'account')}`,
        undo: undoToken(rt, 'moderation.unmute-pubkey', { prev }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      for (const e of (payload as { prev: MuteEntry[] }).prev) await rt.state.mute(relayId, e);
    },
  });

  // ── users / access ──

  const setTier = defineAction({
    id: 'users.set-tier',
    title: 'Change plan',
    description: 'Move a person to another tier (limits bundle).',
    technical:
      'Explicit tier assignment in policy.tiers; overrides tier rules. null = back to rules/default.',
    scope: 'relay',
    permission: 'users.write',
    keywords: ['tier', 'plan', 'upgrade', 'limits'],
    input: z.object({ pubkey: Pubkey, tier: z.string().nullable() }),
    async preview(input, ctx) {
      const relay = relayOf(rt, ctx);
      const name = (id: string) => relay.tiers.find((t) => t.id === id)?.name ?? id;
      const from = await rt.resolveTier(relay.id, input.pubkey);
      if (input.tier !== null && !relay.tiers.some((t) => t.id === input.tier))
        return [{ kind: 'warning', text: `There is no tier called “${input.tier}”` }];
      return [
        {
          kind: 'change',
          text:
            input.tier === null
              ? `${shortKey(input.pubkey)} goes back to the automatic plan`
              : `${shortKey(input.pubkey)} moves from ${name(from)} to ${name(input.tier)}`,
          technical: `policy.tiers[${input.pubkey}]: ${from} → ${input.tier ?? '(rules/default)'}`,
        },
      ];
    },
    async run(input, ctx) {
      const relay = relayOf(rt, ctx);
      if (input.tier !== null && !relay.tiers.some((t) => t.id === input.tier))
        throw new Error(`unknown tier ${input.tier}`);
      const prev = (await rt.state.explicitTier(relay.id, input.pubkey)) ?? null;
      await rt.state.setTier(
        relay.id,
        input.tier === null
          ? { pubkey: input.pubkey, tier: null }
          : { pubkey: input.pubkey, tier: input.tier, setAt: now(), by: ctx.principal.id },
      );
      rt.clearTierCache();
      return {
        output: { pubkey: input.pubkey, tier: input.tier },
        summary:
          input.tier === null
            ? `${shortKey(input.pubkey)} is back on the automatic plan`
            : `${shortKey(input.pubkey)} is now on ${relay.tiers.find((t) => t.id === input.tier)?.name}`,
        undo: undoToken(rt, 'users.set-tier', { pubkey: input.pubkey, prev }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      const p = payload as { pubkey: string; prev: TierEntry | null };
      await rt.state.setTier(relayId, p.prev ?? { pubkey: p.pubkey, tier: null });
      rt.clearTierCache();
    },
  });

  const addAllow = defineAction({
    id: 'access.add-allowlist',
    title: 'Add members',
    description: 'Let these people post (and read, if sign-in is required).',
    technical: 'Adds pubkeys to policy.allowlist (used in allowlist and WoT modes).',
    scope: 'relay',
    permission: 'users.write',
    bulk: true,
    keywords: ['allowlist', 'whitelist', 'member', 'invite'],
    input: z.object({ pubkeys: Pubkeys, note: z.string().max(200).optional() }),
    async preview(input, ctx) {
      const relay = relayOf(rt, ctx);
      let n = 0;
      for (const pk of input.pubkeys) if (!(await rt.state.isAllowlisted(relay.id, pk))) n++;
      const lines: DiffLine[] = [
        {
          kind: 'add',
          text: `${plural(n, 'person', 'people')} will be added as members`,
          technical: `policy.allowlist += ${n}`,
        },
      ];
      if (relay.access.mode === 'open')
        lines.push({
          kind: 'info',
          text: 'Your relay is open to everyone, so this only matters if you switch to members-only',
        });
      return lines;
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const added: string[] = [];
      for (const pk of input.pubkeys) {
        if (await rt.state.isAllowlisted(relayId, pk)) continue;
        const entry: AllowEntry = {
          pubkey: pk,
          addedAt: now(),
          by: ctx.principal.id,
          via: 'admin',
          ...(input.note ? { note: input.note } : {}),
        };
        await rt.state.allow(relayId, entry);
        added.push(pk);
      }
      rt.clearTierCache();
      return {
        output: { added },
        summary: `Added ${plural(added.length, 'member')}`,
        undo: undoToken(rt, 'access.add-allowlist', { added }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      for (const pk of (payload as { added: string[] }).added) await rt.state.disallow(relayId, pk);
      rt.clearTierCache();
    },
  });

  const removeAllow = defineAction({
    id: 'access.remove-allowlist',
    title: 'Remove members',
    description: 'These people can no longer post (unless the relay is open).',
    technical: 'Removes pubkeys from policy.allowlist.',
    scope: 'relay',
    permission: 'users.write',
    bulk: true,
    keywords: ['allowlist', 'remove member', 'revoke'],
    input: z.object({ pubkeys: Pubkeys }),
    async preview(input, ctx) {
      const relayId = needRelay(ctx);
      let n = 0;
      for (const pk of input.pubkeys) if (await rt.state.isAllowlisted(relayId, pk)) n++;
      return [
        {
          kind: 'remove',
          text: `${plural(n, 'person', 'people')} will no longer be members`,
          technical: `policy.allowlist -= ${n}`,
        },
      ];
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const prev: AllowEntry[] = [];
      for (const pk of input.pubkeys) {
        const e = await rt.state.getAllow(relayId, pk);
        if (!e) continue;
        prev.push(e);
        await rt.state.disallow(relayId, pk);
      }
      rt.clearTierCache();
      return {
        output: { removed: prev.map((e) => e.pubkey) },
        summary: `Removed ${plural(prev.length, 'member')}`,
        undo: undoToken(rt, 'access.remove-allowlist', { prev }),
      };
    },
    async undo(payload, ctx) {
      const relayId = needRelay(ctx);
      for (const e of (payload as { prev: AllowEntry[] }).prev) await rt.state.allow(relayId, e);
      rt.clearTierCache();
    },
  });

  const createInvite = defineAction({
    id: 'access.create-invite',
    title: 'Create invite',
    description: 'A code people can use to join as members.',
    technical: 'Creates policy.invites entry; redeeming adds the pubkey to policy.allowlist.',
    scope: 'relay',
    permission: 'users.write',
    keywords: ['invite', 'join link', 'code'],
    input: z.object({
      expiresInHours: z
        .number()
        .int()
        .positive()
        .max(24 * 365)
        .default(168),
      maxUses: z.number().int().positive().max(10_000).default(1),
      note: z.string().max(200).optional(),
    }),
    async preview(input) {
      return [
        {
          kind: 'add',
          text: `A new invite for ${plural(input.maxUses, 'person', 'people')}, valid for ${plural(input.expiresInHours, 'hour')}`,
          technical: `policy.invites += 1 (maxUses ${input.maxUses}, ttl ${input.expiresInHours}h)`,
        },
      ];
    },
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const entry: InviteEntry = {
        code: ports.crypto.randomHex(10),
        createdAt: now(),
        expiresAt: now() + input.expiresInHours * 3600,
        maxUses: input.maxUses,
        uses: 0,
        by: ctx.principal.id,
        redeemedBy: [],
        ...(input.note ? { note: input.note } : {}),
      };
      await rt.state.createInvite(relayId, entry);
      return {
        output: { code: entry.code, expiresAt: entry.expiresAt, maxUses: entry.maxUses },
        summary: 'Invite created',
        undo: undoToken(rt, 'access.create-invite', { code: entry.code }),
      };
    },
    async undo(payload, ctx) {
      await rt.state.deleteInvite(needRelay(ctx), (payload as { code: string }).code);
    },
  });

  // ── config ──

  const persona = defineAction({
    id: 'config.apply-persona',
    title: 'Change relay type',
    description: 'Apply a ready-made setup (goals, who can post, media options).',
    technical:
      'Deep-merges personaPresets[persona] into relays[id] (limits overrides, tiers, hosts and info are kept) and personaModulePresets[persona] into modules (organization: modules.team.enabled=true; never switches modules off). Committed via admin.config when available.',
    scope: 'relay',
    permission: 'config.write',
    keywords: ['persona', 'preset', 'template', 'relay type'],
    input: z.object({ persona: PersonaSchema }),
    async preview(input, ctx) {
      const relay = relayOf(rt, ctx);
      const next = applyPersona(relay, input.persona);
      const lines = [
        ...diffRelayConfig(relay, next),
        ...diffPersonaModules(rt.kernel.config().modules, input.persona),
      ];
      if (lines.length === 0)
        return [{ kind: 'info', text: `Already set up as ${personaInfo[input.persona].title}` }];
      return lines;
    },
    async run(input, ctx) {
      const relay = relayOf(rt, ctx);
      const next = applyPersona(relay, input.persona);
      const cfg = rt.kernel.config();
      const diff = [
        ...diffRelayConfig(relay, next),
        ...diffPersonaModules(cfg.modules, input.persona),
      ];
      const nextConfig: BeamhopConfig = {
        ...cfg,
        relays: cfg.relays.map((r) => (r.id === relay.id ? next : r)),
        modules: applyPersonaModules(cfg.modules, input.persona),
      };
      const svc = rt.kernel.use<AdminConfigService>('admin.config');
      const summary = `Relay set up as ${personaInfo[input.persona].title}`;
      let committed = false;
      if (svc && typeof svc.apply === 'function' && diff.length > 0) {
        await svc.apply(nextConfig, { principalId: ctx.principal.id, summary, reason: ctx.reason });
        committed = true;
      }
      return {
        output: {
          relayId: relay.id,
          patch: personaPresets[input.persona],
          relay: next,
          config: nextConfig,
          diff,
          committed,
        },
        summary: committed ? summary : `${summary} (not saved yet: apply the patch)`,
        ...(committed
          ? {
              undo: undoToken(rt, 'config.apply-persona', {
                relayId: relay.id,
                prev: relay,
                prevModules: cfg.modules,
              }),
            }
          : {}),
      };
    },
    async undo(payload, ctx) {
      const p = payload as {
        relayId: string;
        prev: RelayConfig;
        prevModules?: Record<string, unknown>;
      };
      const svc = rt.kernel.use<AdminConfigService>('admin.config');
      if (!svc) throw new Error('config service unavailable');
      const cfg = rt.kernel.config();
      await svc.apply(
        {
          ...cfg,
          relays: cfg.relays.map((r) => (r.id === p.relayId ? p.prev : r)),
          ...(p.prevModules ? { modules: p.prevModules } : {}),
        },
        { principalId: ctx.principal.id, summary: 'Undo relay type change' },
      );
    },
  });

  // ── insights (read-only) ──

  const explain = defineAction({
    id: 'policy.explain-limits',
    title: 'Why these limits?',
    description: 'Shows every limit, where it comes from, and what it means.',
    technical: 'explainLimits(relay, tier): goals → media settings → tier → overrides.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['limits', 'goals', 'why', 'explain'],
    input: z.object({ tier: z.string().optional() }),
    async run(input, ctx) {
      const relay = relayOf(rt, ctx);
      const lines = explainLimits(relay, input.tier);
      return {
        output: { limits: rt.kernel.limits(relay.id, input.tier), lines },
        summary: `${lines.length} values explained`,
      };
    },
  });

  const stats = defineAction({
    id: 'policy.stats',
    title: 'Filter activity',
    description: 'How many posts each filter blocked, muted or held.',
    technical: 'In-memory counters per PolicyHook id since process start.',
    scope: 'node',
    permission: 'insights.read',
    readOnly: true,
    input: z.object({}),
    async run() {
      const s = rt.stats.snapshot();
      return { output: s, summary: `${s.total.rejected} blocked, ${s.total.held} held` };
    },
  });

  return [
    queueAction,
    keep,
    remove,
    restore,
    recycleBin,
    ban,
    unban,
    mute,
    unmute,
    setTier,
    addAllow,
    removeAllow,
    createInvite,
    persona,
    explain,
    stats,
  ] as unknown as ActionDef[];
}

export type { QueueItem };
