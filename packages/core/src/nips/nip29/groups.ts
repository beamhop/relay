import { createHash } from "node:crypto";
import { type EventSource, type GroupSummary, type NostrEvent, getDTag, getTag, nowSec } from "@beamhop/sdk";
import { isHex64 } from "../../util/hex";
import type { RelayContext } from "../../context";
import { type GroupRepo, type GroupState } from "./repo";

export const GROUP_KIND = {
  PUT_USER: 9000,
  REMOVE_USER: 9001,
  EDIT_METADATA: 9002,
  DELETE_EVENT: 9005,
  CREATE_GROUP: 9007,
  DELETE_GROUP: 9008,
  CREATE_INVITE: 9009,
  JOIN_REQUEST: 9021,
  LEAVE_REQUEST: 9022,
  METADATA: 39000,
  ADMINS: 39001,
  MEMBERS: 39002,
  ROLES: 39003,
} as const;

const METADATA_KINDS = [GROUP_KIND.METADATA, GROUP_KIND.ADMINS, GROUP_KIND.MEMBERS, GROUP_KIND.ROLES];
/** Group control kinds (moderation, join, leave). */
export const CONTROL_KINDS: readonly number[] = Array.from({ length: 23 }, (_, i) => 9000 + i);
const GROUP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** How many recent group events `previous` tags may reference (NIP-29 suggests the last 50). */
const PREVIOUS_WINDOW = 100;
/**
 * Group control events (9000-9022) from clients, sync and plugins must be recent: NIP-29 asks relays to
 * prevent late publication, and it stops old moderation/join/leave events from being replayed after
 * state changed (younger replays are caught by the applied-control record).
 */
export const GROUP_CONTROL_MAX_AGE_SEC = 10 * 60;
/** Sources whose group control events must be recent and may not carry relay-signed group metadata. */
const UNTRUSTED_SOURCES: ReadonlySet<EventSource> = new Set(["ws", "sync", "plugin"]);
/** Invite codes are chosen by group moderators; very short ones are guessable. */
export const MIN_INVITE_CODE_LENGTH = 6;
/** Failed invite-code join attempts (closed groups), per group and per client address, per minute. */
export const INVITE_ATTEMPTS_PER_MINUTE = { group: 60, ip: 10 };

export const DEFAULT_ROLES: Record<string, string> = {
  admin: "Full control over the group",
  moderator: "Can add and remove members, create invites and delete events",
};

const ALL_MODERATION = [9000, 9001, 9002, 9005, 9007, 9008, 9009];
const PERMISSIONS: Record<string, ReadonlySet<number>> = {
  admin: new Set(ALL_MODERATION),
  moderator: new Set([9000, 9001, 9005, 9009]),
};

export interface GroupActor {
  pubkey: string;
  /** relay member (allow-listed / role) */
  isRelayMember: boolean;
  /** relay staff (owner/admin/moderator) — may manage any group */
  isStaff: boolean;
  /** where the event came from */
  source: EventSource;
  /** rate-limit key of the client address, for events from a connection */
  ipKey?: string;
}

/**
 * `commit` applies the state change; the pipeline runs it only after the event was stored as new, so
 * replays of stored or deleted events change nothing. A GroupConflict thrown by `commit` makes the
 * pipeline remove the stored event again and reject it. `after` publishes derived (relay-signed) events.
 */
export type GroupWriteDecision =
  | { reject: string }
  | { duplicate: string }
  | { commit?: () => Promise<void>; after?: () => Promise<void> }
  | undefined;

const hashCode = (code: string) => `sha256:${createHash("sha256").update(code).digest("hex")}`;

const isAdminRole = (roles: string[] | undefined) => !!roles?.includes("admin");
const canInvite = (roles: string[] | undefined) => !!roles?.some((r) => PERMISSIONS[r]?.has(GROUP_KIND.CREATE_INVITE));

/**
 * NIP-29 relay-based groups. Group state lives in memory (needed synchronously for read visibility)
 * and is written through to core_* tables. Relay-signed 39000-39003 events are regenerated on change.
 */
export class GroupsService {
  private groups = new Map<string, GroupState>();

  constructor(private readonly ctx: RelayContext, private readonly repo: GroupRepo) {}

