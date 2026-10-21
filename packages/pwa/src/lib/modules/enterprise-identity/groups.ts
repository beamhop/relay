// SPDX-License-Identifier: AGPL-3.0-or-later
/** Company groups screen: shapes of the identity actions and their plain wording (lazy chunk). */

export type Role = 'owner' | 'admin' | 'moderator' | 'viewer';
export type KeyModel = 'self-custody' | 'managed';
export type PersonStatus = 'pending' | 'active' | 'suspended' | 'deleted';

/** `enterprise.list-mappings` row. */
export interface Mapping {
  idp: string;
  group: string;
  relays: Array<{ relayId: string; access: 'read' | 'write' }>;
  tier?: string;
  adminRole?: Role;
  keyModel?: KeyModel;
  channel?: boolean;
  createdAt?: number;
  createdBy?: string;
  people?: number;
}

/** `enterprise.list-people` row. */
export interface Person {
  key: string;
  email?: string;
  name?: string;
  pubkey?: string;
  keyModel: KeyModel;
  status: PersonStatus;
  groups: string[];
  source: string;
}

/** `enterprise.directory-status` provider. */
export interface Provider {
  id: string;
  type: 'google' | 'microsoft' | 'oidc';
  name: string;
  people: number;
  provisioning: 'scim' | 'google' | 'none';
  scimTokenLast4?: string;
}

export interface DirectoryStatus {
  providers: Provider[];
  directorySync: {
    enabled: boolean;
    configured: boolean;
    idp: string;
    intervalMinutes: number;
    lastRunAt: number | null;
    lastReport: unknown;
  };
}

export const ROLE: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  moderator: 'Moderator',
  viewer: 'Viewer',
};

export const KEYS: Record<KeyModel, string> = {
  'self-custody': 'Own keys',
  managed: 'Company keeps keys',
};

export const STATUS: Record<
  PersonStatus,
  { label: string; tone: 'ok' | 'warn' | 'critical' | 'neutral' }
> = {
  active: { label: 'Active', tone: 'ok' },
  pending: { label: 'Not linked yet', tone: 'warn' },
  suspended: { label: 'Access removed', tone: 'critical' },
  deleted: { label: 'Left', tone: 'neutral' },
};

/** "Posts on main, reads archive" — plain relay access of a rule. */
export function describeAccess(m: Pick<Mapping, 'relays'>): string {
  if (!m.relays?.length) return 'No relays';
  return m.relays
    .map((r) => `${r.access === 'read' ? 'Reads' : 'Posts on'} ${r.relayId}`)
    .join(', ');
}

/** A person by name: directory name, else email, else the known Nostr name. */
export function personLabel(
  p: Pick<Person, 'name' | 'email' | 'pubkey' | 'key'>,
  names: { label(pubkey: string | null | undefined): string },
): string {
  return p.name || p.email || (p.pubkey ? names.label(p.pubkey) : 'Someone from the directory');
}

export function provisioningText(p: Pick<Provider, 'provisioning'>): string {
  return p.provisioning === 'none'
    ? 'people are added when they first sign in'
    : 'people are added and removed automatically';
}
