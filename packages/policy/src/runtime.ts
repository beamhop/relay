// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-kernel policy runtime: shared state behind hooks, access resolvers,
 * actions, cards and the public `policy` service.
 */
import type { Decision, Kernel, RelayConfig, RelayId } from '@beamhop/core';
import { type PolicyModuleConfig, PolicyModuleConfigSchema, type TierRule } from './config.ts';
import { ModerationQueue } from './moderation.ts';
import { COLLECTIONS, PolicyState } from './state.ts';
import { TokenBuckets } from './util.ts';
import { type FollowFetcher, type WotGraph, computeWot, followLoader } from './wot.ts';

export interface HookCounters {
  rejected: number;
  shadowed: number;
  held: number;
}

export interface PolicyStatsSnapshot {
  /** Unix seconds when counting started. */
  since: number;
  total: HookCounters;
  hooks: Record<string, HookCounters>;
  /** Reject/hold reasons (message prefix before ':') → count. */
  reasons: Record<string, number>;
}

export class PolicyStats {
  private hooks = new Map<string, HookCounters>();
  private reasons = new Map<string, number>();
  private total: HookCounters = { rejected: 0, shadowed: 0, held: 0 };
  constructor(private since: number) {}

  record(hookId: string, d: Decision): void {
    if (d.action === 'accept') return;
    let c = this.hooks.get(hookId);
    if (!c) {
      c = { rejected: 0, shadowed: 0, held: 0 };
      this.hooks.set(hookId, c);
    }
    const field = d.action === 'reject' ? 'rejected' : d.action === 'shadow' ? 'shadowed' : 'held';
    c[field]++;
    this.total[field]++;
    const key = d.action === 'reject' ? `${d.prefix}` : d.action;
    this.reasons.set(key, (this.reasons.get(key) ?? 0) + 1);
  }

  snapshot(): PolicyStatsSnapshot {
    return {
      since: this.since,
      total: { ...this.total },
      hooks: Object.fromEntries([...this.hooks].map(([k, v]) => [k, { ...v }])),
      reasons: Object.fromEntries(this.reasons),
    };
  }

  reset(now: number): void {
    this.hooks.clear();
    this.reasons.clear();
    this.total = { rejected: 0, shadowed: 0, held: 0 };
    this.since = now;
  }
}

interface SpamHit {
  pubkey: string;
  at: number;
  isNew: boolean;
  by: string;
}

