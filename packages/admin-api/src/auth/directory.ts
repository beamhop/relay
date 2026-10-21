// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin directory: who may administer this node, with per-relay roles.
 * Also owns the one-time secrets that create admins: the first-run claim
 * code, invite codes and owner recovery codes (all stored hashed except the
 * claim code, which the runtime must be able to print until it is used).
 */
import type { Ports, Principal, RelayId, Role } from '@beamhop/core';
import { nip19 } from 'nostr-tools';
import { COL } from '../settings.ts';
import { humanCode, normalizeCode, safeEqual, sha256Hex } from '../util.ts';

export interface AdminRecord {
  /** Nostr pubkey hex for nostr admins, `passkey:<credentialId>` for passkey-only admins. */
  id: string;
  pubkey?: string;
  displayName?: string;
  roles: Record<RelayId | '*', Role>;
  createdAt: number;
  createdBy: string;
}

export interface InviteRecord {
  id: string;
  roles: Record<RelayId | '*', Role>;
  displayName?: string;
  createdAt: number;
  createdBy: string;
  expiresAt: number;
}

export function shortNpub(pubkey: string): string {
  try {
    const n = nip19.npubEncode(pubkey);
    return `${n.slice(0, 10)}…${n.slice(-4)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}

/** Accept hex or npub; return hex or null. */
export function parsePubkey(input: string): string | null {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  if (s.startsWith('npub1')) {
    try {
      const d = nip19.decode(s);
      if (d.type === 'npub') return d.data;
    } catch {
      return null;
    }
  }
  return null;
}

export function displayNameOf(rec: AdminRecord | null | undefined, fallbackId: string): string {
  if (rec?.displayName) return rec.displayName;
  const pk = rec?.pubkey ?? (/^[0-9a-f]{64}$/.test(fallbackId) ? fallbackId : undefined);
  if (pk) return shortNpub(pk);
  if (fallbackId.startsWith('passkey:')) return 'Passkey admin';
  if (fallbackId.startsWith('token:')) return 'API token';
  return fallbackId;
}

export function isOwner(rec: AdminRecord | null | undefined): boolean {
  return rec?.roles['*'] === 'owner';
}

export class Directory {
  constructor(private readonly ports: Ports) {}

  get(id: string): Promise<AdminRecord | null> {
    return this.ports.docs.get<AdminRecord>(COL.admins, id);
  }

  async list(): Promise<AdminRecord[]> {
    const out: AdminRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.ports.docs.list<AdminRecord>(COL.admins, { cursor, limit: 500 });
      out.push(...page.items.map((i) => i.value));
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  put(rec: AdminRecord): Promise<void> {
    return this.ports.docs.put(COL.admins, rec.id, rec);
  }

  remove(id: string): Promise<boolean> {
    return this.ports.docs.delete(COL.admins, id);
  }

  async ownerCount(): Promise<number> {
    return (await this.list()).filter(isOwner).length;
  }

  async isClaimed(): Promise<boolean> {
    return (await this.ports.docs.list(COL.admins, { limit: 1 })).items.length > 0;
  }

  principalOf(rec: AdminRecord, via: Principal['via']): Principal {
    const p: Principal = { id: rec.id, roles: { ...rec.roles }, via };
    if (rec.pubkey) p.pubkey = rec.pubkey;
    p.displayName = displayNameOf(rec, rec.id);
    return p;
  }

  // ───────────── first-run claim ─────────────

  /** Current claim code, generated on first call; null once the node has an owner. */
  async claimCode(): Promise<string | null> {
    if (await this.isClaimed()) return null;
    const cur = await this.ports.docs.get<{ code: string }>(COL.claim, 'code');
    if (cur) return cur.code;
    const next = { code: humanCode(4), createdAt: this.ports.clock.now() };
    if (await this.ports.docs.cas(COL.claim, 'code', null, next)) return next.code;
    return (await this.ports.docs.get<{ code: string }>(COL.claim, 'code'))?.code ?? null;
  }

  async checkClaim(code: string): Promise<boolean> {
    if (await this.isClaimed()) return false;
    const cur = await this.ports.docs.get<{ code: string }>(COL.claim, 'code');
    return !!cur && safeEqual(normalizeCode(cur.code), normalizeCode(code));
  }

  /** Atomically consume the claim code. */
  async redeemClaim(code: string): Promise<boolean> {
    if (!(await this.checkClaim(code))) return false;
    const cur = await this.ports.docs.get<{ code: string }>(COL.claim, 'code');
    if (!cur) return false;
    const ok = await this.ports.docs.cas<unknown>(COL.claim, 'code', cur, { used: true });
    if (ok) await this.ports.docs.delete(COL.claim, 'code');
    return ok;
  }

  // ───────────── invites ─────────────

  async createInvite(
    inv: Omit<InviteRecord, 'id' | 'createdAt' | 'expiresAt'>,
    ttlSeconds: number,
  ): Promise<{ code: string; invite: InviteRecord }> {
    const code = humanCode(3);
    const now = this.ports.clock.now();
    const invite: InviteRecord = {
      ...inv,
      id: (await sha256Hex(normalizeCode(code))).slice(0, 12),
      createdAt: now,
      expiresAt: now + ttlSeconds,
    };
    await this.ports.docs.put(COL.invites, await this.codeKey(code), invite);
    return { code, invite };
  }

  async peekInvite(code: string): Promise<InviteRecord | null> {
    const inv = await this.ports.docs.get<InviteRecord>(COL.invites, await this.codeKey(code));
    if (!inv || inv.expiresAt < this.ports.clock.now()) return null;
    return inv;
  }

  async redeemInvite(code: string): Promise<InviteRecord | null> {
    const key = await this.codeKey(code);
    const inv = await this.peekInvite(code);
    if (!inv) return null;
    return (await this.ports.docs.delete(COL.invites, key)) ? inv : null;
  }

  async deleteInvite(id: string): Promise<boolean> {
    const page = await this.ports.docs.list<InviteRecord>(COL.invites, { limit: 1000 });
    const hit = page.items.find((i) => i.value.id === id);
    return hit ? this.ports.docs.delete(COL.invites, hit.key) : false;
  }

  // ───────────── owner recovery codes ─────────────

  async regenerateRecoveryCodes(count = 10): Promise<string[]> {
    const existing = await this.ports.docs.list(COL.recovery, { limit: 1000 });
    for (const i of existing.items) await this.ports.docs.delete(COL.recovery, i.key);
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = humanCode(4);
      codes.push(code);
      await this.ports.docs.put(COL.recovery, await this.codeKey(code), {
        createdAt: this.ports.clock.now(),
      });
    }
    return codes;
  }

  async recoveryCodesLeft(): Promise<number> {
    return (await this.ports.docs.list(COL.recovery, { limit: 1000 })).items.length;
  }

  async checkRecovery(code: string): Promise<boolean> {
    return (await this.ports.docs.get(COL.recovery, await this.codeKey(code))) !== null;
  }

  async redeemRecovery(code: string): Promise<boolean> {
    return this.ports.docs.delete(COL.recovery, await this.codeKey(code));
  }

  private async codeKey(code: string): Promise<string> {
    return sha256Hex(`beamhop-code:${normalizeCode(code)}`);
  }
}
