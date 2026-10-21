// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * People list. Uses `users.list` when a module provides it; otherwise the
 * list is assembled from what the API exposes today: media uploaders
 * (`media.list-blobs`), recent authors seen live, and the admin team.
 */
import type { BlobItem } from '../../api/types.ts';
import { npubEncode } from '../../npub.ts';
import type { LiveItem } from '../../stores/live.svelte.ts';

export interface UserRow {
  pubkey: string;
  name?: string;
  tier?: string;
  lastSeen?: number;
  events?: number;
  storageBytes?: number;
  files?: number;
  banned?: boolean;
  muted?: boolean;
  admin?: boolean;
  /** On the relay's allow list (only meaningful in allow-list mode). */
  allowlisted?: boolean;
  /** The plan was set by hand rather than by tier rules. */
  tierExplicit?: boolean;
  firstSeen?: number;
  /** Storage limit for this person (bytes), when one applies. */
  quotaBytes?: number | null;
  /** Bytes used (same as storageBytes on servers that send both). */
  usedBytes?: number;
  remainingBytes?: number;
  overQuota?: boolean;
}

export interface QuotaInfo {
  used: number;
  quota: number;
  left: number;
  over: boolean;
  /** 0..1 for the bar. */
  fraction: number;
}

/** Quota numbers for a person, or null when no limit applies. */
export function quotaOf(u: {
  storageBytes?: number;
  usedBytes?: number;
  quotaBytes?: number | null;
  remainingBytes?: number;
  overQuota?: boolean;
}): QuotaInfo | null {
  const quota = u.quotaBytes;
  if (quota === undefined || quota === null || !(quota > 0)) return null;
  const used = u.usedBytes ?? u.storageBytes ?? 0;
  const over = u.overQuota ?? used > quota;
  const left = u.remainingBytes ?? Math.max(0, quota - used);
  return { used, quota, left, over, fraction: Math.min(1, used / quota) };
}

export function mergeUsers(
  blobs: BlobItem[],
  liveItems: LiveItem[],
  admins: Array<{ pubkey?: string; displayName?: string }>,
): UserRow[] {
  const map = new Map<string, UserRow>();
  const get = (pk: string) => {
    let u = map.get(pk);
    if (!u) {
      u = { pubkey: pk };
      map.set(pk, u);
    }
    return u;
  };
  for (const b of blobs) {
    const u = get(b.pubkey);
    u.storageBytes = (u.storageBytes ?? 0) + (b.size ?? 0);
    u.files = (u.files ?? 0) + 1;
    if (b.uploadedAt) u.lastSeen = Math.max(u.lastSeen ?? 0, b.uploadedAt);
  }
  for (const i of liveItems) {
    const ev = i.data.event as { pubkey?: string; created_at?: number } | undefined;
    const pk = ev?.pubkey ?? (i.data.pubkey as string | undefined);
    if (!pk || !/^[0-9a-f]{64}$/.test(pk)) continue;
    const u = get(pk);
    u.events = (u.events ?? 0) + (i.name === 'event.accepted' ? 1 : 0);
    u.lastSeen = Math.max(u.lastSeen ?? 0, Math.floor(i.at / 1000));
  }
  for (const a of admins) {
    if (!a.pubkey) continue;
    const u = get(a.pubkey);
    u.admin = true;
    if (a.displayName) u.name = a.displayName;
  }
  return [...map.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/**
 * Whether a person is held back here (blocked, muted, or not on the allow
 * list while the relay only lets members post): those rows get a "Why?".
 */
export function isRestricted(u: UserRow, accessMode?: string): boolean {
  if (u.banned || u.muted) return true;
  return accessMode === 'allowlist' && u.allowlisted === false && !u.admin;
}

/** Technical lens lines for a person row (npub, hex, tier id, raw quota numbers). */
export function userLensLines(u: UserRow): string[] {
  const lines: string[] = [];
  const npub = npubEncode(u.pubkey);
  if (npub) lines.push(npub);
  lines.push(`hex ${u.pubkey}`);
  if (u.tier) lines.push(`tier ${u.tier}${u.tierExplicit ? ' (explicit)' : ''}`);
  if (u.quotaBytes !== undefined && u.quotaBytes !== null) lines.push(`quotaBytes ${u.quotaBytes}`);
  const used = u.usedBytes ?? u.storageBytes;
  if (used !== undefined) lines.push(`usedBytes ${used}`);
  if (u.remainingBytes !== undefined) lines.push(`remainingBytes ${u.remainingBytes}`);
  const flags = [
    u.banned && 'policy.bans',
    u.muted && 'policy.mutes',
    u.allowlisted && 'policy.allowlist',
  ].filter(Boolean);
  if (flags.length) lines.push(`in ${flags.join(', ')}`);
  return lines;
}
