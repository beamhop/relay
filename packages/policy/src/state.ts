// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Persistent policy state (DocStore) with per-relay in-memory caches for the
 * hot path. Writes go to the DocStore first, then the cache; other nodes are
 * told to reload via PubSub.
 */
import type { NostrEvent, Ports, RelayId } from '@beamhop/core';
import { listAll, rkey } from './util.ts';

export const COLLECTIONS = {
  allowlist: 'policy.allowlist',
  invites: 'policy.invites',
  tiers: 'policy.tiers',
  bans: 'policy.bans',
  mutes: 'policy.mutes',
  queue: 'policy.queue',
  recycle: 'policy.recycle',
  wot: 'policy.wot',
  seen: 'policy.seen',
} as const;

export const INVALIDATE_CHANNEL = 'policy.invalidate';

export interface AllowEntry {
  pubkey: string;
  addedAt: number;
  by: string;
  via: 'admin' | 'invite';
  note?: string;
  invite?: string;
}

export interface InviteEntry {
  code: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  by: string;
  note?: string;
  redeemedBy: string[];
}

export interface TierEntry {
  pubkey: string;
  tier: string;
  setAt: number;
  by: string;
}

export interface BanEntry {
  pubkey: string;
  at: number;
  by: string;
  reason?: string;
}

export interface MuteEntry {
  pubkey: string;
  at: number;
  by: string;
  /** Unix seconds; absent = indefinitely. */
  until?: number;
}

export interface RecycleEntry {
  /** Event id or blob sha256. */
  id: string;
  type: 'event' | 'blob';
  event?: NostrEvent;
  /** Blob: pubkeys that owned it in this relay (restored on undo). */
  owners?: string[];
  removedAt: number;
  purgeAt: number;
  by: string;
  reason?: string;
}

interface RelayCache {
  bans: Map<string, BanEntry>;
  mutes: Map<string, MuteEntry>;
  allow: Map<string, AllowEntry>;
  tiers: Map<string, TierEntry>;
  recycled: Set<string>;
}

export type InviteResult =
  | { ok: true; entry: AllowEntry }
  | { ok: false; reason: 'unknown' | 'expired' | 'used-up' };

export class PolicyState {
  private caches = new Map<RelayId, Promise<RelayCache>>();
  private seen = new Map<string, number>();
  readonly origin: string;

  constructor(private readonly ports: Ports) {
    this.origin = ports.crypto.randomHex(8);
  }

  /** Load (once) the relay's hot-path sets. */
  load(relayId: RelayId): Promise<RelayCache> {
    let p = this.caches.get(relayId);
    if (!p) {
      p = this.read(relayId);
      this.caches.set(relayId, p);
      p.catch(() => this.caches.delete(relayId));
    }
    return p;
  }

  /** Drop a relay's cache (reloaded lazily). */
  invalidate(relayId: RelayId): void {
    this.caches.delete(relayId);
  }

  private async read(relayId: RelayId): Promise<RelayCache> {
    const docs = this.ports.docs;
    const prefix = `${relayId}:`;
    const [bans, mutes, allow, tiers, recycle] = await Promise.all([
      listAll<BanEntry>(docs, COLLECTIONS.bans, prefix),
      listAll<MuteEntry>(docs, COLLECTIONS.mutes, prefix),
      listAll<AllowEntry>(docs, COLLECTIONS.allowlist, prefix),
      listAll<TierEntry>(docs, COLLECTIONS.tiers, prefix),
      listAll<RecycleEntry>(docs, COLLECTIONS.recycle, prefix),
    ]);
    return {
      bans: new Map(bans.map((x) => [x.value.pubkey, x.value])),
      mutes: new Map(mutes.map((x) => [x.value.pubkey, x.value])),
      allow: new Map(allow.map((x) => [x.value.pubkey, x.value])),
      tiers: new Map(tiers.map((x) => [x.value.pubkey, x.value])),
      recycled: new Set(recycle.map((x) => x.value.id)),
    };
  }

  private async changed(relayId: RelayId, what: string): Promise<void> {
    try {
      await this.ports.pubsub.publish(INVALIDATE_CHANNEL, { relayId, what, origin: this.origin });
    } catch {
      // Fan-out is best effort; local cache is already up to date.
    }
  }

