import type { EventStore, NostrEvent, Profile } from "@beamhop/sdk";
import { LruCache } from "../util/lru";

const FIELDS = ["name", "display_name", "picture", "about", "nip05", "banner", "lud16", "website"] as const;

function parseProfile(ev: NostrEvent | undefined): Profile | undefined {
  if (!ev) return undefined;
  try {
    const raw = JSON.parse(ev.content) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return undefined;
    const p: Profile = {};
    for (const f of FIELDS) {
      const v = raw[f];
      if (typeof v === "string" && v) p[f] = v.slice(0, 2000);
    }
    if (!p.display_name && typeof raw.displayName === "string") p.display_name = raw.displayName.slice(0, 2000);
    return p;
  } catch {
    return undefined;
  }
}

/** Batch-loads kind-0 profiles with a small LRU cache (negative results cached too). */
export class ProfileService {
  private cache: LruCache<string, Profile | null>;
  constructor(
    private readonly events: EventStore,
    now: () => number,
  ) {
    this.cache = new LruCache(2000, 5 * 60_000, now);
  }

  async getMany(pubkeys: Iterable<string>): Promise<Map<string, Profile>> {
    const out = new Map<string, Profile>();
    const missing: string[] = [];
    for (const pk of new Set(pubkeys)) {
      if (!pk) continue;
      const hit = this.cache.get(pk);
      if (hit === undefined) missing.push(pk);
      else if (hit) out.set(pk, hit);
    }
    for (let i = 0; i < missing.length; i += 500) {
      const batch = missing.slice(i, i + 500);
      let evs: NostrEvent[] = [];
      try {
        evs = await this.events.query([{ kinds: [0], authors: batch }], { maxLimit: batch.length * 2 });
      } catch {
        evs = [];
      }
      const latest = new Map<string, NostrEvent>();
      for (const e of evs) {
        const cur = latest.get(e.pubkey);
        if (!cur || e.created_at > cur.created_at) latest.set(e.pubkey, e);
      }
      for (const pk of batch) {
        const p = parseProfile(latest.get(pk)) ?? null;
        this.cache.set(pk, p);
        if (p) out.set(pk, p);
      }
    }
    return out;
  }

  async get(pubkey: string): Promise<Profile | undefined> {
    return (await this.getMany([pubkey])).get(pubkey);
  }

  invalidate(pubkey: string) {
    this.cache.delete(pubkey);
  }
}