  async init(): Promise<void> {
    await this.repo.migrate();
    await this.repo.hashPlaintextInvites(hashCode);
    for (const g of await this.repo.loadAll()) this.groups.set(g.id, g);
  }

  get size() {
    return this.groups.size;
  }

  isMember(groupId: string, pubkey: string): boolean {
    return !!this.groups.get(groupId)?.members.has(pubkey);
  }

  private anyMember(g: GroupState, authed: ReadonlySet<string>): boolean {
    for (const pk of authed) if (g.members.has(pk)) return true;
    return false;
  }

  /**
   * Read visibility: private group content, hidden group metadata and control events only for authed
   * members; invite codes (9009) only for the group's admins/moderators and the invite's author.
   */
  canRead(event: NostrEvent, authed: ReadonlySet<string>): boolean {
    if (event.kind === GROUP_KIND.CREATE_INVITE) return this.canReadInvite(event, authed);
    if (this.groups.size === 0) return true;
    if (event.kind >= GROUP_KIND.METADATA && event.kind <= GROUP_KIND.ROLES && event.pubkey === this.ctx.key.pubkey) {
      const g = this.groups.get(getDTag(event));
      if (g && (g.deleting || (g.hidden && !this.anyMember(g, authed)))) return false;
    }
    const control = event.kind >= 9000 && event.kind <= 9022;
    for (const t of event.tags) {
      if (t[0] !== "h" || t[1] === undefined) continue;
      const g = this.groups.get(t[1]);
      if (!g) continue;
      if (g.deleting) return false;
      if ((g.private || (g.hidden && control)) && !this.anyMember(g, authed)) return false;
    }
    return true;
  }

  private canReadInvite(event: NostrEvent, authed: ReadonlySet<string>): boolean {
    if (authed.has(event.pubkey)) return true;
    const g = this.groups.get(getTag(event, "h") ?? "");
    if (!g || g.deleting) return false;
    for (const pk of authed) if (canInvite(g.members.get(pk))) return true;
    return false;
  }

  /** Groups whose content (private), metadata / control events (hidden) the authed pubkeys may not read. */
  unreadable(authed: ReadonlySet<string>): { privateIds: string[]; hiddenIds: string[] } {
    const privateIds: string[] = [];
    const hiddenIds: string[] = [];
    for (const g of this.groups.values()) {
      if (g.deleting) {
        privateIds.push(g.id);
        hiddenIds.push(g.id);
        continue;
      }
      if (!g.private && !g.hidden) continue;
      if (this.anyMember(g, authed)) continue;
      if (g.private) privateIds.push(g.id);
      if (g.hidden) hiddenIds.push(g.id);
    }
    return { privateIds, hiddenIds };
  }

  /** Whether a filter explicitly targets a private group (used for COUNT gating). */
  isPrivateGroup(id: string): boolean {
    return !!this.groups.get(id)?.private;
  }

