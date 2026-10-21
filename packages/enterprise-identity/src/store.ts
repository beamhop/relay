// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Enterprise identity state in the DocStore. All collections are prefixed
 * `enterprise.` and are only touched once the module is enabled (§12.0.3).
 *
 * - `enterprise.bindings`  `<idp>:<subject>` → {@link Binding}
 * - `enterprise.alias`     `pk:<hex>` | `email:<addr>` | `sub:<idp>:<sub>` | `scim:<id>` → binding key
 * - `enterprise.groups`    `<idp>:<groupId>` → {@link DirectoryGroup}
 * - `enterprise.mappings`  `<idp|*>:<group>` → {@link GroupMapping}
 * - `enterprise.revoked`   `<hex pubkey>` → {@link Revocation} (checked on every read/write)
 */
import type { Kernel, RelayId, Role } from '@beamhop/core';
import type { KeyModel } from './config.ts';

export const COL = {
  bindings: 'enterprise.bindings',
  alias: 'enterprise.alias',
  groups: 'enterprise.groups',
  mappings: 'enterprise.mappings',
  revoked: 'enterprise.revoked',
  secrets: 'enterprise.secrets',
  oidcState: 'enterprise.oidc-state',
  challenges: 'enterprise.challenges',
  teamSessions: 'enterprise.team-sessions',
  profiles: 'enterprise.profiles',
  keyDestruction: 'enterprise.key-destruction',
  sync: 'enterprise.sync',
} as const;

export const INVALIDATE_CHANNEL = 'enterprise.invalidate';
export const REVOKED_CHANNEL = 'enterprise.revoked';

export type BindingStatus = 'pending' | 'active' | 'suspended' | 'deleted';
export type BindingSource = 'oidc' | 'scim' | 'google';

export interface Binding {
  idp: string;
  /** Stable IdP subject: Google user id, Entra object id (`oid`), OIDC `sub`, or SCIM externalId. */
  subject: string;
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  title?: string;
  department?: string;
  picture?: string;
  /** Manager email or subject from the IdP (ownership transfer target). */
  manager?: string;
  /** Group refs (ids or names as delivered by the IdP). */
  groups: string[];
  /** Bound nostr pubkey (hex). Absent until linked / managed key created. */
  npub?: string;
  /** Last pubkey before offboarding unbound it (history only). */
  previousNpub?: string;
  keyModel: KeyModel;
  status: BindingStatus;
  source: BindingSource;
  scimId?: string;
  externalId?: string;
  userName?: string;
  createdAt: number;
  updatedAt: number;
  boundAt?: number;
  offboardedAt?: number;
}

export interface DirectoryGroup {
  idp: string;
  id: string;
  displayName: string;
  externalId?: string;
  email?: string;
  /** Binding keys of members. */
  members: string[];
  source: BindingSource;
  updatedAt: number;
}

export interface RelayGrant {
  relayId: RelayId;
  access: 'read' | 'write';
}

export interface GroupMapping {
  /** IdP id, or `*` for any IdP. */
  idp: string;
  /** Group id, external id, display name or email (matched case-insensitively). */
  group: string;
  relays: RelayGrant[];
  tier?: string;
  adminRole?: Role;
  keyModel?: KeyModel;
  /** Mirror the group as a NIP-29 channel on its write relays. */
  channel: boolean;
  createdAt: number;
  createdBy: string;
}

export interface Revocation {
  pubkey: string;
  bindingKey: string;
  at: number;
  reason: string;
}

export const bindingKey = (idp: string, subject: string) => `${idp}:${subject}`;
export const mappingKey = (idp: string, group: string) => `${idp}:${group.toLowerCase()}`;

const CACHE_MS = 5_000;

/** DocStore access with a short-lived pubkey cache for the hot path. */
export class IdentityStore {
  private pkCache = new Map<string, { b: Binding | null; revoked: boolean; at: number }>();
  private mappingsCache: { list: GroupMapping[]; at: number } | null = null;
  private groupsCache = new Map<string, DirectoryGroup | null>();

  constructor(private readonly kernel: Kernel) {
    kernel.ports.pubsub.subscribe(INVALIDATE_CHANNEL, () => this.clearLocal());
  }

  private get docs() {
    return this.kernel.ports.docs;
  }

  now(): number {
    return this.kernel.ports.clock.now();
  }

  clearLocal(): void {
    this.pkCache.clear();
    this.mappingsCache = null;
    this.groupsCache.clear();
  }

  /** Invalidate caches here and on every other instance of the node. */
  async invalidate(): Promise<void> {
    this.clearLocal();
    await this.kernel.ports.pubsub.publish(INVALIDATE_CHANNEL, { at: this.now() });
  }

  // ───────────── bindings ─────────────

  get(key: string): Promise<Binding | null> {
    return this.docs.get<Binding>(COL.bindings, key);
  }

  async put(b: Binding): Promise<void> {
    const key = bindingKey(b.idp, b.subject);
    const prev = await this.get(key);
    b.updatedAt = this.now();
    await this.docs.put(COL.bindings, key, b);
    // Keep aliases in sync.
    if (prev?.npub && prev.npub !== b.npub) await this.dropAlias(`pk:${prev.npub}`, key);
    if (prev?.email && prev.email.toLowerCase() !== b.email?.toLowerCase())
      await this.dropAlias(`email:${prev.email.toLowerCase()}`, key);
    if (b.npub) await this.docs.put(COL.alias, `pk:${b.npub}`, key);
    if (b.email) await this.docs.put(COL.alias, `email:${b.email.toLowerCase()}`, key);
    if (b.scimId) await this.docs.put(COL.alias, `scim:${b.scimId}`, key);
    // Entra: userName is the UPN, which is what `preferred_username` carries at login.
    if (b.userName?.includes('@') && b.userName.toLowerCase() !== b.email?.toLowerCase())
      await this.docs.put(COL.alias, `email:${b.userName.toLowerCase()}`, key);
    await this.invalidate();
  }

