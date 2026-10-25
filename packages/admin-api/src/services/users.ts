import type { AdminApiDeps, AdminRole, BlobRecord, UserRecord, UserStatus, UserView } from "@beamhop/sdk";
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
    if (actor.role === "owner") return new Map();
    const out = await this.staffFrom(actor.role ? ROLE_RANK[actor.role] : 0);
    for (const pk of this.roles.owners) out.set(pk, "owner");
    out.delete(actor.pubkey);
    return out;
  }

  /** Stored staff (any status) whose role ranks at least `rank`, with their role: one paged query per role. */
  private async staffFrom(rank: number): Promise<Map<string, AdminRole>> {
    const out = new Map<string, AdminRole>();
    for (const role of Object.keys(ROLE_RANK) as AdminRole[]) {
      if (ROLE_RANK[role] < rank) continue;
      for (let offset = 0; ; offset += STAFF_PAGE) {
        const { items, total } = await this.deps.stores.users.list({ role, limit: STAFF_PAGE, offset });
        for (const u of items) out.set(u.pubkey, role);
        if (items.length < STAFF_PAGE || offset + items.length >= total) break;
      }
    }
    return out;
  }

  /**
   * assertCanModerate for many targets (bulk actions): the staff the actor can't moderate are loaded once, then each
   * target is checked without a lookup. Same verdicts, as of when it was built.
   */
  async moderationCheck(actor: Actor): Promise<(target: string) => void> {
    const above = await this.staffFrom(actor.role ? ROLE_RANK[actor.role] : 0);
    return (target) => {
      if (target === actor.pubkey) throw forbidden("cannot moderate yourself");
      if (this.roles.isConfigOwner(target)) throw forbidden("cannot moderate a configured owner");
      const role = above.get(target);
      if (role) throw forbidden(`cannot moderate a user with role ${role}`);
    };
  }

  /**
   * Deleting events follows the moderation ranks: below owner you may delete your own events and those of
   * non-staff or lower-ranked staff, never those of your peers or superiors. Pass `protectedSet` (from
   * protectedAuthors) when checking many authors; a handful are resolved one by one.
   */
  assertCanDeleteEventsOf(actor: Actor, authors: Iterable<string>, protectedSet?: ReadonlyMap<string, AdminRole>): Promise<void> {
    return this.assertOutranksAuthors(actor, authors, "delete events", protectedSet);
  }

  /**
   * Deleting, blocking or hiding a blob follows the same ranks as deleting events, against every uploader: it is gone (or
   * hidden) for all of them, so one peer or superior among them is enough to refuse.
   */
  assertCanModerateBlob(actor: Actor, blob: Pick<BlobRecord, "owners">, protectedSet?: ReadonlyMap<string, AdminRole>): Promise<void> {
    return this.assertOutranksAuthors(actor, blob.owners, "moderate media", protectedSet);
  }

  /**
   * Undoing a moderation decision — approving a blob someone blocked or hid, lifting a hash block — needs at least the rank
   * of whoever made it (`by`; nothing to check when unknown or when they no longer hold a role).
   */
  async assertCanOverride(actor: Actor, by: string | null | undefined, what: string): Promise<void> {
    if (!by || by === actor.pubkey || actor.role === "owner") return;
    const role = await this.roles.rankRole(by);
    if (role && ROLE_RANK[role] > (actor.role ? ROLE_RANK[actor.role] : 0)) {
      throw forbidden(`cannot ${what}: a user with role ${role} made that decision`, "forbidden_target");
    }
  }

  private async assertOutranksAuthors(actor: Actor, authors: Iterable<string>, what: string, protectedSet?: ReadonlyMap<string, AdminRole>): Promise<void> {
    if (actor.role === "owner") return;
    const unique = [...new Set(authors)].filter((pk) => pk !== actor.pubkey);
    if (!unique.length) return;
    const rank = actor.role ? ROLE_RANK[actor.role] : 0;
    const prot = protectedSet ?? (unique.length > FEW_AUTHORS ? await this.protectedAuthors(actor) : undefined);
    for (const pk of unique) {
      const role = prot ? (prot.get(pk) ?? null) : await this.roles.rankRole(pk);
      if (role && ROLE_RANK[role] >= rank) throw forbidden(`cannot ${what} of a user with role ${role}`, "forbidden_target");
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
}