  async handleWrite(event: NostrEvent, actor: GroupActor): Promise<GroupWriteDecision> {
    const k = event.kind;
    const untrusted = UNTRUSTED_SOURCES.has(actor.source);
    if (k >= 39000 && k <= 39009) {
      if (event.pubkey !== this.ctx.key.pubkey) return { reject: "restricted: group metadata events are generated by the relay" };
      // the relay stores its own copies directly; one coming back from a client is a replay (e.g. of a deleted group's metadata)
      if (untrusted) return { reject: "restricted: group metadata events are generated by the relay" };
      return undefined;
    }
    const isGroupKind = k >= 9000 && k <= 9022;
    const hs = new Set(event.tags.filter((t) => t[0] === "h" && t[1] !== undefined).map((t) => t[1]));
    if (!isGroupKind && hs.size === 0) return undefined;
    const enabled = this.ctx.s().groups.enabled;
    if (isGroupKind && !enabled) return { reject: "restricted: groups are disabled on this relay" };
    if (hs.size === 0) return { reject: "invalid: missing group h tag" };
    // every h tag is indexed, so an event naming several groups would bypass the per-group checks below
    // (with groups disabled that only matters for groups that still exist)
    if (hs.size > 1) {
      if (!enabled && ![...hs].some((id) => this.groups.has(id))) return undefined;
      return { reject: "invalid: an event may only reference one group (h tag)" };
    }
    const h = [...hs][0];
    if (isGroupKind && untrusted && event.created_at < nowSec() - GROUP_CONTROL_MAX_AGE_SEC) {
      return { reject: "invalid: group control events must be recent (created_at is too old)" };
    }
    const g = this.groups.get(h);
    let decision: GroupWriteDecision;
    if (k === GROUP_KIND.CREATE_GROUP) decision = this.onCreate(event, h, g, actor);
    else if (!g || (g.deleting && !actor.isStaff)) return enabled ? { reject: NOT_FOUND } : undefined;
    else if (k === GROUP_KIND.JOIN_REQUEST) decision = this.onJoin(event, g, actor);
    else if (k === GROUP_KIND.LEAVE_REQUEST) decision = this.onLeave(event, g);
    else if (k >= 9000 && k <= 9020) decision = this.onModeration(event, g, actor);
    else {
      // regular group content
      const member = g.members.has(event.pubkey);
      if (!member && !actor.isStaff && g.hidden) return { reject: NOT_FOUND }; // don't confirm a hidden group exists
      if (!member && (g.private || g.closed || g.restricted) && !actor.isStaff) return { reject: "restricted: not a member of this group" };
      return this.checkPrevious(event, g);
    }
    // A control event changes state at most once, even if it is deleted and sent again later. The claim
    // is part of commit (which runs only after the event was stored as new) and is given back when the
    // state change fails, so a failed attempt doesn't make the event a "duplicate" forever.
    if (decision && "commit" in decision && decision.commit) {
      const apply = decision.commit;
      decision = {
        ...decision,
        commit: async () => {
          if (!(await this.repo.claimApplied(event.id, event.created_at))) throw new GroupDuplicate("duplicate: group control event was already processed");
          try {
            await apply();
          } catch (err) {
            await this.repo.unclaimApplied(event.id).catch((e) => this.ctx.logger.warn("unclaiming group control event failed", { err: String(e) }));
            throw err;
          }
        },
      };
    }
    return decision;
  }

  /** NIP-29 timeline references: every `previous` id prefix must match one of the group's recent events. */
  private async checkPrevious(event: NostrEvent, g: GroupState): Promise<GroupWriteDecision> {
    const prev = event.tags.filter((t) => t[0] === "previous").flatMap((t) => t.slice(1)).filter(Boolean);
    if (!prev.length) return undefined;
    if (prev.some((p) => !/^[0-9a-f]{8,64}$/.test(p))) return { reject: "invalid: malformed previous tag" };
    const recent = await this.ctx.stores.events.query([{ "#h": [g.id], limit: PREVIOUS_WINDOW }], { maxLimit: PREVIOUS_WINDOW });
    const ok = prev.every((p) => recent.some((ev) => ev.id.startsWith(p)));
    return ok ? undefined : { reject: "invalid: previous tag references an event not in this group's recent history" };
  }

  // ------------------------------------------------------------ handlers

  private onCreate(event: NostrEvent, id: string, existing: GroupState | undefined, actor: GroupActor): GroupWriteDecision {
    if (existing) return { reject: "duplicate: group already exists" };
    if (!GROUP_ID_RE.test(id)) return { reject: "invalid: group id must match [a-zA-Z0-9_-]{1,64}" };
    const s = this.ctx.s();
    const creation = s.groups.creation;
    const allowed =
      actor.isStaff ||
      creation === "anyone" ||
      (creation === "members" && (actor.isRelayMember || s.access.mode === "public"));
    if (!allowed) return { reject: "restricted: you are not allowed to create groups on this relay" };
    const g: GroupState = {
      id,
      name: getTag(event, "name") ?? id,
      about: getTag(event, "about") ?? "",
      picture: getTag(event, "picture") ?? "",
      private: false,
      closed: false,
      restricted: false,
      hidden: false,
      createdAt: event.created_at,
      createdBy: event.pubkey,
      members: new Map([[event.pubkey, ["admin"]]]),
      roles: new Map(Object.entries(DEFAULT_ROLES)),
      invites: new Set(),
      lastMetaAt: 0,
    };
    applyFlags(g, event.tags);
    return {
      commit: async () => {
        if (this.groups.has(id)) throw new GroupConflict("duplicate: group already exists");
        this.groups.set(id, g);
        try {
          await this.repo.saveGroup(g);
          await this.repo.saveRoles(g);
          await this.repo.putMember(id, event.pubkey, ["admin"], event.created_at);
        } catch (err) {
          // undo, so a retry of the same create isn't refused as "already exists"
          if (this.groups.get(id) === g) this.groups.delete(id);
          await this.repo.deleteGroup(id).catch(() => {});
          throw err;
        }
      },
      after: () => this.publishMetadata(g, METADATA_KINDS),
    };
  }

