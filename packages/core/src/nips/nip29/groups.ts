import type { GroupSummary, NostrEvent } from "@beamhop/sdk";
import { nowSec } from "@beamhop/sdk";
import { Lru } from "../../util/lru";
import type { RelayContext } from "../../context";
import { GROUP_CONTROL_MAX_AGE_SEC, GROUP_KIND, LATE_PUBLICATION_SEC, METADATA_KINDS, UNREADABLE_CACHE_SIZE, UNTRUSTED_SOURCES } from "./kinds";
import { publishMetadata } from "./metadata";
import { type GroupRepo, type GroupState } from "./repo";
import { canRead, computeUnreadable, inRestrictedGroup } from "./visibility";
import {
  checkPrevious,
  GroupConflict,
  GroupDuplicate,
  type GroupActor,
  type GroupHost,
  type GroupWriteDecision,
  hashCode,
  NOT_FOUND,
  onCreate,
  onJoin,
  onLeave,
  onModeration,
} from "./write";

export { CONTROL_KINDS, GROUP_CREATES_PER_HOUR, GROUP_KIND } from "./kinds";
export { GroupConflict, GroupDuplicate, type GroupActor, type GroupWriteDecision } from "./write";

/**
 * NIP-29 relay-based groups. Group state lives in memory (needed synchronously for read visibility)
 * and is written through to core_* tables. Relay-signed 39000-39003 events are regenerated on change.
 */
export class GroupsService {
  private groups = new Map<string, GroupState>();
  /** bumped on changes that can affect unreadable(); its results are cached per revision */
  private revision = 0;
  private unreadableCache = new Lru<string, { revision: number; value: { privateIds: string[]; hiddenIds: string[] } }>(UNREADABLE_CACHE_SIZE);
  /** tail of each group's chain of state changes (they run one at a time per group) */
  private commits = new Map<string, Promise<unknown>>();
  /** this service's state and change hooks, for the per-kind write checks (./write) */
  private readonly host: GroupHost;

  constructor(private readonly ctx: RelayContext, private readonly repo: GroupRepo) {
    this.host = {
      ctx,
      repo,
      groups: this.groups,
      changed: () => this.changed(),
      membersChanged: (g) => this.membersChanged(g),
      canRead: (event, authed) => this.canRead(event, authed),
      publishMetadata: (g, kinds) => this.publishMetadata(g, kinds),
      deleteGroup: (g, actor) => this.deleteGroup(g, actor),
    };
  }

  /**
   * Invalidates cached visibility. unreadable() only looks at private, hidden and deleting groups and their
   * members: call after adding or removing such a group, changing its members, or changing those flags.
   */
  private changed(): void {
    this.revision++;
  }

  /** changed() for a member list change of `g`, if its members matter for visibility. */
  private membersChanged(g: GroupState): void {
    if (g.private || g.hidden || g.deleting) this.changed();
  }