/** Remembers recent spam-filter hits per relay to detect waves of new keys. */
export class SpamTracker {
  private hits = new Map<RelayId, SpamHit[]>();
  record(relayId: RelayId, hit: SpamHit, windowSeconds: number): void {
    let arr = this.hits.get(relayId);
    if (!arr) {
      arr = [];
      this.hits.set(relayId, arr);
    }
    arr.push(hit);
    if (arr.length > 20_000 || (arr[0] && arr[0].at < hit.at - windowSeconds)) {
      this.hits.set(relayId, arr.filter((h) => h.at >= hit.at - windowSeconds).slice(-10_000));
    }
  }
  /** Distinct new pubkeys hit within the window, most active first. */
  newKeys(relayId: RelayId, now: number, windowSeconds: number): string[] {
    const counts = new Map<string, number>();
    for (const h of this.hits.get(relayId) ?? []) {
      if (h.at < now - windowSeconds || !h.isNew) continue;
      counts.set(h.pubkey, (counts.get(h.pubkey) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }
}

export interface PolicyModuleOptions {
  /** Upstream follow-list source for WoT (e.g. a client for public relays). */
  fetchFollowLists?: FollowFetcher;
}

/** Hook ids whose rejections count toward spam-wave detection. */
export const SPAM_HOOKS = new Set([
  'policy.rate-limit',
  'policy.pow',
  'policy.duplicate',
  'policy.content',
]);

export class PolicyRuntime {
  readonly state: PolicyState;
  readonly queue: ModerationQueue;
  readonly stats: PolicyStats;
  readonly spam = new SpamTracker();
  readonly buckets = new TokenBuckets();
  private wot = new Map<RelayId, WotGraph>();
  private wotLoading = new Map<RelayId, Promise<WotGraph | undefined>>();
  private tierCache = new Map<string, { tier: string; exp: number }>();
  private pending = new Set<Promise<unknown>>();

  constructor(
    readonly kernel: Kernel,
    readonly opts: PolicyModuleOptions = {},
  ) {
    this.state = new PolicyState(kernel.ports);
    this.stats = new PolicyStats(kernel.ports.clock.now());
    this.queue = new ModerationQueue(
      kernel.ports,
      kernel.bus,
      this.state,
      () => this.config().recycleDays,
    );
  }

  config(): PolicyModuleConfig {
    return (
      this.kernel.moduleConfig<PolicyModuleConfig>('policy') ?? PolicyModuleConfigSchema.parse({})
    );
  }

  relay(relayId: RelayId): RelayConfig | undefined {
    return this.kernel.relay(relayId);
  }

  isOwner(relay: RelayConfig, pubkey: string): boolean {
    return !!relay.info.pubkey && relay.info.pubkey === pubkey;
  }

  /** Run a background task; errors go to the bus. `idle()` awaits all of them. */
  track(p: Promise<unknown>, source: string): void {
    const q = p.catch((err) => {
      this.kernel.bus.emit('error', { source, message: String(err) });
    });
    this.pending.add(q);
    q.finally(() => this.pending.delete(q));
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  // ── tiers ──

  clearTierCache(): void {
    this.tierCache.clear();
  }

  /** Rule-based tier (first matching rule whose tier exists), or undefined. */
  async ruleTier(relay: RelayConfig, pubkey: string): Promise<string | undefined> {
    const rules = this.config().tierRules.filter(
      (r: TierRule) => !r.relayId || r.relayId === relay.id,
    );
    for (const r of rules) {
      if (!relay.tiers.some((t) => t.id === r.tier)) continue;
      if (r.when.allowlisted !== undefined) {
        const listed = await this.state.isAllowlisted(relay.id, pubkey);
        if (listed !== r.when.allowlisted) continue;
      }
      if (r.when.wotDepthAtMost !== undefined) {
        const m = await this.wotMember(relay.id, pubkey);
        if (!m || m.depth > r.when.wotDepthAtMost) continue;
      }
      if (r.when.allowlisted === undefined && r.when.wotDepthAtMost === undefined) continue;
      return r.tier;
    }
    return undefined;
  }

  /** Tier resolution: AccessResolver chain (explicit > rules > other modules) > relay default. */
  async resolveTier(relayId: RelayId, pubkey: string): Promise<string> {
    const relay = this.relay(relayId);
    if (!relay) return 'default';
    const k = `${relayId}:${pubkey}`;
    const now = this.kernel.ports.clock.nowMs();
    const hit = this.tierCache.get(k);
    if (hit && hit.exp > now) return hit.tier;
    let tier: string | undefined;
    for (const r of this.kernel.access) {
      if (!r.tierOf) continue;
      const t = await r.tierOf(relayId, pubkey);
      if (t !== undefined && relay.tiers.some((x) => x.id === t)) {
        tier = t;
        break;
      }
    }
    tier ??= relay.defaultTier;
    if (this.tierCache.size > 100_000) this.tierCache.clear();
    this.tierCache.set(k, { tier, exp: now + 60_000 });
    return tier;
  }

  // ── web of trust ──

  private wotFresh(relay: RelayConfig, g: WotGraph): boolean {
    const roots = this.wotRoots(relay);
    return (
      g.depth === relay.access.wot.depth &&
      g.minFollowers === relay.access.wot.minFollowers &&
      g.roots.length === roots.length &&
      g.roots.every((r) => roots.includes(r))
    );
  }

  wotRoots(relay: RelayConfig): string[] {
    return [
      ...new Set([...(relay.info.pubkey ? [relay.info.pubkey] : []), ...relay.access.wot.seeds]),
    ];
  }

  /** Current WoT graph: memory → DocStore cache → compute. */
  async ensureWot(relayId: RelayId): Promise<WotGraph | undefined> {
    const relay = this.relay(relayId);
    if (!relay) return undefined;
    const mem = this.wot.get(relayId);
    if (mem && this.wotFresh(relay, mem)) return mem;
    let p = this.wotLoading.get(relayId);
    if (!p) {
      p = (async () => {
        const cached = await this.kernel.ports.docs.get<WotGraph>(COLLECTIONS.wot, relayId);
        if (cached && this.wotFresh(relay, cached)) {
          this.wot.set(relayId, cached);
          return cached;
        }
        return this.refreshWot(relayId);
      })().finally(() => this.wotLoading.delete(relayId));
      this.wotLoading.set(relayId, p);
    }
    return p;
  }

  /** Recompute the WoT graph from follow lists and persist it. */
  async refreshWot(relayId: RelayId): Promise<WotGraph | undefined> {
    const relay = this.relay(relayId);
    if (!relay) return undefined;
    const graph = await computeWot(
      relayId,
      {
        roots: this.wotRoots(relay),
        depth: relay.access.wot.depth,
        minFollowers: relay.access.wot.minFollowers,
        maxMembers: this.config().wot.maxMembers,
      },
      followLoader(this.kernel.ports.events, relayId, this.opts.fetchFollowLists),
      this.kernel.ports.clock.now(),
    );
    await this.kernel.ports.docs.put(COLLECTIONS.wot, relayId, graph);
    this.wot.set(relayId, graph);
    this.clearTierCache();
    return graph;
  }

  async wotMember(relayId: RelayId, pubkey: string) {
    const g = await this.ensureWot(relayId);
    return g?.members[pubkey];
  }

  /** Drop memory caches for a relay (another node changed state). */
  invalidate(relayId: RelayId, what: string): void {
    if (what === 'wot') this.wot.delete(relayId);
    else this.state.invalidate(relayId);
    this.clearTierCache();
  }

  /** Is the pubkey "new" (recently first seen) for PoW / spam-wave purposes? */
  async isNewKey(
    relay: RelayConfig,
    pubkey: string,
    newKeyDays: number,
    now: number,
  ): Promise<boolean> {
    if (this.isOwner(relay, pubkey)) return false;
    if (await this.state.isAllowlisted(relay.id, pubkey)) return false;
    if (await this.state.explicitTier(relay.id, pubkey)) return false;
    const first = await this.state.firstSeen(relay.id, pubkey);
    if (first === undefined) return true;
    return now - first < newKeyDays * 86400;
  }
}