  private onJoin(event: NostrEvent, g: GroupState, actor: GroupActor): GroupWriteDecision {
    if (g.members.has(event.pubkey)) return { reject: "duplicate: already a member of this group" };
    const code = getTag(event, "code");
    let hash: string | undefined;
    if (code && g.closed) {
      // Codes could be brute-forced otherwise. Only failed attempts count (charged after checking), so
      // invitees aren't locked out by valid joins; while the group or the address is over its limit,
      // no code is checked at all.
      const L = INVITE_ATTEMPTS_PER_MINUTE;
      const groupKey = `grp:code:${g.id}`;
      const ipKey = actor.ipKey ? `grp:code-ip:${actor.ipKey}` : undefined;
      if (!this.ctx.rate.take(groupKey, L.group, 0) || (ipKey && !this.ctx.rate.take(ipKey, L.ip, 0))) {
        return { reject: g.hidden ? NOT_FOUND : "rate-limited: too many invite code attempts, try again later" };
      }
      const h = hashCode(code);
      if (!g.invites.has(h)) {
        this.ctx.rate.charge(groupKey, L.group, 1);
        if (ipKey) this.ctx.rate.charge(ipKey, L.ip, 1);
        return { reject: g.hidden ? NOT_FOUND : "restricted: invalid invite code" };
      }
      hash = h;
    } else if (code && g.invites.has(hashCode(code))) {
      hash = hashCode(code); // open groups need no code: a valid one is used up, an unknown one is ignored
    }
    if (g.closed && !hash) {
      if (g.hidden) return { reject: NOT_FOUND };
      return {}; // stored as a pending join request for admins to act on
    }
    return {
      commit: async () => {
        if (g.members.has(event.pubkey)) throw new GroupConflict("duplicate: already a member of this group");
        // a closed group needs the code; an open group just doesn't consume one that a concurrent join used
        const useCode = hash !== undefined && g.invites.has(hash);
        if (hash && !useCode && g.closed) throw new GroupConflict("restricted: invite code was already used");
        if (useCode) g.invites.delete(hash!);
        g.members.set(event.pubkey, []);
        try {
          if (useCode) await this.repo.removeInvite(g.id, hash!);
          await this.repo.putMember(g.id, event.pubkey, [], nowSec());
        } catch (err) {
          // undo the in-memory change so a retry can apply it
          if (useCode) g.invites.add(hash!);
          g.members.delete(event.pubkey);
          throw err;
        }
      },
      after: async () => {
        await this.relayPublish({ kind: GROUP_KIND.PUT_USER, created_at: nowSec(), content: "", tags: [["h", g.id], ["p", event.pubkey]] });
        await this.publishMetadata(g, [GROUP_KIND.MEMBERS]);
      },
    };
  }

  private onLeave(event: NostrEvent, g: GroupState): GroupWriteDecision {
    const roles = g.members.get(event.pubkey);
    if (!roles) return { reject: g.hidden ? NOT_FOUND : "invalid: not a member of this group" };
    return {
      commit: async () => {
        g.members.delete(event.pubkey);
        await this.repo.removeMember(g.id, event.pubkey);
      },
      after: async () => {
        await this.relayPublish({ kind: GROUP_KIND.REMOVE_USER, created_at: nowSec(), content: "", tags: [["h", g.id], ["p", event.pubkey]] });
        await this.publishMetadata(g, roles.length ? [GROUP_KIND.ADMINS, GROUP_KIND.MEMBERS] : [GROUP_KIND.MEMBERS]);
      },
    };
  }