  // ── bans ──
  async isBanned(relayId: RelayId, pubkey: string): Promise<boolean> {
    return (await this.load(relayId)).bans.has(pubkey);
  }
  async getBan(relayId: RelayId, pubkey: string): Promise<BanEntry | undefined> {
    return (await this.load(relayId)).bans.get(pubkey);
  }
  async listBans(relayId: RelayId): Promise<BanEntry[]> {
    return [...(await this.load(relayId)).bans.values()];
  }
  async ban(relayId: RelayId, entry: BanEntry): Promise<void> {
    await this.ports.docs.put(COLLECTIONS.bans, rkey(relayId, entry.pubkey), entry);
    (await this.load(relayId)).bans.set(entry.pubkey, entry);
    await this.changed(relayId, 'bans');
  }
  async unban(relayId: RelayId, pubkey: string): Promise<boolean> {
    const had = await this.ports.docs.delete(COLLECTIONS.bans, rkey(relayId, pubkey));
    (await this.load(relayId)).bans.delete(pubkey);
    await this.changed(relayId, 'bans');
    return had;
  }

  // ── mutes ──
  async isMuted(relayId: RelayId, pubkey: string, now: number): Promise<boolean> {
    const m = (await this.load(relayId)).mutes.get(pubkey);
    return !!m && (m.until === undefined || m.until > now);
  }
  async getMute(relayId: RelayId, pubkey: string): Promise<MuteEntry | undefined> {
    return (await this.load(relayId)).mutes.get(pubkey);
  }
  async mute(relayId: RelayId, entry: MuteEntry): Promise<void> {
    await this.ports.docs.put(COLLECTIONS.mutes, rkey(relayId, entry.pubkey), entry);
    (await this.load(relayId)).mutes.set(entry.pubkey, entry);
    await this.changed(relayId, 'mutes');
  }
  async unmute(relayId: RelayId, pubkey: string): Promise<boolean> {
    const had = await this.ports.docs.delete(COLLECTIONS.mutes, rkey(relayId, pubkey));
    (await this.load(relayId)).mutes.delete(pubkey);
    await this.changed(relayId, 'mutes');
    return had;
  }

  // ── allowlist ──
  async isAllowlisted(relayId: RelayId, pubkey: string): Promise<boolean> {
    return (await this.load(relayId)).allow.has(pubkey);
  }
  async getAllow(relayId: RelayId, pubkey: string): Promise<AllowEntry | undefined> {
    return (await this.load(relayId)).allow.get(pubkey);
  }
  async listAllowlist(relayId: RelayId): Promise<AllowEntry[]> {
    return [...(await this.load(relayId)).allow.values()];
  }
  async allow(relayId: RelayId, entry: AllowEntry): Promise<void> {
    await this.ports.docs.put(COLLECTIONS.allowlist, rkey(relayId, entry.pubkey), entry);
    (await this.load(relayId)).allow.set(entry.pubkey, entry);
    await this.changed(relayId, 'allowlist');
  }
  async disallow(relayId: RelayId, pubkey: string): Promise<boolean> {
    const had = await this.ports.docs.delete(COLLECTIONS.allowlist, rkey(relayId, pubkey));
    (await this.load(relayId)).allow.delete(pubkey);
    await this.changed(relayId, 'allowlist');
    return had;
  }

