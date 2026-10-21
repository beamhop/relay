// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RelayId } from './ports.ts';

export type Role = 'owner' | 'admin' | 'moderator' | 'viewer';

export type Permission =
  | 'relay.read'
  | 'insights.read'
  | 'moderation.write'
  | 'users.write'
  | 'media.write'
  | 'config.write'
  | 'plugins.write'
  | 'admins.manage'
  | 'node.manage'
  | 'compliance.read'
  | 'compliance.write';

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ['relay.read', 'insights.read'],
  moderator: ['relay.read', 'insights.read', 'moderation.write', 'media.write'],
  admin: [
    'relay.read',
    'insights.read',
    'moderation.write',
    'media.write',
    'users.write',
    'config.write',
    'plugins.write',
  ],
  owner: [
    'relay.read',
    'insights.read',
    'moderation.write',
    'media.write',
    'users.write',
    'config.write',
    'plugins.write',
    'admins.manage',
    'node.manage',
    'compliance.read',
    'compliance.write',
  ],
};

/** An authenticated admin/API principal. */
export interface Principal {
  /** Stable id: npub hex for nostr logins, `passkey:<id>`, `token:<id>`, `sso:<idp>:<sub>`. */
  id: string;
  /** Nostr pubkey if known. */
  pubkey?: string;
  displayName?: string;
  /** Role per relay; `*` applies to all relays on the node. */
  roles: Record<RelayId | '*', Role>;
  via: 'nip07' | 'nip46' | 'passkey' | 'token' | 'sso' | 'cli';
  /** Token scopes narrow permissions further. */
  scopes?: Permission[];
}

export function permissionsFor(p: Principal, relayId: RelayId | null): Set<Permission> {
  const out = new Set<Permission>();
  const roles: Role[] = [];
  const global = p.roles['*'];
  if (global) roles.push(global);
  if (relayId && p.roles[relayId]) roles.push(p.roles[relayId] as Role);
  for (const r of roles) for (const perm of ROLE_PERMISSIONS[r]) out.add(perm);
  if (p.scopes) for (const perm of [...out]) if (!p.scopes.includes(perm)) out.delete(perm);
  return out;
}

export function can(p: Principal, perm: Permission, relayId: RelayId | null): boolean {
  return permissionsFor(p, relayId).has(perm);
}

/** Pluggable admin auth providers (nostr, passkey, token built-in; SSO via enterprise module). */
export interface AuthProvider {
  id: string;
  /** Short label for the login screen, e.g. "Sign in with Google". */
  label: string;
  /** Resolve a principal from an HTTP request, or null if this provider does not apply. */
  authenticate(req: Request): Promise<Principal | null>;
}
