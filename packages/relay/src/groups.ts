// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NIP-29 relay-based groups.
 *
 * Group state (metadata, flags, members + roles, invite codes) is kept in the
 * DocStore (`relay.groups`, key `<relayId>/<groupId>`) and mirrored as
 * relay-signed addressable events 39000 (metadata), 39001 (admins),
 * 39002 (members) and 39003 (roles). The signing key is per virtual relay,
 * generated on first use and stored in `relay.groups.key` (an enterprise
 * keyvault can later wrap it).
 *
 * Users act on groups with moderation events 9000–9009 and join/leave requests
 * 9021/9022; admins act through the `groups.*` actions or the `relay.groups`
 * service (used by enterprise IdP sync). Posting into a group is an event with
 * an `h` tag; `previous` timeline references are accepted but not enforced.
 *
 * Flags: `private` → only members can read; `closed` → only members can post
 * and join requests need an invite code (otherwise they wait for an admin).
 */
import {
  type Filter,
  type Kernel,
  type NostrEvent,
  type RelayId,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  tagValues,
} from '@beamhop/core';
import type {
  Audience,
  FilterCheck,
  Rejection,
  RelayExtension,
  WriteContext,
} from './extensions.ts';

export const GROUPS_SERVICE = 'relay.groups';
export const GROUPS_COLLECTION = 'relay.groups';
export const GROUPS_KEY_COLLECTION = 'relay.groups.key';

export const GROUP_METADATA_KIND = 39000;
export const GROUP_ADMINS_KIND = 39001;
export const GROUP_MEMBERS_KIND = 39002;
export const GROUP_ROLES_KIND = 39003;
export const GROUP_STATE_KINDS = [
  GROUP_METADATA_KIND,
  GROUP_ADMINS_KIND,
  GROUP_MEMBERS_KIND,
  GROUP_ROLES_KIND,
] as const;

export const MOD_PUT_USER = 9000;
export const MOD_REMOVE_USER = 9001;
export const MOD_EDIT_METADATA = 9002;
export const MOD_DELETE_EVENT = 9005;
export const MOD_EDIT_STATUS = 9006;
export const MOD_CREATE_GROUP = 9007;
export const MOD_DELETE_GROUP = 9008;
export const MOD_CREATE_INVITE = 9009;
export const JOIN_REQUEST_KIND = 9021;
export const LEAVE_REQUEST_KIND = 9022;

export const GROUP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export type GroupRole = 'admin' | 'moderator';
export const GROUP_ROLES: Record<GroupRole, string> = {
  admin: 'Can change everything about the group',
  moderator: 'Can add and remove members and delete posts',
};

export interface GroupRecord {
  id: string;
  name: string;
  about?: string;
  picture?: string;
  /** Only members can read. */
  private: boolean;
  /** Only members can post; joining needs an invite code or admin approval. */
  closed: boolean;
  /** pubkey → roles (empty array = plain member). */
  members: Record<string, GroupRole[]>;
  invites: Record<string, { by: string; createdAt: number }>;
  createdAt: number;
  /** created_at of the last relay-signed state events (kept strictly increasing). */
  stamp: number;
}

export interface GroupInput {
  id?: string;
  name: string;
  about?: string;
  picture?: string;
  private?: boolean;
  closed?: boolean;
  members?: Array<{ pubkey: string; roles?: GroupRole[] }>;
}

export interface GroupMetadataPatch {
  name?: string;
  about?: string;
  picture?: string;
  private?: boolean;
  closed?: boolean;
}

export interface GroupsConfig {
  enabled: boolean;
  whoCanCreate: 'anyone' | 'owner';
}

/** What the groups service needs from the engine. */
export interface GroupsHost {
  broadcast(relayId: RelayId, event: NostrEvent): void | Promise<void>;
  groupsConfig(): GroupsConfig;
}

interface CacheEntry {
  g: GroupRecord | null;
  at: number;
}

const CACHE_MS = 5_000;
const CAS_ATTEMPTS = 8;