  /**
   * Runs a group's state changes one at a time. Each persists first and changes memory only once that
   * succeeded, so the in-memory state never holds a change the database doesn't; serializing keeps both in
   * the same order.
   */
  private serialize<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.commits.get(groupId) ?? Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {});
    this.commits.set(groupId, tail);
    void tail.then(() => {
      if (this.commits.get(groupId) === tail) this.commits.delete(groupId);
    });
    return next;
  }

  async init(): Promise<void> {
    await this.repo.migrate();
    await this.repo.hashPlaintextInvites(hashCode);
    for (const g of await this.repo.loadAll()) this.groups.set(g.id, g);
    this.changed();
  }

  get size() {
    return this.groups.size;
  }

  isMember(groupId: string, pubkey: string): boolean {
    return !!this.groups.get(groupId)?.members.has(pubkey);
  }

  /**
   * Read visibility: private group content, hidden group metadata and control events only for authed
   * members; invite codes (9009) only for the group's admins/moderators and the invite's author.
   */
  canRead(event: NostrEvent, authed: ReadonlySet<string>): boolean {
    return canRead(this.groups, this.ctx.key.pubkey, event, authed);
  }

  /**
   * Groups whose content (private), metadata / control events (hidden) the authed pubkeys may not read. Runs for
   * every filter of every REQ / COUNT / NEG-OPEN, so results are cached per authed set until group state changes.
   */
  unreadable(authed: ReadonlySet<string>): { privateIds: string[]; hiddenIds: string[] } {
    const key = authed.size === 0 ? "" : [...authed].sort().join(",");
    const hit = this.unreadableCache.get(key);
    if (hit && hit.revision === this.revision) return hit.value;
    const value = this.computeUnreadable(authed);
    this.unreadableCache.set(key, { revision: this.revision, value });
    return value;
  }

  private computeUnreadable(authed: ReadonlySet<string>): { privateIds: string[]; hiddenIds: string[] } {
    return computeUnreadable(this.groups, authed);
  }

  /** Whether a filter explicitly targets a private group (used for COUNT gating). */
  isPrivateGroup(id: string): boolean {
    return !!this.groups.get(id)?.private;
  }

  /** Whether the event belongs to a group whose existence or content isn't public (private, hidden, being deleted). */
  inRestrictedGroup(event: NostrEvent): boolean {
    return inRestrictedGroup(this.groups, event);
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
      return { reject: "invalid: group control events must be recent (late publication)" };
    }
    const g = this.groups.get(h);
    // NIP-29 late publication (relay-signed events are exempt); a hidden group answers as if it didn't exist
    const late = event.pubkey !== this.ctx.key.pubkey && event.created_at < nowSec() - LATE_PUBLICATION_SEC;
    const lateReject = { reject: "invalid: group event created_at is too old (late publication)" };
    let decision: GroupWriteDecision;
    if (k === GROUP_KIND.CREATE_GROUP) {
      if (late) return lateReject;
      decision = onCreate(this.host, event, h, g, actor);
    } else if (!g || (g.deleting && !actor.isStaff)) return enabled ? { reject: NOT_FOUND } : undefined;
    else if (late) return g.hidden && !g.members.has(event.pubkey) && !actor.isStaff ? { reject: NOT_FOUND } : lateReject;
    else if (k === GROUP_KIND.JOIN_REQUEST) decision = await onJoin(this.host, event, g, actor);
    else if (k === GROUP_KIND.LEAVE_REQUEST) decision = onLeave(this.host, event, g);
    else if (k >= 9000 && k <= 9020) decision = onModeration(this.host, event, g, actor);
    else {
      // regular group content — only `restricted` limits writing to members (private limits reading, closed limits joining)
      const member = g.members.has(event.pubkey);
      if (!member && !actor.isStaff && g.hidden) return { reject: NOT_FOUND }; // don't confirm a hidden group exists
      if (g.restricted && !member && !actor.isStaff) return { reject: "restricted: not a member of this group" };
      if (g.supportedKinds && !g.supportedKinds.includes(k)) return { reject: `restricted: kind ${k} is not supported by this group` };
      return checkPrevious(this.host, event, g);
    }
    // NIP-29 timeline references apply to every group event, control events included (not to 9007: no timeline yet)
    if (k !== GROUP_KIND.CREATE_GROUP && g && !(decision && ("reject" in decision || "duplicate" in decision))) {
      const prev = await checkPrevious(this.host, event, g);
      if (prev) return prev;
    }
    // A control event changes state at most once, even if it is deleted and sent again later. The claim
    // is part of commit (which runs only after the event was stored as new) and is given back when the
    // state change fails, so a failed attempt doesn't make the event a "duplicate" forever.
    if (decision && "commit" in decision && decision.commit) {
      const apply = decision.commit;
      decision = {
        ...decision,
        commit: () => this.serialize(h, async () => {
          // deleted (or deleted and re-created) while this event was on its way
          if (k !== GROUP_KIND.CREATE_GROUP && this.groups.get(h) !== g) throw new GroupConflict(NOT_FOUND);
          if (!(await this.repo.claimApplied(event.id, event.created_at))) throw new GroupDuplicate("duplicate: group control event was already processed");
          try {
            await apply();
          } catch (err) {
            await this.repo.unclaimApplied(event.id).catch((e) => this.ctx.logger.warn("unclaiming group control event failed", { err: String(e) }));
            throw err;
          }
        }),
      };
    }
    return decision;
  }

  /** (Re)generates relay-signed metadata events 39000-39003 for a group. */
  async publishMetadata(g: GroupState, kinds: readonly number[]): Promise<void> {
    return publishMetadata(this.ctx, g, kinds);
  }

  // ------------------------------------------------------------ admin API

  /**
   * Deletes a group: hidden from everyone first, then its stored events are purged, and only then is
   * its state forgotten. If the purge fails the group stays hidden (until a retry or restart).
   */
  private async deleteGroup(g: GroupState, actor: string): Promise<void> {
    g.deleting = true;
    this.changed();
    const n = await this.ctx.stores.events.deleteByFilter([
      { "#h": [g.id] },
      { kinds: METADATA_KINDS, authors: [this.ctx.key.pubkey], "#d": [g.id] },
    ]);
    this.groups.delete(g.id);
    this.changed();
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
    if (g) await this.serialize(id, () => (this.groups.get(id) === g ? this.deleteGroup(g, actor) : Promise.resolve()));
  }
}
