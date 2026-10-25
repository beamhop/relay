import type { AdminApiDeps, BanRequest, IpRule, UserRecord } from "@beamhop/sdk";
import type { CredentialService } from "./credentials";
import type { PushService } from "./push";
import type { SessionService } from "./sessions";
import type { UserService } from "./users";

/** What a ban did so far: filled in as it goes, so a caller auditing in `finally` records partial work too. */
export interface BanOutcome {
  deletedEvents: number;
  deletedMedia: number;
  disconnected: number;
  /** the user was on the allow list, which a ban clears */
  unallowed?: boolean;
  user?: UserRecord;
}
/** What deleting a user did so far (see BanOutcome). */
export interface DeleteOutcome {
  deletedEvents: number;
  deletedMedia: number;
  disconnected: number;
}

export const emptyBanOutcome = (): BanOutcome => ({ deletedEvents: 0, deletedMedia: 0, disconnected: 0 });
export const emptyDeleteOutcome = (): DeleteOutcome => ({ deletedEvents: 0, deletedMedia: 0, disconnected: 0 });

/**
 * The moderation actions shared by the REST routes, bulk actions, report resolutions and NIP-86, so every path has the
 * same effects (status, allow list, disconnects, bus events). Rank and permission checks stay with the callers, which
 * answer refusals in their own way (HTTP 403 / NIP-86 error); auditing too, since each path records its own details.
 */
export class ModerationService {
  constructor(
    private readonly deps: AdminApiDeps,
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly push: PushService,
    private readonly credentials: CredentialService,
  ) {}

  /**
   * Bans `pubkey`: status and reason, removal from the allow list (like NIP-86 banpubkey: an allow-listed user would
   * otherwise get straight back in once unbanned), disconnect, then the optional slow deletes. `out` is updated after
   * each step.
   */
  async banUser(pubkey: string, req: BanRequest, actor: string, out: BanOutcome = emptyBanOutcome()): Promise<BanOutcome> {
    const unallowed = (await this.deps.stores.users.get(pubkey))?.allowed === true;
    out.user = await this.users.update(pubkey, { status: "banned", banReason: req.reason ?? null, ...(unallowed ? { allowed: false } : {}) }, actor);
    if (unallowed) out.unallowed = true;
    if (req.disconnect ?? true) out.disconnected = this.deps.relay.disconnect({ pubkey });
    if (req.deleteEvents) out.deletedEvents = await this.deps.stores.events.deleteByPubkey(pubkey);
    if (req.deleteMedia && this.deps.blossom) out.deletedMedia = await this.deps.blossom.deleteByPubkey(pubkey, actor);
    return out;
  }

  /** Lifts a ban; anything else (a mute, an active user) is left alone. `changed`: whether there was a ban to lift. */
  async unbanUser(pubkey: string, actor: string): Promise<{ user: UserRecord; changed: boolean }> {
    const current = await this.users.getOrDefault(pubkey);
    if (current.status !== "banned") return { user: current, changed: false };
    return { user: await this.users.setStatus(pubkey, "active", actor), changed: true };
  }

  /** Adds (or replaces) an IP rule; a block of a single address also disconnects it. */
  async addIpRule(rule: Omit<IpRule, "createdAt">, actor: string): Promise<{ disconnected: number }> {
    await this.deps.stores.ipRules.add(rule);
    this.deps.bus.emit("ip.rules.changed", { actor });
    const disconnected = rule.action === "block" && !rule.cidr.includes("/") ? this.deps.relay.disconnect({ ip: rule.cidr }) : 0;
    return { disconnected };
  }

  /** Removes an IP rule. False (and nothing emitted) when there was none. */
  async removeIpRule(cidr: string, actor: string): Promise<boolean> {
    if (!(await this.deps.stores.ipRules.list()).some((r) => r.cidr === cidr)) return false;
    await this.deps.stores.ipRules.remove(cidr);
    this.deps.bus.emit("ip.rules.changed", { actor });
    return true;
  }

  /**
   * Ends whatever admin access `pubkey` had: sessions, push devices and login factors (password, TOTP, passkeys), so a
   * role granted again later can't be used with credentials from before (possibly the reason it was removed).
   */
  async revokeAdminAccess(pubkey: string): Promise<void> {
    await this.sessions.destroyAllFor(pubkey);
    await this.push.unsubscribeAllFor(pubkey);
    await this.credentials.deleteAll(pubkey);
  }

  /**
   * Removes the user record and everything they stored here. Not a ban: they can connect again later. The role and admin
   * access go first, so a slow delete (or one failing halfway) never leaves a removed staff member signed in meanwhile.
   */
  async deleteUser(pubkey: string, actor: string, out: DeleteOutcome = emptyDeleteOutcome()): Promise<DeleteOutcome> {
    if ((await this.deps.stores.users.get(pubkey))?.role) await this.users.update(pubkey, { role: null }, actor);
    await this.revokeAdminAccess(pubkey);
    out.disconnected = this.deps.relay.disconnect({ pubkey });
    out.deletedEvents = await this.deps.stores.events.deleteByPubkey(pubkey);
    if (this.deps.blossom) out.deletedMedia = await this.deps.blossom.deleteByPubkey(pubkey, actor);
    await this.deps.stores.users.delete(pubkey);
    this.deps.bus.emit("user.deleted", { pubkey, actor });
    return out;
  }
}