function isRole(r: string): r is GroupRole {
  return r === 'admin' || r === 'moderator';
}

function sameRoles(a: GroupRole[] | undefined, b: GroupRole[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((r) => b.includes(r));
}

export function groupIdOf(event: Pick<NostrEvent, 'tags'>): string | undefined {
  return tagValues(event, 'h')[0];
}

function isModerationKind(kind: number): boolean {
  return kind >= 9000 && kind <= 9020;
}

export class GroupsService {
  private cache = new Map<string, CacheEntry>();
  /** relayId → "has at least one private group" (same staleness bound as `cache`). */
  private privateFlags = new Map<RelayId, { v: boolean; at: number }>();
  private keys = new Map<RelayId, Promise<{ pubkey: string; secretKey: string }>>();

  constructor(
    private kernel: Kernel,
    private host: GroupsHost,
  ) {}

  enabled(): boolean {
    return this.host.groupsConfig().enabled;
  }

  // ───────────────────────── relay key ─────────────────────────

  /** The relay's group signing key (generated and stored on first use). */
  relayKey(relayId: RelayId): Promise<{ pubkey: string; secretKey: string }> {
    let p = this.keys.get(relayId);
    if (!p) {
      p = this.loadKey(relayId);
      this.keys.set(relayId, p);
      p.catch(() => this.keys.delete(relayId));
    }
    return p;
  }

  async relayPubkey(relayId: RelayId): Promise<string> {
    return (await this.relayKey(relayId)).pubkey;
  }

  private async loadKey(relayId: RelayId): Promise<{ pubkey: string; secretKey: string }> {
    const docs = this.kernel.ports.docs;
    type Stored = { secretKey: string; pubkey: string; createdAt: number };
    const existing = await docs.get<Stored>(GROUPS_KEY_COLLECTION, relayId);
    if (existing) return { pubkey: existing.pubkey, secretKey: existing.secretKey };
    const secretKey = generateSecretKey();
    const next: Stored = {
      secretKey,
      pubkey: getPublicKey(secretKey),
      createdAt: this.kernel.ports.clock.now(),
    };
    if (await docs.cas<Stored>(GROUPS_KEY_COLLECTION, relayId, null, next)) {
      return { pubkey: next.pubkey, secretKey };
    }
    const won = await docs.get<Stored>(GROUPS_KEY_COLLECTION, relayId);
    if (!won) throw new Error('could not create the group signing key');
    return { pubkey: won.pubkey, secretKey: won.secretKey };
  }

  // ───────────────────────── reads ─────────────────────────

  private docKey(relayId: RelayId, id: string): string {
    return `${relayId}/${id}`;
  }

  async get(relayId: RelayId, id: string): Promise<GroupRecord | null> {
    const key = this.docKey(relayId, id);
    const now = this.kernel.ports.clock.nowMs();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.g;
    const g = await this.kernel.ports.docs.get<GroupRecord>(GROUPS_COLLECTION, key);
    this.cache.set(key, { g, at: now });
    if (this.cache.size > 10_000) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    return g;
  }

  async list(relayId: RelayId): Promise<GroupRecord[]> {
    const out: GroupRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kernel.ports.docs.list<GroupRecord>(GROUPS_COLLECTION, {
        prefix: `${relayId}/`,
        limit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const it of page.items) out.push(it.value);
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  /** Relay owner (NIP-11 pubkey) or the relay's own group key. */
  async isRelayAuthority(relayId: RelayId, pubkey: string): Promise<boolean> {
    if (this.kernel.relay(relayId)?.info.pubkey === pubkey) return true;
    return (await this.relayPubkey(relayId)) === pubkey;
  }

  /** Effective role: 'owner' (relay authority), group role, 'member', or null. */
  async roleOf(
    relayId: RelayId,
    g: GroupRecord,
    pubkey: string,
  ): Promise<'owner' | GroupRole | 'member' | null> {
    if (await this.isRelayAuthority(relayId, pubkey)) return 'owner';
    const roles = g.members[pubkey];
    if (!roles) return null;
    if (roles.includes('admin')) return 'admin';
    if (roles.includes('moderator')) return 'moderator';
    return 'member';
  }

  async isMember(relayId: RelayId, id: string, pubkey: string): Promise<boolean> {
    const g = await this.get(relayId, id);
    return !!g && g.members[pubkey] !== undefined;
  }

  // ───────────────────────── writes ─────────────────────────

  /**
   * Atomically change a group (compare-and-set with retries). `fn` returns the
   * next record, `null` to delete, or `undefined` for "no change".
   */
  private async mutate(
    relayId: RelayId,
    id: string,
    fn: (cur: GroupRecord | null) => GroupRecord | null | undefined,
  ): Promise<{ before: GroupRecord | null; after: GroupRecord | null; changed: boolean }> {
    const res = await this.mutateRecord(relayId, id, fn);
    if (res.changed) this.privateFlags.delete(relayId);
    return res;
  }

  private async mutateRecord(
    relayId: RelayId,
    id: string,
    fn: (cur: GroupRecord | null) => GroupRecord | null | undefined,
  ): Promise<{ before: GroupRecord | null; after: GroupRecord | null; changed: boolean }> {
    const docs = this.kernel.ports.docs;
    const key = this.docKey(relayId, id);
    for (let i = 0; i < CAS_ATTEMPTS; i++) {
      const cur = await docs.get<GroupRecord>(GROUPS_COLLECTION, key);
      const next = fn(cur ? structuredClone(cur) : null);
      if (next === undefined) {
        this.cache.set(key, { g: cur, at: this.kernel.ports.clock.nowMs() });
        return { before: cur, after: cur, changed: false };
      }
      if (next === null) {
        if (cur) await docs.delete(GROUPS_COLLECTION, key);
        this.cache.delete(key);
        return { before: cur, after: null, changed: cur !== null };
      }
      next.stamp = Math.max(this.kernel.ports.clock.now(), (cur?.stamp ?? 0) + 1);
      if (await docs.cas<GroupRecord>(GROUPS_COLLECTION, key, cur, next)) {
        this.cache.set(key, { g: next, at: this.kernel.ports.clock.nowMs() });
        return { before: cur, after: next, changed: true };
      }
    }
    throw new Error('the group is being changed by someone else, please try again');
  }

  /** Sign and publish the relay-generated state events for a group. */
  async publish(relayId: RelayId, g: GroupRecord, kinds: Iterable<number>): Promise<void> {
    const key = await this.relayKey(relayId);
    for (const kind of new Set(kinds)) {
      const tags: string[][] = [['d', g.id]];
      switch (kind) {
        case GROUP_METADATA_KIND:
          tags.push(['name', g.name]);
          if (g.about) tags.push(['about', g.about]);
          if (g.picture) tags.push(['picture', g.picture]);
          tags.push([g.private ? 'private' : 'public']);
          tags.push([g.closed ? 'closed' : 'open']);
          break;
        case GROUP_ADMINS_KIND:
          for (const [pk, roles] of Object.entries(g.members))
            if (roles.length > 0) tags.push(['p', pk, ...roles]);
          break;
        case GROUP_MEMBERS_KIND:
          for (const pk of Object.keys(g.members)) tags.push(['p', pk]);
          break;
        case GROUP_ROLES_KIND:
          for (const [name, desc] of Object.entries(GROUP_ROLES)) tags.push(['role', name, desc]);
          break;
        default:
          continue;
      }
      const ev = finalizeEvent({ kind, created_at: g.stamp, tags, content: '' }, key.secretKey);
      const res = await this.kernel.ports.events.save(relayId, ev);
      if (res.status === 'saved') await this.host.broadcast(relayId, ev);
    }
  }

  private async removeState(relayId: RelayId, id: string): Promise<number> {
    const pk = await this.relayPubkey(relayId);
    const store = this.kernel.ports.events;
    const n1 = await store.deleteMatching(relayId, {
      kinds: [...GROUP_STATE_KINDS],
      authors: [pk],
      '#d': [id],
    });
    const n2 = await store.deleteMatching(relayId, { '#h': [id] });
    return n1 + n2;
  }

  async create(relayId: RelayId, input: GroupInput, creator?: string): Promise<GroupRecord> {
    const id = input.id ?? this.kernel.ports.crypto.randomHex(8);
    if (!GROUP_ID_RE.test(id))
      throw new Error('group id may only use letters, digits, "-" and "_" (max 64)');
    const now = this.kernel.ports.clock.now();
    const members: Record<string, GroupRole[]> = {};
    for (const m of input.members ?? []) members[m.pubkey] = [...new Set(m.roles ?? [])];
    if (creator) members[creator] = ['admin'];
    let exists = false;
    const { after } = await this.mutate(relayId, id, (cur) => {
      if (cur) {
        exists = true;
        return undefined;
      }
      const g: GroupRecord = {
        id,
        name: input.name,
        private: input.private ?? false,
        closed: input.closed ?? false,
        members,
        invites: {},
        createdAt: now,
        stamp: 0,
      };
      if (input.about) g.about = input.about;
      if (input.picture) g.picture = input.picture;
      return g;
    });
    if (exists || !after) throw new Error(`a group with id "${id}" already exists`);
    await this.publish(relayId, after, GROUP_STATE_KINDS);
    return after;
  }

  /** Delete a group, its state events and its posts. Returns removed event count. */
  async delete(
    relayId: RelayId,
    id: string,
  ): Promise<{ group: GroupRecord | null; removed: number }> {
    const { before } = await this.mutate(relayId, id, () => null);
    if (!before) return { group: null, removed: 0 };
    const removed = await this.removeState(relayId, id);
    if (removed > 0)
      this.kernel.bus.emit('event.deleted', { relayId, ids: [], cause: 'admin', count: removed });
    return { group: before, removed };
  }

  async editMetadata(
    relayId: RelayId,
    id: string,
    patch: GroupMetadataPatch,
  ): Promise<GroupRecord> {
    const { after, changed } = await this.mutate(relayId, id, (g) => {
      if (!g) return undefined;
      let dirty = false;
      for (const k of ['name', 'about', 'picture', 'private', 'closed'] as const) {
        const v = patch[k];
        if (v === undefined || g[k] === v) continue;
        (g as unknown as Record<string, unknown>)[k] = v;
        dirty = true;
      }
      return dirty ? g : undefined;
    });
    if (!after) throw new Error(`unknown group "${id}"`);
    if (changed) await this.publish(relayId, after, [GROUP_METADATA_KIND]);
    return after;
  }

  /** Add (or update) members. `roles` undefined keeps existing roles. */
  async addMembers(
    relayId: RelayId,
    id: string,
    entries: Array<{ pubkey: string; roles?: GroupRole[] }>,
  ): Promise<GroupRecord> {
    let rolesChanged = false;
    const { after, changed } = await this.mutate(relayId, id, (g) => {
      if (!g) return undefined;
      let dirty = false;
      for (const e of entries) {
        const prev = g.members[e.pubkey];
        const next = e.roles !== undefined ? [...new Set(e.roles)] : (prev ?? []);
        if (prev !== undefined && sameRoles(prev, next)) continue;
        if (!sameRoles(prev?.length ? prev : [], next)) rolesChanged = true;
        g.members[e.pubkey] = next;
        dirty = true;
      }
      return dirty ? g : undefined;
    });
    if (!after) throw new Error(`unknown group "${id}"`);
    if (changed)
      await this.publish(
        relayId,
        after,
        rolesChanged ? [GROUP_ADMINS_KIND, GROUP_MEMBERS_KIND] : [GROUP_MEMBERS_KIND],
      );
    return after;
  }

  async removeMembers(relayId: RelayId, id: string, pubkeys: string[]): Promise<GroupRecord> {
    let hadRoles = false;
    const { after, changed } = await this.mutate(relayId, id, (g) => {
      if (!g) return undefined;
      let dirty = false;
      for (const pk of pubkeys) {
        const prev = g.members[pk];
        if (prev === undefined) continue;
        if (prev.length > 0) hadRoles = true;
        delete g.members[pk];
        dirty = true;
      }
      return dirty ? g : undefined;
    });
    if (!after) throw new Error(`unknown group "${id}"`);
    if (changed)
      await this.publish(
        relayId,
        after,
        hadRoles ? [GROUP_ADMINS_KIND, GROUP_MEMBERS_KIND] : [GROUP_MEMBERS_KIND],
      );
    return after;
  }

  async setRoles(
    relayId: RelayId,
    id: string,
    pubkey: string,
    roles: GroupRole[],
  ): Promise<GroupRecord> {
    return this.addMembers(relayId, id, [{ pubkey, roles }]);
  }

  /**
   * Replace the member set (IdP sync). Roles of members that stay are kept;
   * `admins` (when given) get the admin role.
   */
  async setMembers(
    relayId: RelayId,
    id: string,
    pubkeys: string[],
    opts: { admins?: string[] } = {},
  ): Promise<GroupRecord> {
    const want = new Set(pubkeys);
    for (const a of opts.admins ?? []) want.add(a);
    const admins = new Set(opts.admins ?? []);
    const { after, changed } = await this.mutate(relayId, id, (g) => {
      if (!g) return undefined;
      const next: Record<string, GroupRole[]> = {};
      for (const pk of want) {
        const prev = g.members[pk] ?? [];
        next[pk] = admins.has(pk) && !prev.includes('admin') ? [...prev, 'admin'] : prev;
      }
      const same =
        Object.keys(next).length === Object.keys(g.members).length &&
        Object.entries(next).every(([pk, r]) => sameRoles(g.members[pk], r));
      if (same) return undefined;
      g.members = next;
      return g;
    });
    if (!after) throw new Error(`unknown group "${id}"`);
    if (changed) await this.publish(relayId, after, [GROUP_ADMINS_KIND, GROUP_MEMBERS_KIND]);
    return after;
  }

  async createInvite(relayId: RelayId, id: string, code: string, by: string): Promise<void> {
    await this.mutate(relayId, id, (g) => {
      if (!g || g.invites[code]) return undefined;
      g.invites[code] = { by, createdAt: this.kernel.ports.clock.now() };
      return g;
    });
  }

  // ───────────────────────── engine extension ─────────────────────────

  /** Can `pubkey` (author of a moderation event of `kind`) perform it? */
  private async authorize(
    relayId: RelayId,
    g: GroupRecord,
    event: NostrEvent,
  ): Promise<Rejection | undefined> {
    const role = await this.roleOf(relayId, g, event.pubkey);
    const admin = role === 'owner' || role === 'admin';
    const mod = admin || role === 'moderator';
    const deny = (message: string): Rejection => ({ prefix: 'restricted', message });
    switch (event.kind) {
      case MOD_PUT_USER: {
        if (admin) return undefined;
        if (!mod) return deny('only group admins can add members');
        for (const t of event.tags) {
          if (t[0] !== 'p') continue;
          if (t.slice(2).some(isRole)) return deny('only group admins can give roles');
          if ((g.members[t[1] ?? ''] ?? []).length > 0)
            return deny('only group admins can change other admins');
        }
        return undefined;
      }
      case MOD_REMOVE_USER: {
        if (admin) return undefined;
        if (!mod) return deny('only group admins can remove members');
        for (const pk of tagValues(event, 'p'))
          if ((g.members[pk] ?? []).length > 0)
            return deny('only group admins can remove other admins');
        return undefined;
      }
      case MOD_DELETE_EVENT:
      case MOD_CREATE_INVITE:
        return mod ? undefined : deny('only group moderators can do this');
      case MOD_EDIT_METADATA:
      case MOD_EDIT_STATUS:
      case MOD_DELETE_GROUP:
        return admin ? undefined : deny('only group admins can do this');
      default:
        return { prefix: 'invalid', message: 'this group action is not supported' };
    }
  }

  async checkEvent(event: NostrEvent, ctx: WriteContext): Promise<Rejection | undefined> {
    if (!this.enabled()) return undefined;
    const { relayId } = ctx;
    if (event.kind >= GROUP_METADATA_KIND && event.kind <= GROUP_ROLES_KIND) {
      if (event.pubkey !== (await this.relayPubkey(relayId)))
        return { prefix: 'restricted', message: 'only this relay can publish group information' };
      return undefined;
    }
    const id = groupIdOf(event);
    const groupKind =
      isModerationKind(event.kind) ||
      event.kind === JOIN_REQUEST_KIND ||
      event.kind === LEAVE_REQUEST_KIND;
    if (id === undefined) {
      return groupKind
        ? { prefix: 'invalid', message: 'group events need an "h" tag naming the group' }
        : undefined;
    }
    if (!GROUP_ID_RE.test(id)) return { prefix: 'invalid', message: 'invalid group id' };
    const g = await this.get(relayId, id);
    if (event.kind === MOD_CREATE_GROUP) {
      if (g) return { prefix: 'duplicate', message: 'a group with this id already exists' };
      if (
        this.host.groupsConfig().whoCanCreate === 'owner' &&
        !(await this.isRelayAuthority(relayId, event.pubkey))
      )
        return { prefix: 'restricted', message: 'only the relay owner can create groups' };
      return undefined;
    }
    if (!g) return { prefix: 'invalid', message: 'this group does not exist' };
    if (event.kind === JOIN_REQUEST_KIND) {
      if (g.members[event.pubkey] !== undefined)
        return { prefix: 'duplicate', message: 'you are already a member' };
      return undefined;
    }
    if (event.kind === LEAVE_REQUEST_KIND) {
      if (g.members[event.pubkey] === undefined)
        return { prefix: 'invalid', message: 'you are not a member of this group' };
      return undefined;
    }
    if (isModerationKind(event.kind)) return this.authorize(relayId, g, event);
    if ((g.closed || g.private) && (await this.roleOf(relayId, g, event.pubkey)) === null)
      return { prefix: 'restricted', message: 'only members can post in this group' };
    return undefined;
  }

  async afterAccept(event: NostrEvent, ctx: WriteContext): Promise<void> {
    if (!this.enabled()) return;
    const id = groupIdOf(event);
    if (id === undefined) return;
    const { relayId } = ctx;
    switch (event.kind) {
      case MOD_CREATE_GROUP: {
        const input: GroupInput = { id, name: tagValues(event, 'name')[0] ?? id };
        const about = tagValues(event, 'about')[0];
        const picture = tagValues(event, 'picture')[0];
        if (about) input.about = about;
        if (picture) input.picture = picture;
        const flags = new Set(event.tags.map((t) => t[0]));
        if (flags.has('private')) input.private = true;
        if (flags.has('closed')) input.closed = true;
        await this.create(relayId, input, event.pubkey);
        return;
      }
      case MOD_PUT_USER: {
        const entries: Array<{ pubkey: string; roles?: GroupRole[] }> = [];
        for (const t of event.tags) {
          if (t[0] !== 'p' || !t[1]) continue;
          const roles = t.slice(2).filter(isRole);
          entries.push(roles.length > 0 ? { pubkey: t[1], roles } : { pubkey: t[1] });
        }
        if (entries.length > 0) await this.addMembers(relayId, id, entries);
        return;
      }
      case MOD_REMOVE_USER: {
        const pks = tagValues(event, 'p');
        if (pks.length > 0) await this.removeMembers(relayId, id, pks);
        return;
      }
      case MOD_EDIT_METADATA:
      case MOD_EDIT_STATUS: {
        const patch: GroupMetadataPatch = {};
        for (const k of ['name', 'about', 'picture'] as const) {
          const v = tagValues(event, k)[0];
          if (v !== undefined) patch[k] = v;
        }
        const flags = new Set(event.tags.map((t) => t[0]));
        if (flags.has('private')) patch.private = true;
        else if (flags.has('public')) patch.private = false;
        if (flags.has('closed')) patch.closed = true;
        else if (flags.has('open')) patch.closed = false;
        await this.editMetadata(relayId, id, patch);
        return;
      }
      case MOD_DELETE_EVENT: {
        const store = this.kernel.ports.events;
        const ids: string[] = [];
        for (const eid of tagValues(event, 'e')) {
          const target = await store.getById(relayId, eid);
          if (target && groupIdOf(target) === id) ids.push(eid);
        }
        if (ids.length === 0) return;
        await store.deleteByIds(relayId, ids, { tombstone: true });
        this.kernel.bus.emit('event.deleted', { relayId, ids, cause: 'admin' });
        return;
      }
      case MOD_DELETE_GROUP:
        await this.delete(relayId, id);
        return;
      case MOD_CREATE_INVITE:
        for (const code of tagValues(event, 'code'))
          await this.createInvite(relayId, id, code, event.pubkey);
        return;
      case JOIN_REQUEST_KIND: {
        const g = await this.get(relayId, id);
        if (!g) return;
        const code = tagValues(event, 'code')[0];
        const invited = code !== undefined && g.invites[code] !== undefined;
        // Closed groups without a valid invite: the stored request waits for an admin (9000).
        if (!g.closed || invited) await this.addMembers(relayId, id, [{ pubkey: event.pubkey }]);
        return;
      }
      case LEAVE_REQUEST_KIND:
        await this.removeMembers(relayId, id, [event.pubkey]);
        return;
    }
  }

  async audience(relayId: RelayId, event: NostrEvent): Promise<Audience> {
    if (!this.enabled()) return null;
    const id = groupIdOf(event);
    if (id === undefined || !GROUP_ID_RE.test(id)) return null;
    const g = await this.get(relayId, id);
    if (!g?.private) return null;
    const owner = this.kernel.relay(relayId)?.info.pubkey;
    const author = event.pubkey;
    return (authed) => {
      for (const pk of authed)
        if (pk === author || pk === owner || g.members[pk] !== undefined) return true;
      return false;
    };
  }

  /**
   * Does this relay have any private group? Cached like group records (a
   * change made on another node is seen within the same few seconds as REQ
   * audience checks); local changes invalidate immediately.
   */
  async hasPrivateGroups(relayId: RelayId): Promise<boolean> {
    if (!this.enabled()) return false;
    const now = this.kernel.ports.clock.nowMs();
    const hit = this.privateFlags.get(relayId);
    if (hit && now - hit.at < CACHE_MS) return hit.v;
    const v = (await this.list(relayId)).some((g) => g.private);
    this.privateFlags.set(relayId, { v, at: now });
    return v;
  }

  async checkFilters(
    relayId: RelayId,
    filters: Filter[],
    authed: ReadonlySet<string>,
  ): Promise<FilterCheck> {
    if (!this.enabled()) return { ok: true, filters };
    for (const f of filters) {
      for (const id of f['#h'] ?? []) {
        if (!GROUP_ID_RE.test(id)) continue;
        const g = await this.get(relayId, id);
        if (!g?.private) continue;
        if (authed.size === 0)
          return {
            ok: false,
            prefix: 'auth-required',
            message: 'please sign in to read this private group',
          };
        let ok = false;
        for (const pk of authed) if ((await this.roleOf(relayId, g, pk)) !== null) ok = true;
        if (!ok)
          return { ok: false, prefix: 'restricted', message: 'you are not a member of this group' };
      }
    }
    return { ok: true, filters };
  }

  extension(): RelayExtension {
    return {
      id: 'nip29',
      audience: (relayId, event) =>
        groupIdOf(event) === undefined ? null : this.audience(relayId, event),
      filters: (relayId, filters, authed) => this.checkFilters(relayId, filters, authed),
      // Any event may carry an `h` tag, so while a private group exists every
      // COUNT is answered by a per-event visibility scan.
      restrictsCount: (relayId) => this.hasPrivateGroups(relayId),
      checkEvent: (event, ctx) => this.checkEvent(event, ctx),
      afterAccept: (event, ctx) => this.afterAccept(event, ctx),
    };
  }
}
