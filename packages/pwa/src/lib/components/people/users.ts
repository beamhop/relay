// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * People list. Uses `users.list` when a module provides it; otherwise the
 * list is assembled from what the API exposes today: media uploaders
 * (`media.list-blobs`), recent authors seen live, and the admin team.
 */
import type { BlobItem } from '../../api/types.ts';
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