  async remove(key: string): Promise<void> {
    const b = await this.get(key);
    if (!b) return;
    await this.docs.delete(COL.bindings, key);
    if (b.npub) await this.dropAlias(`pk:${b.npub}`, key);
    if (b.email) await this.dropAlias(`email:${b.email.toLowerCase()}`, key);
    if (b.scimId) await this.dropAlias(`scim:${b.scimId}`, key);
    await this.invalidate();
  }

  async dropAlias(alias: string, key: string): Promise<void> {
    if ((await this.docs.get<string>(COL.alias, alias)) === key)
      await this.docs.delete(COL.alias, alias);
  }

  async setAlias(alias: string, key: string): Promise<void> {
    await this.docs.put(COL.alias, alias, key);
  }

  async byAlias(alias: string): Promise<Binding | null> {
    const key = await this.docs.get<string>(COL.alias, alias);
    return key ? this.get(key) : null;
  }

  byEmail(email: string): Promise<Binding | null> {
    return this.byAlias(`email:${email.toLowerCase()}`);
  }

  byScimId(id: string): Promise<Binding | null> {
    return this.byAlias(`scim:${id}`);
  }

  async list(): Promise<Binding[]> {
    const out: Binding[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<Binding>(COL.bindings, { cursor, limit: 500 });
      out.push(...page.items.map((i) => i.value));
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  /** Hot path: active binding for a pubkey + revocation flag, cached for a few seconds. */
  async lookupPubkey(pubkey: string): Promise<{ b: Binding | null; revoked: boolean }> {
    const nowMs = this.kernel.ports.clock.nowMs();
    const hit = this.pkCache.get(pubkey);
    if (hit && nowMs - hit.at < CACHE_MS) return hit;
    const [b, rev] = await Promise.all([
      this.byAlias(`pk:${pubkey}`),
      this.docs.get<Revocation>(COL.revoked, pubkey),
    ]);
    const entry = { b: b && b.npub === pubkey ? b : null, revoked: !!rev, at: nowMs };
    this.pkCache.set(pubkey, entry);
    if (this.pkCache.size > 50_000) {
      const first = this.pkCache.keys().next().value;
      if (first !== undefined) this.pkCache.delete(first);
    }
    return entry;
  }

  // ───────────── revocations ─────────────

  async revoke(r: Revocation): Promise<void> {
    await this.docs.put(COL.revoked, r.pubkey, r);
    await this.invalidate();
    await this.kernel.ports.pubsub.publish(REVOKED_CHANNEL, { pubkey: r.pubkey, reason: r.reason });
  }

  async unrevoke(pubkey: string): Promise<void> {
    if (await this.docs.delete(COL.revoked, pubkey)) await this.invalidate();
  }

  isRevoked(pubkey: string): Promise<boolean> {
    return this.docs.get(COL.revoked, pubkey).then((r) => r !== null);
  }

  // ───────────── directory groups ─────────────

  async getGroup(idp: string, id: string): Promise<DirectoryGroup | null> {
    const key = `${idp}:${id}`;
    if (this.groupsCache.has(key)) return this.groupsCache.get(key) ?? null;
    const g = await this.docs.get<DirectoryGroup>(COL.groups, key);
    this.groupsCache.set(key, g);
    return g;
  }

  async putGroup(g: DirectoryGroup): Promise<void> {
    g.updatedAt = this.now();
    await this.docs.put(COL.groups, `${g.idp}:${g.id}`, g);
    await this.invalidate();
  }

  async removeGroup(idp: string, id: string): Promise<void> {
    await this.docs.delete(COL.groups, `${idp}:${id}`);
    await this.invalidate();
  }

  async listGroups(idp?: string): Promise<DirectoryGroup[]> {
    const out: DirectoryGroup[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<DirectoryGroup>(COL.groups, {
        cursor,
        limit: 500,
        ...(idp ? { prefix: `${idp}:` } : {}),
      });
      out.push(...page.items.map((i) => i.value));
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  // ───────────── mappings ─────────────

  async mappings(): Promise<GroupMapping[]> {
    const nowMs = this.kernel.ports.clock.nowMs();
    if (this.mappingsCache && nowMs - this.mappingsCache.at < CACHE_MS)
      return this.mappingsCache.list;
    const page = await this.docs.list<GroupMapping>(COL.mappings, { limit: 1000 });
    const list = page.items.map((i) => i.value);
    this.mappingsCache = { list, at: nowMs };
    return list;
  }

  async putMapping(m: GroupMapping): Promise<void> {
    await this.docs.put(COL.mappings, mappingKey(m.idp, m.group), m);
    await this.invalidate();
  }

  async getMapping(idp: string, group: string): Promise<GroupMapping | null> {
    return this.docs.get<GroupMapping>(COL.mappings, mappingKey(idp, group));
  }

  async removeMapping(idp: string, group: string): Promise<boolean> {
    const ok = await this.docs.delete(COL.mappings, mappingKey(idp, group));
    await this.invalidate();
    return ok;
  }
}
