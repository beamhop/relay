import { createHash } from "node:crypto";
import { type EventSource, type Filter, type NostrEvent, getTag, nowSec } from "@beamhop/sdk";
import type { RelayContext } from "../../context";
import { canSeeGated } from "../../subscriptions/visibility";
import { isHex64 } from "../../util/hex";
import {
  DEFAULT_ROLES,
  GROUP_CREATES_PER_HOUR,
  GROUP_ID_RE,
  GROUP_KIND,
  INVITE_ATTEMPTS_PER_MINUTE,
  isAdminRole,
  MAX_PREVIOUS_REFS,
  METADATA_KINDS,
  MIN_INVITE_CODE_LENGTH,
  PERMISSIONS,
  PREVIOUS_RECENT_LIMIT,
  PREVIOUS_RECENT_SEC,
  PREVIOUS_SCAN,
  PREVIOUS_WINDOW,
  UNTRUSTED_SOURCES,
} from "./kinds";
import { applyMetadata, relayPublish } from "./metadata";
import type { GroupRepo, GroupState } from "./repo";

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
 * `pending`: the event is stored and relayed like any other, but answered OK false with this reason (a
 * closed group's join request, kept for its admins to act on).
 */
export type GroupWriteDecision =
  | { reject: string }
  | { duplicate: string }
  | { commit?: () => Promise<void>; after?: () => Promise<void>; pending?: string }
  | undefined;

/** What the per-kind write checks need from GroupsService (its state and the changes it serializes). */
export interface GroupHost {
  readonly ctx: RelayContext;
  readonly repo: GroupRepo;
  readonly groups: Map<string, GroupState>;
  /** see GroupsService.changed */
  changed(): void;
  /** see GroupsService.membersChanged */
  membersChanged(g: GroupState): void;
  canRead(event: NostrEvent, authed: ReadonlySet<string>): boolean;
  publishMetadata(g: GroupState, kinds: readonly number[]): Promise<void>;
  deleteGroup(g: GroupState, actor: string): Promise<void>;
}

export class GroupConflict extends Error {}

/** Thrown by commit when the control event's state change was already applied (a replay). */
export class GroupDuplicate extends Error {}

export const NOT_FOUND = "invalid: group not found";

const hasSubgroupTags = (tags: string[][]) => tags.some((t) => t[0] === "parent" || t[0] === "child");

export const hashCode = (code: string) => `sha256:${createHash("sha256").update(code).digest("hex")}`;

/**
 * NIP-29 timeline references: every `previous` id prefix must match an event this relay has that the author may
 * read — one of the group's recent events or anything stored recently. Candidates are listed by id only (no event
 * bodies); just the matches are loaded, for the visibility check.
 */
export async function checkPrevious(host: GroupHost, event: NostrEvent, g: GroupState): Promise<GroupWriteDecision> {
  const prev = [...new Set(event.tags.filter((t) => t[0] === "previous").flatMap((t) => t.slice(1)).filter(Boolean))];
  if (!prev.length) return undefined;
  if (prev.length > MAX_PREVIOUS_REFS) return { reject: `invalid: too many previous references (max ${MAX_PREVIOUS_REFS})` };
  if (prev.some((p) => !/^[0-9a-f]{8,64}$/.test(p))) return { reject: "invalid: malformed previous tag" };
  const notFound = { reject: "invalid: previous tag references an event not found on this relay" };
  const ids = [
    ...(await newestIds(host.ctx, { "#h": [g.id] }, PREVIOUS_WINDOW, 0)),
    ...(await newestIds(host.ctx, {}, PREVIOUS_RECENT_LIMIT, nowSec() - PREVIOUS_RECENT_SEC)),
  ];
  const matches = new Map<string, string[]>();
  for (const p of prev) {
    const hits = [...new Set(ids.filter((id) => id.startsWith(p)))];
    if (!hits.length) return notFound;
    matches.set(p, hits);
  }
  const wanted = [...new Set([...matches.values()].flat())];
  const events = await host.ctx.stores.events.query([{ ids: wanted }], { maxLimit: wanted.length });
  const authed: ReadonlySet<string> = new Set([event.pubkey]);
  const reader = { id: "", ip: "", authedPubkeys: authed, connectedAt: 0 };
  const readable = new Set(
    events
      .filter((ev) => canSeeGated(ev, authed) && host.canRead(ev, authed) && host.ctx.hooks.isVisible(ev, { conn: reader, source: "ws" }))
      .map((ev) => ev.id),
  );
  for (const hits of matches.values()) if (!hits.some((id) => readable.has(id))) return notFound;
  return undefined;
}

/**
 * Ids of at least the `want` newest events matching `filter` (fewer if the store has fewer) created at or after
 * `floor`. The store lists ids oldest first, so time windows are walked backwards from now, each listed whole
 * (narrowed when one holds more than PREVIOUS_SCAN ids).
 */
async function newestIds(ctx: RelayContext, filter: Filter, want: number, floor: number): Promise<string[]> {
  const out: string[] = [];
  let upper: number | undefined; // inclusive; none at first, so events dated slightly in the future count too
  let span = 600;
  for (let round = 0; round < 16 && out.length < want; round++) {
    const top = upper ?? nowSec();
    if (top < floor) break;
    const since = Math.max(floor, top - span);
    const rows = await ctx.stores.events.queryIdsForSync({ ...filter, since, ...(upper !== undefined ? { until: upper } : {}), limit: PREVIOUS_SCAN + 1 });
    if (rows.length > PREVIOUS_SCAN && span > 1) {
      span = Math.max(1, Math.floor(span / 16));
      continue;
    }
    for (const r of rows) out.push(r.id);
    if (since <= floor) break;
    upper = since - 1;
    span *= 8;
  }
  return out;
}

// ------------------------------------------------------------ handlers

export function onCreate(host: GroupHost, event: NostrEvent, id: string, existing: GroupState | undefined, actor: GroupActor): GroupWriteDecision {
  if (existing) return { reject: "duplicate: group already exists" };
  if (!GROUP_ID_RE.test(id)) return { reject: "invalid: group id must match [a-zA-Z0-9_-]{1,64}" };
  const s = host.ctx.s();
  const creation = s.groups.creation;
  const allowed =
    actor.isStaff ||
    creation === "anyone" ||
    (creation === "members" && (actor.isRelayMember || s.access.mode === "public"));
  if (!allowed) return { reject: "restricted: you are not allowed to create groups on this relay" };
  if (hasSubgroupTags(event.tags)) return { reject: "invalid: subgroups are not supported" };
  if (!actor.isStaff && UNTRUSTED_SOURCES.has(actor.source) && !takeCreateToken(host.ctx, event.pubkey, actor.ipKey)) {
    return { reject: "rate-limited: too many groups created, try again later" };
  }
  const g: GroupState = {
    id,
    name: id,
    about: "",
    picture: "",
    banner: "",
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
  applyMetadata(g, event.tags);
  return {
    commit: async () => {
      if (host.groups.has(id)) throw new GroupConflict("duplicate: group already exists");
      // all rows or none, so a retry of a failed create isn't refused as "already exists"
      await host.repo.tx(async (r) => {
        await r.saveGroup(g);
        await r.saveRoles(g);
        await r.putMember(id, event.pubkey, ["admin"], event.created_at);
      });
      host.groups.set(id, g);
      if (g.private || g.hidden) host.changed();
    },
    after: () => host.publishMetadata(g, METADATA_KINDS),
  };
}

/** Per-pubkey and per-address group creation buckets (GROUP_CREATES_PER_HOUR, a full hour's worth as burst). */
function takeCreateToken(ctx: RelayContext, pubkey: string, ipKey: string | undefined): boolean {
  const L = GROUP_CREATES_PER_HOUR;
  const pkKey = `grp:create:${pubkey}`;
  if (!ctx.rate.take(pkKey, L.pubkey / 60, 1, L.pubkey)) return false;
  if (ipKey && !ctx.rate.take(`grp:create-ip:${ipKey}`, L.ip / 60, 1, L.ip)) {
    ctx.rate.refund(pkKey, L.pubkey / 60, 1, L.pubkey);
    return false;
  }
  return true;
}

export async function onJoin(host: GroupHost, event: NostrEvent, g: GroupState, actor: GroupActor): Promise<GroupWriteDecision> {
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
    if (!host.ctx.rate.take(groupKey, L.group, 0) || (ipKey && !host.ctx.rate.take(ipKey, L.ip, 0))) {
      return { reject: g.hidden ? NOT_FOUND : "rate-limited: too many invite code attempts, try again later" };
    }
    const h = hashCode(code);
    if (g.invites.has(h)) hash = h;
    else {
      // a wrong code counts against the guessing limits; the request is then handled like one without a code
      host.ctx.rate.charge(groupKey, L.group, 1);
      if (ipKey) host.ctx.rate.charge(ipKey, L.ip, 1);
    }
  } else if (code && g.invites.has(hashCode(code))) {
    hash = hashCode(code); // open groups need no code: a valid one is used up, an unknown one is ignored
  }
  if (g.closed && !hash) {
    if (g.hidden) return { reject: NOT_FOUND };
    // NIP-29: MUST reject when the user isn't added; the request is still stored and relayed (by the write
    // pipeline, like any event) for admins to act on.
    return { pending: "restricted: join request pending admin approval" };
  }
  return {
    commit: async () => {
      if (g.members.has(event.pubkey)) throw new GroupConflict("duplicate: already a member of this group");
      // a closed group needs the code; an open group just doesn't consume one that a concurrent join used
      const useCode = hash !== undefined && g.invites.has(hash);
      if (hash && !useCode && g.closed) throw new GroupConflict("restricted: invite code was already used");
      await host.repo.tx(async (r) => {
        if (useCode) await r.removeInvite(g.id, hash!);
        await r.putMember(g.id, event.pubkey, [], nowSec());
      });
      if (useCode) g.invites.delete(hash!);
      g.members.set(event.pubkey, []);
      host.membersChanged(g);
    },
    after: async () => {
      await relayPublish(host.ctx, { kind: GROUP_KIND.PUT_USER, created_at: nowSec(), content: "", tags: [["h", g.id], ["p", event.pubkey]] });
      await host.publishMetadata(g, [GROUP_KIND.MEMBERS]);
    },
  };
}

export function onLeave(host: GroupHost, event: NostrEvent, g: GroupState): GroupWriteDecision {
  const roles = g.members.get(event.pubkey);
  if (!roles) return { reject: g.hidden ? NOT_FOUND : "invalid: not a member of this group" };
  return {
    commit: async () => {
      await host.repo.removeMember(g.id, event.pubkey);
      g.members.delete(event.pubkey);
      host.membersChanged(g);
    },
    after: async () => {
      await relayPublish(host.ctx, { kind: GROUP_KIND.REMOVE_USER, created_at: nowSec(), content: "", tags: [["h", g.id], ["p", event.pubkey]] });
      await host.publishMetadata(g, roles.length ? [GROUP_KIND.ADMINS, GROUP_KIND.MEMBERS] : [GROUP_KIND.MEMBERS]);
    },
  };
}

export function onModeration(host: GroupHost, event: NostrEvent, g: GroupState, actor: GroupActor): GroupWriteDecision {
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
          const puts = targets.map((t) => ({ pubkey: t[1], roles: t.slice(2).filter(Boolean) }));
          await host.repo.tx(async (r) => {
            for (const p of puts) await r.putMember(g.id, p.pubkey, p.roles, event.created_at);
          });
          for (const p of puts) g.members.set(p.pubkey, p.roles);
          host.membersChanged(g);
        },
        after: () => host.publishMetadata(g, rolesChanged ? [GROUP_KIND.ADMINS, GROUP_KIND.MEMBERS] : [GROUP_KIND.MEMBERS]),
      };
    }
    case GROUP_KIND.REMOVE_USER: {
      const targets = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
      if (!targets.length) return { reject: "invalid: remove-user requires a p tag" };
      for (const pk of targets) if (isAdminRole(g.members.get(pk)) && !isAdmin) return { reject: "restricted: only group admins can remove admins" };
      return {
        commit: async () => {
          await host.repo.tx(async (r) => {
            for (const pk of targets) await r.removeMember(g.id, pk);
          });
          for (const pk of targets) g.members.delete(pk);
          host.membersChanged(g);
        },
        after: () => host.publishMetadata(g, [GROUP_KIND.ADMINS, GROUP_KIND.MEMBERS]),
      };
    }
    case GROUP_KIND.EDIT_METADATA:
      if (hasSubgroupTags(event.tags)) return { reject: "invalid: subgroups are not supported" };
      return {
        commit: async () => {
          const next: GroupState = { ...g };
          applyMetadata(next, event.tags);
          await host.repo.saveGroup(next);
          const visibility = next.private !== g.private || next.hidden !== g.hidden;
          applyMetadata(g, event.tags);
          if (visibility) host.changed();
        },
        after: () => host.publishMetadata(g, [GROUP_KIND.METADATA]),
      };
    case GROUP_KIND.DELETE_EVENT: {
      const ids = event.tags.filter((t) => t[0] === "e" && isHex64(t[1])).map((t) => t[1]);
      if (!ids.length) return { reject: "invalid: delete-event requires an e tag" };
      return {
        commit: async () => {
          const own: string[] = [];
          for (const id of ids) {
            const ev = await host.ctx.stores.events.getById(id);
            if (ev && getTag(ev, "h") === g.id) own.push(id);
          }
          if (own.length) {
            // tombstoned, so nobody can publish a removed event again
            await host.ctx.stores.events.deleteByIds(own, { tombstone: event.id });
            host.ctx.bus.emit("event.deleted", { ids: own, actor: event.pubkey, reason: `nip29 delete-event in ${g.id}` });
          }
        },
      };
    }
    case GROUP_KIND.DELETE_GROUP:
      if (!isAdmin) return { reject: "restricted: only group admins can delete the group" };
      // purges the stored events too (including this 9008, which carries the h tag)
      return { commit: () => host.deleteGroup(g, event.pubkey) };
    case GROUP_KIND.CREATE_INVITE: {
      const code = getTag(event, "code");
      if (!code || code.length > 128) return { reject: "invalid: create-invite requires a code tag" };
      if ([...code].length < MIN_INVITE_CODE_LENGTH) return { reject: `invalid: invite codes must be at least ${MIN_INVITE_CODE_LENGTH} characters` };
      const hash = hashCode(code);
      return {
        commit: async () => {
          await host.repo.addInvite(g.id, hash, event.pubkey, event.created_at);
          g.invites.add(hash);
        },
      };
    }
    default:
      return { reject: `invalid: unsupported group moderation kind ${k}` };
  }
}
