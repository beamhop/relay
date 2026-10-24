import type { AdminApiDeps, AdminRole, BanRequest, UserRecord, UserStatus, UserView } from "@beamhop/sdk";
import { forbidden } from "../errors";
import type { ProfileService } from "./profiles";
import { ROLE_RANK, type RoleService } from "./roles";

export interface Actor {
  pubkey: string;
  role: AdminRole | null;
}

const STAFF_PAGE = 1000;
/** up to this many authors are rank-checked one by one; more load the staff set once */
const FEW_AUTHORS = 20;

/** Record fields that grant capabilities (limits, access): only an owner may change them on themselves. */
const PRIVILEGED_FIELDS = ["rateLimit", "blossomQuota", "allowed", "denied", "role", "status"] as const;

function defaultUser(pubkey: string): UserRecord {
  return {
    pubkey,
    status: "active",
    allowed: false,
    denied: false,
    role: null,
    notes: "",
    tags: [],
    rateLimit: null,
    blossomQuota: null,
    nip05Name: null,
    invitedBy: null,
    banReason: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    eventCount: 0,
  };
}

export class UserService {
  constructor(
    private readonly deps: AdminApiDeps,
    private readonly roles: RoleService,
    private readonly profiles: ProfileService,
  ) {}

  async getOrDefault(pubkey: string): Promise<UserRecord> {
    return (await this.deps.stores.users.get(pubkey)) ?? defaultUser(pubkey);
  }

  async toViews(records: UserRecord[]): Promise<UserView[]> {
    const profiles = await this.profiles.getMany(records.map((r) => r.pubkey));
    return records.map((r) => ({ ...r, role: this.roles.effective(r.pubkey, r.role), profile: profiles.get(r.pubkey) }));
  }

  async toView(record: UserRecord): Promise<UserView> {
    return (await this.toViews([record]))[0];
  }

  /**
   * Editing user records (notes, tags, allow-list…): users ranked below you, or your own record —
   * except fields that would raise your own limits or access (`patch`), which only owners may self-edit.
   */
  async assertCanEdit(actor: Actor, target: string, patch: Partial<UserRecord> = {}): Promise<void> {
    if (target !== actor.pubkey) return this.assertCanModerate(actor, target);
    if (actor.role !== "owner" && PRIVILEGED_FIELDS.some((f) => patch[f] !== undefined)) {
      throw forbidden("cannot change your own limits or access");
    }
  }

  /** Throws 403 if the actor may not moderate (ban/mute/delete — and lift those) the target. */
  async assertCanModerate(actor: Actor, target: string): Promise<void> {
    if (target === actor.pubkey) throw forbidden("cannot moderate yourself");
    if (this.roles.isConfigOwner(target)) throw forbidden("cannot moderate a configured owner");
    const targetRole = (await this.deps.stores.users.get(target))?.role ?? null;
    if (targetRole && (!actor.role || ROLE_RANK[targetRole] >= ROLE_RANK[actor.role])) {
      throw forbidden(`cannot moderate a user with role ${targetRole}`);
    }
  }

  /**
   * Pubkeys whose events `actor` may not delete, with their role: configured owners and stored staff ranked at
   * or above the actor (never the actor itself). One query per role instead of a lookup per author.
   */
  async protectedAuthors(actor: Actor): Promise<ReadonlyMap<string, AdminRole>> {
    const out = new Map<string, AdminRole>();
    if (actor.role === "owner") return out;
    const rank = actor.role ? ROLE_RANK[actor.role] : 0;
    for (const role of Object.keys(ROLE_RANK) as AdminRole[]) {
      if (ROLE_RANK[role] < rank) continue;
      for (let offset = 0; ; offset += STAFF_PAGE) {
        const { items, total } = await this.deps.stores.users.list({ role, limit: STAFF_PAGE, offset });
        for (const u of items) out.set(u.pubkey, role);
        if (items.length < STAFF_PAGE || offset + items.length >= total) break;
      }
    }
    for (const pk of this.roles.owners) out.set(pk, "owner");
    out.delete(actor.pubkey);
    return out;
  }

  /**
   * Deleting events follows the moderation ranks: below owner you may delete your own events and those of
   * non-staff or lower-ranked staff, never those of your peers or superiors. Pass `protectedSet` (from
   * protectedAuthors) when checking many authors; a handful are resolved one by one.
   */
  async assertCanDeleteEventsOf(actor: Actor, authors: Iterable<string>, protectedSet?: ReadonlyMap<string, AdminRole>): Promise<void> {
    if (actor.role === "owner") return;
    const unique = [...new Set(authors)].filter((pk) => pk !== actor.pubkey);
    if (!unique.length) return;
    const rank = actor.role ? ROLE_RANK[actor.role] : 0;
    const prot = protectedSet ?? (unique.length > FEW_AUTHORS ? await this.protectedAuthors(actor) : undefined);
    for (const pk of unique) {
      const role = prot ? (prot.get(pk) ?? null) : await this.roles.rankRole(pk);
      if (role && ROLE_RANK[role] >= rank) throw forbidden(`cannot delete events of a user with role ${role}`, "forbidden_target");
    }
  }

  async update(pubkey: string, patch: Partial<Omit<UserRecord, "pubkey">>, actor: string): Promise<UserRecord> {
    const user = await this.deps.stores.users.upsert(pubkey, patch);
    this.deps.bus.emit("user.updated", { pubkey, user, actor });
    return user;
  }

  async setStatus(pubkey: string, status: UserStatus, actor: string, banReason?: string | null): Promise<UserRecord> {
    const patch: Partial<UserRecord> = { status };
    if (status === "banned") patch.banReason = banReason ?? null;
    else patch.banReason = null;
    return this.update(pubkey, patch, actor);
  }

  async ban(pubkey: string, req: BanRequest, actor: string) {
    const user = await this.setStatus(pubkey, "banned", actor, req.reason ?? null);
    let deletedEvents = 0;
    let deletedMedia = 0;
    let disconnected = 0;
    if (req.deleteEvents) deletedEvents = await this.deps.stores.events.deleteByPubkey(pubkey);
    if (req.deleteMedia && this.deps.blossom) deletedMedia = await this.deps.blossom.deleteByPubkey(pubkey, actor);
    if (req.disconnect ?? true) disconnected = this.deps.relay.disconnect({ pubkey });
    return { user, deletedEvents, deletedMedia, disconnected };
  }

  /** Removes the user record and everything they stored here. Not a ban: they can connect again later. */
  async delete(pubkey: string, actor: string) {
    const disconnected = this.deps.relay.disconnect({ pubkey });
    const deletedEvents = await this.deps.stores.events.deleteByPubkey(pubkey);
    const deletedMedia = this.deps.blossom ? await this.deps.blossom.deleteByPubkey(pubkey, actor) : 0;
    await this.deps.stores.users.delete(pubkey);
    this.deps.bus.emit("user.deleted", { pubkey, actor });
    return { deletedEvents, deletedMedia, disconnected };
  }
}
