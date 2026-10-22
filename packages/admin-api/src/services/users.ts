import type { AdminApiDeps, AdminRole, BanRequest, UserRecord, UserStatus, UserView } from "@beamhop/sdk";
import { forbidden } from "../errors";
import type { ProfileService } from "./profiles";
import { ROLE_RANK, type RoleService } from "./roles";

export interface Actor {
  pubkey: string;
  role: AdminRole | null;
}

export function defaultUser(pubkey: string): UserRecord {
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

  /** Throws 403 if the actor may not moderate (ban/mute/delete) the target. */
  /** Editing user records (notes, tags, allow-list…): yourself, or users ranked below you. */
  async assertCanEdit(actor: Actor, target: string): Promise<void> {
    if (target !== actor.pubkey) await this.assertCanModerate(actor, target);
  }

  async assertCanModerate(actor: Actor, target: string): Promise<void> {
    if (target === actor.pubkey) throw forbidden("cannot moderate yourself");
    if (this.roles.isConfigOwner(target)) throw forbidden("cannot moderate a configured owner");
    const targetRole = (await this.deps.stores.users.get(target))?.role ?? null;
    if (targetRole && (!actor.role || ROLE_RANK[targetRole] >= ROLE_RANK[actor.role])) {
      throw forbidden(`cannot moderate a user with role ${targetRole}`);
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
}
