// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * API tokens for automation: `bh_<id>_<secret>`. Only a hash of the secret is
 * stored. Tokens are scoped (a subset of the creator's permissions), always
 * expire, and act with the creator's *current* roles, so demoting or removing
 * an admin immediately narrows or kills their tokens.
 */
import type { Permission, Ports } from '@beamhop/core';
import { COL } from '../settings.ts';
import { safeEqual, sha256Hex } from '../util.ts';

export interface TokenRecord {
  id: string;
  adminId: string;
  name: string;
  scopes: Permission[];
  hash: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
}

export type PublicToken = Omit<TokenRecord, 'hash'>;

const TOKEN_RE = /^bh_([0-9a-f]{16})_([0-9a-f]{48})$/;

export class TokenService {
  constructor(private readonly ports: Ports) {}

  async create(input: {
    adminId: string;
    name: string;
    scopes: Permission[];
    expiresAt: number;
  }): Promise<{ token: string; record: PublicToken }> {
    const id = this.ports.crypto.randomHex(8);
    const secret = this.ports.crypto.randomHex(24);
    const rec: TokenRecord = {
      ...input,
      id,
      hash: await sha256Hex(`beamhop-token:${secret}`),
      createdAt: this.ports.clock.now(),
    };
    await this.ports.docs.put(COL.tokens, id, rec);
    return { token: `bh_${id}_${secret}`, record: publicToken(rec) };
  }

  async verify(token: string): Promise<TokenRecord | null> {
    const m = TOKEN_RE.exec(token);
    if (!m) return null;
    const rec = await this.ports.docs.get<TokenRecord>(COL.tokens, m[1]!);
    if (!rec) return null;
    if (!safeEqual(rec.hash, await sha256Hex(`beamhop-token:${m[2]}`))) return null;
    if (rec.expiresAt <= this.ports.clock.now()) return null;
    return rec;
  }

  async touch(rec: TokenRecord): Promise<void> {
    const now = this.ports.clock.now();
    // Avoid a write per request: record usage at most once a minute.
    if (rec.lastUsedAt && now - rec.lastUsedAt < 60) return;
    await this.ports.docs.put(COL.tokens, rec.id, { ...rec, lastUsedAt: now });
  }

  get(id: string): Promise<TokenRecord | null> {
    return this.ports.docs.get<TokenRecord>(COL.tokens, id);
  }

  put(rec: TokenRecord): Promise<void> {
    return this.ports.docs.put(COL.tokens, rec.id, rec);
  }

  revoke(id: string): Promise<boolean> {
    return this.ports.docs.delete(COL.tokens, id);
  }

  async list(adminId?: string): Promise<PublicToken[]> {
    const page = await this.ports.docs.list<TokenRecord>(COL.tokens, { limit: 1000 });
    return page.items
      .map((i) => i.value)
      .filter((t) => !adminId || t.adminId === adminId)
      .map(publicToken);
  }
}

export function publicToken(rec: TokenRecord): PublicToken {
  const { hash: _hash, ...rest } = rec;
  return rest;
}