  private onModeration(event: NostrEvent, g: GroupState, actor: GroupActor): GroupWriteDecision {
    const k = event.kind;
    const myRoles = g.members.get(event.pubkey) ?? [];
    const isAdmin = actor.isStaff || isAdminRole(myRoles);
    if (!actor.isStaff && g.hidden && !g.members.has(event.pubkey)) return { reject: NOT_FOUND };
    if (!actor.isStaff && !myRoles.some((r) => PERMISSIONS[r]?.has(k))) return { reject: "restricted: insufficient group permissions" };

    switch (k) {
      case GROUP_KIND.PUT_USER: {
        const targets = event.tags.filter((t) => t[0] === "p");
        if (!targets.length) return { reject: "invalid: put-user requires a p tag" };
        for (const t of targets) {
          if (!isHex64(t[1])) return { reject: "invalid: bad pubkey in p tag" };
          const roles = t.slice(2).filter(Boolean);
          if (!isAdmin && (roles.length || (g.members.get(t[1])?.length ?? 0) > 0)) return { reject: "restricted: only group admins can assign roles" };
          for (const r of roles) if (!g.roles.has(r)) return { reject: `invalid: unknown role "${r}"` };
        }
        const rolesChanged = targets.some((t) => t.length > 2 || (g.members.get(t[1])?.length ?? 0) > 0);
        return {
          commit: async () => {
            for (const t of targets) {
              const roles = t.slice(2).filter(Boolean);
              g.members.set(t[1], roles);
              await this.repo.putMember(g.id, t[1], roles, event.created_at);
            }
          },
          after: () => this.publishMetadata(g, rolesChanged ? [GROUP_KIND.ADMINS, GROUP_KIND.MEMBERS] : [GROUP_KIND.MEMBERS]),
        };
      }
      case GROUP_KIND.REMOVE_USER: {
        const targets = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
        if (!targets.length) return { reject: "invalid: remove-user requires a p tag" };
        for (const pk of targets) if (isAdminRole(g.members.get(pk)) && !isAdmin) return { reject: "restricted: only group admins can remove admins" };
        return {
          commit: async () => {
            for (const pk of targets) {
              g.members.delete(pk);
              await this.repo.removeMember(g.id, pk);
            }
          },
          after: () => this.publishMetadata(g, [GROUP_KIND.ADMINS, GROUP_KIND.MEMBERS]),
        };
      }
      case GROUP_KIND.EDIT_METADATA:
        return {
          commit: async () => {
            for (const t of event.tags) {
              if (t[0] === "name" && t[1] !== undefined) g.name = t[1];
              else if (t[0] === "about" && t[1] !== undefined) g.about = t[1];
              else if (t[0] === "picture" && t[1] !== undefined) g.picture = t[1];
            }
            applyFlags(g, event.tags);
            await this.repo.saveGroup(g);
          },
          after: () => this.publishMetadata(g, [GROUP_KIND.METADATA]),
        };
      case GROUP_KIND.DELETE_EVENT: {
        const ids = event.tags.filter((t) => t[0] === "e" && isHex64(t[1])).map((t) => t[1]);
        if (!ids.length) return { reject: "invalid: delete-event requires an e tag" };
        return {
          commit: async () => {
            const own: string[] = [];
            for (const id of ids) {
              const ev = await this.ctx.stores.events.getById(id);
              if (ev && getTag(ev, "h") === g.id) own.push(id);
            }
            if (own.length) {
              await this.ctx.stores.events.deleteByIds(own);
              this.ctx.bus.emit("event.deleted", { ids: own, actor: event.pubkey, reason: `nip29 delete-event in ${g.id}` });
            }
          },
        };
      }
      case GROUP_KIND.DELETE_GROUP:
        if (!isAdmin) return { reject: "restricted: only group admins can delete the group" };
        // purges the stored events too (including this 9008, which carries the h tag)
        return { commit: () => this.deleteGroup(g, event.pubkey) };
      case GROUP_KIND.CREATE_INVITE: {
        const code = getTag(event, "code");
        if (!code || code.length > 128) return { reject: "invalid: create-invite requires a code tag" };
        if ([...code].length < MIN_INVITE_CODE_LENGTH) return { reject: `invalid: invite codes must be at least ${MIN_INVITE_CODE_LENGTH} characters` };
        const hash = hashCode(code);
        return {
          commit: async () => {
            g.invites.add(hash);
            await this.repo.addInvite(g.id, hash, event.pubkey, event.created_at);
          },
        };
      }
      default:
        return { reject: `invalid: unsupported group moderation kind ${k}` };
    }
  }

  // ------------------------------------------------------------ relay-signed events

