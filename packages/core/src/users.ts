import type { AdminRole, EventBus, UserRecord, UserStore } from "@beamhop/sdk";
import { Lru } from "./util/lru";

interface Entry {
  rec: UserRecord | undefined;
  exp: number;
}

const PRIVILEGED: ReadonlySet<AdminRole> = new Set(["owner", "admin", "moderator"]);

/**
 * Short-TTL cache in front of UserStore (bans, mutes, allow-list, roles are checked on every event).
 * Invalidated on `user.updated` bus events. Concurrent misses for one pubkey share a single lookup, and
 * a lookup that was running when the pubkey was invalidated is not cached (it may have read the record
 * from before the change, e.g. before a ban).
 */
export class UserCache {
  private cache: Lru<string, Entry>;
  /** lookups running per pubkey; invalidate() drops them, so later callers start a fresh one */
  private inflight = new Map<string, Promise<UserRecord | undefined>>();
  private unsub: () => void;
  private readonly owners: Set<string>;

  constructor(
    private readonly users: UserStore,
    bus: EventBus,
    owners: string[],
    private readonly ttlMs = 10_000,
    maxEntries = 50_000,
  ) {
    this.owners = new Set(owners);
    this.cache = new Lru(maxEntries);
    const offUpdated = bus.on("user.updated", ({ pubkey }) => this.invalidate(pubkey));
    const offDeleted = bus.on("user.deleted", ({ pubkey }) => this.invalidate(pubkey));
    this.unsub = () => {
      offUpdated();
      offDeleted();
    };
  }

  get(pubkey: string): Promise<UserRecord | undefined> {
    const hit = this.cache.get(pubkey);
    if (hit && hit.exp > Date.now()) return Promise.resolve(hit.rec);
    const running = this.inflight.get(pubkey);
    if (running) return running;
    const started = Date.now();
    let read: Promise<UserRecord | undefined>;
    try {
      read = Promise.resolve(this.users.get(pubkey));
    } catch (err) {
      read = Promise.reject(err);
    }
    // only the current lookup (none since, no invalidate() meanwhile) settles the cache entry
    const current = () => this.inflight.get(pubkey) === lookup;
    const lookup: Promise<UserRecord | undefined> = read.then(
      (rec) => {
        if (current()) {
          this.inflight.delete(pubkey);
          this.cache.set(pubkey, { rec, exp: started + this.ttlMs });
        }
        return rec;
      },
      (err) => {
        if (current()) this.inflight.delete(pubkey);
        throw err;
      },
    );
    this.inflight.set(pubkey, lookup);
    return lookup;
  }

  invalidate(pubkey?: string) {
    if (pubkey) {
      this.cache.delete(pubkey);
      this.inflight.delete(pubkey);
    } else {
      this.cache.clear();
      this.inflight.clear();
    }
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
