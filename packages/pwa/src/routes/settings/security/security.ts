// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sign-in & recovery logic (§6.4, §6.11): the recovery checklist, API token
 * rows with scopes in plain words, and owners.
 */
import { m } from '$lib/paraglide/messages.js';

export interface RecoveryStatus {
  owner: boolean;
  owners: Array<{ id: string; pubkey?: string; displayName: string }>;
  recoveryCodesLeft: number | null;
  passkeys: number;
}

export interface ChecklistRow {
  id: 'codes' | 'owner' | 'passkey';
  label: string;
  done: boolean;
}

/** What keeps the relay recoverable if an owner loses their key. */
export function recoveryChecklist(s: RecoveryStatus, codesSaved: boolean): ChecklistRow[] {
  return [
    {
      id: 'codes',
      label: m.ppl_sec_check_codes(),
      done: (s.recoveryCodesLeft ?? 0) > 0 && codesSaved,
    },
    { id: 'owner', label: m.ppl_sec_check_owner(), done: s.owners.length >= 2 },
    { id: 'passkey', label: m.ppl_sec_check_passkey(), done: s.passkeys > 0 },
  ];
}

export interface TokenInfo {
  id: string;
  name: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  adminId?: string;
  adminName?: string;
}

const SCOPE_LABEL: Record<string, () => string> = {
  'relay.read': () => m.ppl_scope_read(),
  'insights.read': () => m.ppl_scope_insights(),
  'moderation.write': () => m.ppl_scope_moderation(),
  'media.write': () => m.ppl_scope_media(),
  'users.write': () => m.ppl_scope_users(),
  'config.write': () => m.ppl_scope_config(),
  'plugins.write': () => m.ppl_scope_plugins(),
  'admins.manage': () => m.ppl_scope_admins(),
  'node.manage': () => m.ppl_scope_node(),
  'compliance.read': () => m.ppl_scope_compliance_read(),
  'compliance.write': () => m.ppl_scope_compliance_write(),
};

/** A permission scope in plain words (the raw string stays behind the lens). */
export function scopeLabel(scope: string): string {
  return SCOPE_LABEL[scope]?.() ?? scope;
}

export type TokenState = 'active' | 'soon' | 'expired';

/** Whole days until a token stops working (negative when already expired). */
export function daysLeft(expiresAt: number, now = Date.now() / 1000): number {
  return Math.floor((expiresAt - now) / 86400);
}

export function tokenState(t: Pick<TokenInfo, 'expiresAt'>, now = Date.now() / 1000): TokenState {
  if (t.expiresAt <= now) return 'expired';
  return daysLeft(t.expiresAt, now) < 7 ? 'soon' : 'active';
}

/** Newest first, expired at the end. */
export function sortTokens<T extends TokenInfo>(tokens: T[], now = Date.now() / 1000): T[] {
  return [...tokens].sort((a, b) => {
    const ea = a.expiresAt <= now ? 1 : 0;
    const eb = b.expiresAt <= now ? 1 : 0;
    return ea - eb || b.createdAt - a.createdAt;
  });
}
