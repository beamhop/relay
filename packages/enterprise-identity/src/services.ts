// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loose views of services provided by other modules through `kernel.provide()`.
 * Every one of them is optional: the identity module degrades gracefully when a
 * provider is missing (e.g. no keyvault → self-custody only).
 */
import type { Kernel, NostrEvent, Principal, RelayId, Role, UnsignedEvent } from '@beamhop/core';

/**
 * `kernel.use<KeyVaultService>('enterprise.keyvault')` — implemented by the
 * `enterprise-keyvault` module (managed keys + built-in NIP-46 bunker, §12.3).
 * `subjectId` is the binding key `<idp>:<subject>`.
 */
export interface KeyVaultService {
  /** Create (first call) or return the managed keypair for a subject; returns the hex pubkey. */
  ensureKey(subjectId: string): Promise<string>;
  /** `bunker://…` URL that lets the SSO session `sessionId` sign with the subject's managed key. */
  bunkerUrlFor(sessionId: string, subjectId?: string): Promise<string>;
  /** Optional: sign an event with the subject's managed key (profile sync). */
  sign?(subjectId: string, event: UnsignedEvent): Promise<NostrEvent>;
  /** Optional: drop bunker sessions (offboarding). Without `sessionId`: all sessions of the subject. */
  revokeSessions?(subjectId: string, sessionId?: string): Promise<void>;
  /** Optional: crypto-shred the managed key (after the offboarding grace period). */
  destroyKey?(subjectId: string, reason: string): Promise<void>;
}

/** `kernel.use('admin.sessions')` (admin-api). */
export interface AdminSessionsLike {
  issue(
    adminId: string,
    via: 'sso' | 'nip07' | 'nip46' | 'passkey' | 'cli',
  ): Promise<{ token: string; expiresAt: number }>;
}

export interface AdminRecordLike {
  id: string;
  pubkey?: string;
  displayName?: string;
  roles: Record<RelayId | '*', Role>;
  createdAt: number;
  createdBy: string;
}

/** `kernel.use('admin.directory')` (admin-api). */
export interface AdminDirectoryLike {
  get(id: string): Promise<AdminRecordLike | null>;
  put(rec: AdminRecordLike): Promise<void>;
  remove(id: string): Promise<boolean>;
  list(): Promise<AdminRecordLike[]>;
}

/** `kernel.use('relay.groups')` (relay, NIP-29). */
export interface GroupsLike {
  get(relayId: RelayId, id: string): Promise<GroupLike | null>;
  list(relayId: RelayId): Promise<GroupLike[]>;
  create(
    relayId: RelayId,
    input: {
      id?: string;
      name: string;
      about?: string;
      private?: boolean;
      closed?: boolean;
      members?: Array<{ pubkey: string; roles?: Array<'admin' | 'moderator'> }>;
    },
  ): Promise<GroupLike>;
  addMembers(
    relayId: RelayId,
    id: string,
    entries: Array<{ pubkey: string; roles?: Array<'admin' | 'moderator'> }>,
  ): Promise<GroupLike>;
  removeMembers(relayId: RelayId, id: string, pubkeys: string[]): Promise<GroupLike>;
  setMembers(
    relayId: RelayId,
    id: string,
    pubkeys: string[],
    opts?: { admins?: string[] },
  ): Promise<GroupLike>;
}

export interface GroupLike {
  id: string;
  name: string;
  members: Record<string, Array<'admin' | 'moderator'>>;
}

/** `kernel.use('relay.engine')` — `disconnectPubkey` is a requested additive relay hook; until it exists the revocation list blocks every read/write. */
export interface RelayEngineLike {
  broadcast?(relayId: RelayId, event: NostrEvent): Promise<void> | void;
  disconnectPubkey?(pubkey: string, reason?: string): Promise<number> | number;
}

/** `kernel.use('policy')` — only the allowlist part is used. */
export interface PolicyLike {
  state?: {
    disallow?(relayId: RelayId, pubkey: string): Promise<boolean>;
  };
  clearTierCache?(): void;
}

/** `kernel.use('lifecycle.holds')` — legal holds (§12.7) block key destruction. */
export interface LegalHoldsLike {
  isHeld(subject: { pubkey?: string; subjectId?: string; relayId?: RelayId }): Promise<boolean>;
}

export interface Services {
  keyvault(): KeyVaultService | undefined;
  adminSessions(): AdminSessionsLike | undefined;
  adminDirectory(): AdminDirectoryLike | undefined;
  groups(): GroupsLike | undefined;
  engine(): RelayEngineLike | undefined;
  policy(): PolicyLike | undefined;
  holds(): LegalHoldsLike | undefined;
}

export function services(kernel: Kernel): Services {
  return {
    keyvault: () => kernel.use<KeyVaultService>('enterprise.keyvault'),
    adminSessions: () => kernel.use<AdminSessionsLike>('admin.sessions'),
    adminDirectory: () => kernel.use<AdminDirectoryLike>('admin.directory'),
    groups: () => kernel.use<GroupsLike>('relay.groups'),
    engine: () => kernel.use<RelayEngineLike>('relay.engine'),
    policy: () => kernel.use<PolicyLike>('policy'),
    holds: () => kernel.use<LegalHoldsLike>('lifecycle.holds'),
  };
}

export type { Principal };
