// SPDX-License-Identifier: AGPL-3.0-or-later
/** Company keys screen: shapes of the key-vault actions and their plain wording (lazy chunk). */

export type KeyStatus = 'active' | 'pending-destroy' | 'destroyed';

export interface VaultStatus {
  provider: string | null;
  kekId: string | null;
  ready: boolean;
  error?: string | null;
  dataKeys: number;
  pendingRotation: number;
  keys: Record<KeyStatus, number>;
  bunkerPubkey?: string | null;
  escrowEnabled?: boolean;
  signing?: { signed: number; errors: number; rateLimited: number; since: number };
}

/** `keyvault.list-keys` row. */
export interface ManagedKey {
  subjectId: string;
  pubkey: string;
  status: KeyStatus;
  createdAt: number;
  destroyAfter?: number;
  destroyReason?: string;
  destroyedAt?: number;
  heldSince?: number;
}

/** `enterprise.list-key-destructions` row (people who left). */
export interface Destruction {
  subjectId: string;
  pubkey?: string;
  dueAt: number;
  status: 'scheduled' | 'held' | 'destroyed' | 'waiting-keyvault';
  updatedAt: number;
}

export interface AuditRecord {
  id: string;
  /** Unix ms. */
  at: number;
  op: string;
  subjectId: string;
  pubkey?: string;
  kind?: number;
  eventId?: string;
  sessionId?: string;
  client?: string;
  via?: string;
  principalId?: string;
  reason?: string;
  ok: boolean;
  error?: string;
}

const PROVIDERS: Record<string, string> = {
  local: 'this server (master key file)',
  'aws-kms': 'AWS Key Management Service',
  'gcp-kms': 'Google Cloud KMS',
  'azure-keyvault': 'Azure Key Vault',
  'vault-transit': 'HashiCorp Vault',
  'cf-secrets': 'Cloudflare secrets',
};

/** Where the master key lives, in plain words. */
export function providerName(p: string | null | undefined): string {
  if (!p) return 'nowhere yet';
  return PROVIDERS[p] ?? p;
}

const KIND: Record<number, string> = {
  0: 'a profile',
  1: 'a post',
  3: 'a follow list',
  5: 'a deletion',
  7: 'a reaction',
  13: 'a private message',
  1059: 'a private message',
  22242: 'a sign-in',
  24133: 'an app connection',
  27235: 'a sign-in',
};

/** "Signed a post", "Opened a private message for compliance", … */
export function auditText(r: Pick<AuditRecord, 'op' | 'kind' | 'ok'>): string {
  const what = r.kind !== undefined ? (KIND[r.kind] ?? 'an event') : 'an event';
  const text: Record<string, string> = {
    sign: `Signed ${what}`,
    nip44_encrypt: 'Encrypted a message',
    nip44_decrypt: 'Decrypted a message',
    escrow_decrypt: 'Opened a private message for compliance',
    create: 'Created the key',
    destroy: 'Destroyed the key',
    destroy_scheduled: 'Scheduled the key for destruction',
    destroy_blocked: 'A legal hold stopped the key being destroyed',
    destroy_cancelled: 'Kept the key',
  };
  const t = text[r.op] ?? r.op;
  return r.ok ? t : `Refused: ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}

/** "on 3 Nov 2026" for a unix time in seconds. */
export function onDate(at: number): string {
  return new Date(at * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
