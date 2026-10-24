import type { AdminRole, EventBus, UserRecord, UserStore } from "@beamhop/sdk";

interface Entry {
  rec: UserRecord | undefined;
  exp: number;
}

const PRIVILEGED: ReadonlySet<AdminRole> = new Set(["owner", "admin", "moderator"]);

/**
 * Short-TTL cache in front of UserStore (bans, mutes, allow-list, roles are checked on every event).
 * Invalidated on `user.updated` bus events.
 */
export class UserCache {
  private cache = new Map<string, Entry>();
  private unsub: () => void;
  private readonly owners: Set<string>;

  constructor(
    private readonly users: UserStore,
    bus: EventBus,
    owners: string[],
    private readonly ttlMs = 10_000,
    private readonly maxEntries = 50_000,
  ) {
    this.owners = new Set(owners);
    const offUpdated = bus.on("user.updated", ({ pubkey }) => this.invalidate(pubkey));
    const offDeleted = bus.on("user.deleted", ({ pubkey }) => this.invalidate(pubkey));
    this.unsub = () => {
      offUpdated();
      offDeleted();
    };
  }

  async get(pubkey: string): Promise<UserRecord | undefined> {
    const now = Date.now();
    const hit = this.cache.get(pubkey);
    if (hit && hit.exp > now) return hit.rec;
    const rec = await this.users.get(pubkey);
    if (this.cache.size >= this.maxEntries) this.cache.clear();
    this.cache.set(pubkey, { rec, exp: now + this.ttlMs });
    return rec;
  }

  invalidate(pubkey?: string) {
    if (pubkey) this.cache.delete(pubkey);
    else this.cache.clear();
  }

  /** Relay member: allow-listed, any admin-panel role, or configured owner. */
  isMember(pubkey: string, rec: UserRecord | undefined): boolean {
    return this.owners.has(pubkey) || !!rec?.allowed || (rec?.role ?? null) !== null;
  }

  /** Relay staff (owner/admin/moderator) — bypass rate limits, may manage any NIP-29 group. */
  isStaff(pubkey: string, rec: UserRecord | undefined): boolean {
    return this.owners.has(pubkey) || (!!rec?.role && PRIVILEGED.has(rec.role));
  }

  dispose() {
    this.unsub();
  }
}
