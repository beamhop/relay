// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Read-only list actions: the people list (`users.list`) and the lists behind the
 * NIP-86 management methods (`moderation.list-banned-pubkeys`,
 * `access.list-allowed-pubkeys`) plus mutes and invites. Ids match admin-api's
 * `NIP86_METHODS` map so `listbannedpubkeys` / `listallowedpubkeys` work.
 */
import { type ActionContext, type ActionDef, type RelayId, defineAction } from '@beamhop/core';
import { z } from 'zod';
import type { PolicyRuntime } from './runtime.ts';
import { plural } from './util.ts';

export interface UserRow {
  pubkey: string;
  tier: string;
  /** Explicit tier set by an admin (vs. rules/default). */
  tierExplicit: boolean;
  firstSeen?: number;
  lastSeen?: number;
  storageBytes: number;
  files: number;
  banned: boolean;
  muted: boolean;
  allowlisted: boolean;
}

function needRelay(ctx: ActionContext): RelayId {
  if (!ctx.relayId) throw new Error('choose a relay first');
  return ctx.relayId;
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Decode an `npub1…` to hex (no checksum verification needed for a search filter). */
export function npubToHex(npub: string): string | undefined {
  const s = npub.toLowerCase();
  if (!s.startsWith('npub1') || s.length < 63) return undefined;
  const data: number[] = [];
  for (const ch of s.slice(5, -6)) {
    const v = BECH32.indexOf(ch);
    if (v < 0) return undefined;
    data.push(v);
  }
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (out.length !== 32) return undefined;
  return out.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_BLOB_SCAN = 50_000;

export function createListActions(rt: PolicyRuntime): ActionDef[] {
  const ports = rt.kernel.ports;
  const now = () => ports.clock.now();

  const usersList = defineAction({
    id: 'users.list',
    title: 'People',
    description: 'Everyone seen here recently, with their tier, activity, storage and status.',
    technical:
      'Union of policy state (first-seen, last activity, tiers, bans, mutes, allowlist) and blob owners (BlobIndex); sorted by last activity; offset cursor. Activity is recorded at most every 15 minutes per pubkey.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['users', 'people', 'members', 'accounts'],
    input: z.object({
      limit: z.number().int().min(1).max(500).default(50).describe('How many to show'),
      cursor: z.string().max(20).optional().describe('Paging cursor from the previous page'),
      search: z.string().max(100).optional().describe('Part of a public key (hex) or a full npub'),
      status: z
        .enum(['all', 'banned', 'muted', 'allowlisted', 'active'])
        .default('all')
        .describe('Only show people in this state'),
      activeWithinDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .describe('Only people active in the last N days'),
    }),
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const st = rt.state;
      const [seen, active, bans, mutes, allow, tiers] = await Promise.all([
        st.listSeen(relayId),
        st.listActive(relayId),
        st.listBans(relayId),
        st.listMutes(relayId),
        st.listAllowlist(relayId),
        st.listTiers(relayId),
      ]);
      const rows = new Map<string, Partial<UserRow> & { pubkey: string }>();
      const row = (pubkey: string) => {
        let r = rows.get(pubkey);
        if (!r) {
          r = { pubkey };
          rows.set(pubkey, r);
        }
        return r;
      };
      for (const s of seen) row(s.pubkey).firstSeen = s.at;
      for (const a of active) {
        const r = row(a.pubkey);
        r.lastSeen = Math.max(r.lastSeen ?? 0, a.lastSeen);
      }
      const t = now();
      for (const b of bans) row(b.pubkey).banned = true;
      for (const m of mutes) if (m.until === undefined || m.until > t) row(m.pubkey).muted = true;
      for (const a of allow) row(a.pubkey).allowlisted = true;
      for (const x of tiers) row(x.pubkey).tierExplicit = true;
      // Blob owners: storage usage and upload activity.
      let cursor: string | undefined;
      let scanned = 0;
      do {
        const page = await ports.blobIndex.list(relayId, { cursor, limit: 1000 });
        for (const o of page.items) {
          const r = row(o.pubkey);
          r.storageBytes = (r.storageBytes ?? 0) + o.size;
          r.files = (r.files ?? 0) + 1;
          r.lastSeen = Math.max(r.lastSeen ?? 0, o.uploadedAt);
        }
        scanned += page.items.length;
        cursor = page.items.length ? page.cursor : undefined;
      } while (cursor && scanned < MAX_BLOB_SCAN);

      const q = input.search?.trim().toLowerCase();
      const needle = q?.startsWith('npub1') ? npubToHex(q) : q;
      const since = input.activeWithinDays ? t - input.activeWithinDays * 86400 : undefined;
      const filtered = [...rows.values()].filter((r) => {
        if (q && (!needle || !r.pubkey.includes(needle))) return false;
        if (since !== undefined && (r.lastSeen ?? r.firstSeen ?? 0) < since) return false;
        switch (input.status) {
          case 'banned':
            return !!r.banned;
          case 'muted':
            return !!r.muted;
          case 'allowlisted':
            return !!r.allowlisted;
          case 'active':
            return !r.banned && !r.muted;
          default:
            return true;
        }
      });
      filtered.sort(
        (a, b) =>
          (b.lastSeen ?? b.firstSeen ?? 0) - (a.lastSeen ?? a.firstSeen ?? 0) ||
          a.pubkey.localeCompare(b.pubkey),
      );
      const offset = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0);
      const page = filtered.slice(offset, offset + input.limit);
      const users: UserRow[] = [];
      for (const r of page) {
        const u: UserRow = {
          pubkey: r.pubkey,
          tier: await rt.resolveTier(relayId, r.pubkey),
          tierExplicit: !!r.tierExplicit,
          storageBytes: r.storageBytes ?? 0,
          files: r.files ?? 0,
          banned: !!r.banned,
          muted: !!r.muted,
          allowlisted: !!r.allowlisted,
        };
        if (r.firstSeen !== undefined) u.firstSeen = r.firstSeen;
        if (r.lastSeen !== undefined) u.lastSeen = r.lastSeen;
        users.push(u);
      }
      const next = offset + page.length;
      return {
        output: {
          users,
          total: filtered.length,
          ...(next < filtered.length ? { cursor: String(next) } : {}),
        },
        summary: plural(filtered.length, 'person', 'people'),
      };
    },
  });

  const listBanned = defineAction({
    id: 'moderation.list-banned-pubkeys',
    title: 'Blocked accounts',
    description: 'Accounts that cannot post or upload here.',
    technical: 'policy.bans for this relay (NIP-86 listbannedpubkeys).',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['banned', 'blocked'],
    input: z.object({}),
    async run(_i, ctx) {
      const bans = (await rt.state.listBans(needRelay(ctx))).sort((a, b) => b.at - a.at);
      return {
        output: {
          pubkeys: bans.map((b) => ({
            pubkey: b.pubkey,
            reason: b.reason ?? '',
            at: b.at,
            by: b.by,
          })),
        },
        summary: plural(bans.length, 'blocked account'),
      };
    },
  });

  const listMuted = defineAction({
    id: 'moderation.list-muted-pubkeys',
    title: 'Muted accounts',
    description: 'Accounts whose posts are hidden for now.',
    technical: 'policy.mutes for this relay; expired mutes are left out.',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['muted', 'silenced'],
    input: z.object({}),
    async run(_i, ctx) {
      const t = now();
      const mutes = (await rt.state.listMutes(needRelay(ctx)))
        .filter((m) => m.until === undefined || m.until > t)
        .sort((a, b) => b.at - a.at);
      return {
        output: {
          pubkeys: mutes.map((m) => ({
            pubkey: m.pubkey,
            at: m.at,
            by: m.by,
            ...(m.until !== undefined ? { until: m.until } : {}),
          })),
        },
        summary: plural(mutes.length, 'muted account'),
      };
    },
  });

  const listAllowed = defineAction({
    id: 'access.list-allowed-pubkeys',
    title: 'Allowed accounts',
    description: 'Accounts that may post here when the relay is invite-only.',
    technical: 'policy.allowlist for this relay (NIP-86 listallowedpubkeys).',
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['allowlist', 'whitelist', 'members'],
    input: z.object({}),
    async run(_i, ctx) {
      const allow = (await rt.state.listAllowlist(needRelay(ctx))).sort(
        (a, b) => b.addedAt - a.addedAt,
      );
      return {
        output: {
          pubkeys: allow.map((a) => ({
            pubkey: a.pubkey,
            reason: a.note ?? '',
            addedAt: a.addedAt,
            by: a.by,
            via: a.via,
            ...(a.invite ? { invite: a.invite } : {}),
          })),
        },
        summary: plural(allow.length, 'allowed account'),
      };
    },
  });

  const listInvites = defineAction({
    id: 'access.list-invites',
    title: 'Invite codes',
    description: 'Invite codes for this relay, with how often each was used.',
    technical: 'policy.invites for this relay; codes are secrets, so this needs users.write.',
    scope: 'relay',
    permission: 'users.write',
    readOnly: true,
    keywords: ['invites', 'codes', 'join'],
    input: z.object({
      includeExpired: z.boolean().default(false).describe('Also show expired or used-up codes'),
    }),
    async run(input, ctx) {
      const t = now();
      const invites = (await rt.state.listInvites(needRelay(ctx)))
        .map((i) => ({
          ...i,
          status:
            i.expiresAt <= t
              ? ('expired' as const)
              : i.uses >= i.maxUses
                ? ('used-up' as const)
                : ('active' as const),
        }))
        .filter((i) => input.includeExpired || i.status === 'active')
        .sort((a, b) => b.createdAt - a.createdAt);
      return { output: { invites }, summary: plural(invites.length, 'invite') };
    },
  });

  return [usersList, listBanned, listMuted, listAllowed, listInvites] as unknown as ActionDef[];
}