  private async relayPublish(template: { kind: number; created_at: number; content: string; tags: string[][] }) {
    const event = this.ctx.key.sign(template);
    const res = await this.ctx.stores.events.save(event);
    if (res.status === "saved" || res.status === "replaced") {
      this.ctx.broadcast(event);
      this.ctx.bus.emit("event.accepted", { event, status: res.status, source: "relay" });
    }
    return event;
  }

  /** (Re)generates relay-signed metadata events 39000-39003 for a group. */
  async publishMetadata(g: GroupState, kinds: readonly number[]): Promise<void> {
    if (g.lastMetaAt === 0) {
      // not persisted: recover from the newest stored metadata so new events don't come out "stale" after a restart
      const [latest] = await this.ctx.stores.events.query([{ kinds: METADATA_KINDS, authors: [this.ctx.key.pubkey], "#d": [g.id], limit: 1 }]);
      if (latest) g.lastMetaAt = Math.max(g.lastMetaAt, latest.created_at);
    }
    const created_at = Math.max(nowSec(), g.lastMetaAt + 1);
    g.lastMetaAt = created_at;
    for (const kind of kinds) {
      const tags: string[][] = [["d", g.id]];
      let content = "";
      if (kind === GROUP_KIND.METADATA) {
        tags.push(["name", g.name]);
        if (g.about) tags.push(["about", g.about]);
        if (g.picture) tags.push(["picture", g.picture]);
        tags.push([g.private ? "private" : "public"], [g.closed ? "closed" : "open"]);
        if (g.restricted) tags.push(["restricted"]);
        if (g.hidden) tags.push(["hidden"]);
      } else if (kind === GROUP_KIND.ADMINS) {
        content = `admins of ${g.id}`;
        for (const [pk, roles] of g.members) if (roles.length) tags.push(["p", pk, ...roles]);
      } else if (kind === GROUP_KIND.MEMBERS) {
        content = `members of ${g.id}`;
        for (const pk of g.members.keys()) tags.push(["p", pk]);
      } else if (kind === GROUP_KIND.ROLES) {
        content = `roles of ${g.id}`;
        for (const [name, desc] of g.roles) tags.push(["role", name, desc]);
      }
      await this.relayPublish({ kind, created_at, content, tags });
    }
  }

  // ------------------------------------------------------------ admin API

  /**
   * Deletes a group: hidden from everyone first, then its stored events are purged, and only then is
   * its state forgotten. If the purge fails the group stays hidden (until a retry or restart).
   */
  private async deleteGroup(g: GroupState, actor: string): Promise<void> {
    g.deleting = true;
    const n = await this.ctx.stores.events.deleteByFilter([
      { "#h": [g.id] },
      { kinds: METADATA_KINDS, authors: [this.ctx.key.pubkey], "#d": [g.id] },
    ]);
    this.groups.delete(g.id);
    await this.repo.deleteGroup(g.id);
    this.ctx.logger.info("group deleted", { id: g.id, actor, events: n });
  }

  private summary(g: GroupState): GroupSummary {
    return {
      id: g.id,
      name: g.name,
      about: g.about,
      picture: g.picture,
      private: g.private,
      closed: g.closed,
      members: g.members.size,
      admins: [...g.members].filter(([, r]) => r.length > 0).map(([pk]) => pk),
      createdAt: g.createdAt,
    };
  }

  list(): GroupSummary[] {
    return [...this.groups.values()].map((g) => this.summary(g)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string) {
    const g = this.groups.get(id);
    if (!g) return undefined;
    return { ...this.summary(g), memberList: [...g.members].map(([pubkey, roles]) => ({ pubkey, roles })) };
  }

  async delete(id: string, actor: string): Promise<void> {
    const g = this.groups.get(id);
    if (g) await this.deleteGroup(g, actor);
  }
}

export class GroupConflict extends Error {}

/** Thrown by commit when the control event's state change was already applied (a replay). */
export class GroupDuplicate extends Error {}

const NOT_FOUND = "invalid: group not found";

function applyFlags(g: GroupState, tags: string[][]) {
  for (const t of tags) {
    switch (t[0]) {
      case "private": g.private = true; break;
      case "public": g.private = false; break;
      case "closed": g.closed = true; break;
      case "open": g.closed = false; break;
      case "restricted": g.restricted = true; break;
      case "unrestricted": g.restricted = false; break;
      case "hidden": g.hidden = true; break;
      case "visible": g.hidden = false; break;
    }
  }
}