  // ── invites ──
  async createInvite(relayId: RelayId, entry: InviteEntry): Promise<void> {
    await this.ports.docs.put(COLLECTIONS.invites, rkey(relayId, entry.code), entry);
  }
  async getInvite(relayId: RelayId, code: string): Promise<InviteEntry | null> {
    return this.ports.docs.get<InviteEntry>(COLLECTIONS.invites, rkey(relayId, code));
  }
  async deleteInvite(relayId: RelayId, code: string): Promise<boolean> {
    return this.ports.docs.delete(COLLECTIONS.invites, rkey(relayId, code));
  }
  async listInvites(relayId: RelayId): Promise<InviteEntry[]> {
    return (await listAll<InviteEntry>(this.ports.docs, COLLECTIONS.invites, `${relayId}:`)).map(
      (x) => x.value,
    );
  }
  /** Redeem an invite code: adds the pubkey to the allowlist. Uses CAS for the use counter. */
  async redeemInvite(relayId: RelayId, code: string, pubkey: string): Promise<InviteResult> {
    const now = this.ports.clock.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const inv = await this.getInvite(relayId, code);
      if (!inv) return { ok: false, reason: 'unknown' };
      if (inv.expiresAt <= now) return { ok: false, reason: 'expired' };
      const existing = await this.getAllow(relayId, pubkey);
      if (existing) return { ok: true, entry: existing };
      if (inv.uses >= inv.maxUses) return { ok: false, reason: 'used-up' };
      const next: InviteEntry = {
        ...inv,
        uses: inv.uses + 1,
        redeemedBy: [...inv.redeemedBy, pubkey],
      };
      if (!(await this.ports.docs.cas(COLLECTIONS.invites, rkey(relayId, code), inv, next))) {
        continue;
      }
      const entry: AllowEntry = {
        pubkey,
        addedAt: now,
        by: `invite:${code}`,
        via: 'invite',
        invite: code,
      };
      await this.allow(relayId, entry);
      return { ok: true, entry };
    }
    return { ok: false, reason: 'used-up' };
  }

  // ── tiers ──
  async explicitTier(relayId: RelayId, pubkey: string): Promise<TierEntry | undefined> {
    return (await this.load(relayId)).tiers.get(pubkey);
  }
  async setTier(
    relayId: RelayId,
    entry: TierEntry | { pubkey: string; tier: null },
  ): Promise<void> {
    const cache = await this.load(relayId);
    if (entry.tier === null) {
      await this.ports.docs.delete(COLLECTIONS.tiers, rkey(relayId, entry.pubkey));
      cache.tiers.delete(entry.pubkey);
    } else {
      await this.ports.docs.put(COLLECTIONS.tiers, rkey(relayId, entry.pubkey), entry);
      cache.tiers.set(entry.pubkey, entry as TierEntry);
    }
    await this.changed(relayId, 'tiers');
  }

  // ── recycle bin ──
  async isRecycled(relayId: RelayId, id: string): Promise<boolean> {
    return (await this.load(relayId)).recycled.has(id);
  }
  async getRecycled(relayId: RelayId, id: string): Promise<RecycleEntry | null> {
    return this.ports.docs.get<RecycleEntry>(COLLECTIONS.recycle, rkey(relayId, id));
  }
  async listRecycled(relayId: RelayId): Promise<RecycleEntry[]> {
    return (await listAll<RecycleEntry>(this.ports.docs, COLLECTIONS.recycle, `${relayId}:`)).map(
      (x) => x.value,
    );
  }
  async putRecycled(relayId: RelayId, entry: RecycleEntry): Promise<void> {
    await this.ports.docs.put(COLLECTIONS.recycle, rkey(relayId, entry.id), entry);
    (await this.load(relayId)).recycled.add(entry.id);
    await this.changed(relayId, 'recycle');
  }
  async dropRecycled(relayId: RelayId, id: string): Promise<boolean> {
    const had = await this.ports.docs.delete(COLLECTIONS.recycle, rkey(relayId, id));
    (await this.load(relayId)).recycled.delete(id);
    await this.changed(relayId, 'recycle');
    return had;
  }

  // ── first-seen (for "new key" checks) ──
  async firstSeen(relayId: RelayId, pubkey: string): Promise<number | undefined> {
    const k = rkey(relayId, pubkey);
    const hit = this.seen.get(k);
    if (hit !== undefined) return hit;
    const v = await this.ports.docs.get<number>(COLLECTIONS.seen, k);
    if (v !== null) this.remember(k, v);
    return v ?? undefined;
  }
  async markSeen(relayId: RelayId, pubkey: string, at: number): Promise<void> {
    const k = rkey(relayId, pubkey);
    if (this.seen.has(k)) return;
    const v = await this.ports.docs.get<number>(COLLECTIONS.seen, k);
    if (v === null) {
      await this.ports.docs.cas<number>(COLLECTIONS.seen, k, null, at);
      this.remember(k, at);
    } else {
      this.remember(k, v);
    }
  }
  private remember(k: string, v: number): void {
    if (this.seen.size >= 200_000) {
      const first = this.seen.keys().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    this.seen.set(k, v);
  }
}
