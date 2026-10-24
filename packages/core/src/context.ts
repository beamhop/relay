import type { CoreDeps, NostrEvent, RuntimeSettings, UnsignedEvent } from "@beamhop/sdk";
import type { IpRuleCache } from "./ip-rules";
import type { GroupsService } from "./nips/nip29/groups";
import type { ContentPolicy } from "./pipeline/content-policy";
import type { Verifier } from "./pipeline/verify";
import type { Connection } from "./protocol/connection";
import type { ReadLimits } from "./protocol/read-limits";
import type { SubscriptionIndex } from "./subscriptions/index";
import type { UserCache } from "./users";
import type { Lru } from "./util/lru";
import type { RateLimiter } from "./util/rate-limit";

export interface RelayKey {
  pubkey: string;
  sign(template: UnsignedEvent): NostrEvent;
}

/** Shared state of one relay instance; passed to every module. */
export interface RelayContext extends CoreDeps {
  /** ws(s):// form of config.server.publicUrl */
  relayUrl: string;
  key: RelayKey;
  users: UserCache;
  rate: RateLimiter;
  ipRules: IpRuleCache;
  subs: SubscriptionIndex;
  conns: Map<string, Connection>;
  groups: GroupsService;
  verifier: Verifier;
  policy: ContentPolicy;
  /** NIP-62: pubkey → created_at of its vanish request */
  vanished: Map<string, number>;
  /** ids of recently relayed ephemeral events → when they may be relayed again (ms): replays aren't fanned out twice */
  ephemeralSeen: Lru<string, number>;
  /** NIP-77 relay-wide accounting: items held by open sessions or listed by NEG-OPENs being prepared, and NEG-OPENs being prepared (in total and per address) */
  neg: { items: number; opening: number; openingByIp: Map<string, number> };
  /** relay-wide read throttling: search/query concurrency, materialized result memory */
  reads: ReadLimits;
  s(): RuntimeSettings;
  /** Fans out an accepted event to matching live subscriptions; returns recipient count. */
  broadcast(event: NostrEvent): number;
  /** Closes matching connections with a NOTICE (see RelayEngine.disconnect); returns how many. */
  disconnect(target: { id?: string; pubkey?: string; ip?: string }, notice?: string): number;
}
