// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/policy — goals engine, personas, access modes (allowlist, invites,
 * WoT, NIP-42 gating), tiers, built-in spam filters and rate limits, and the
 * moderation queue with recycle bin.
 */
import { type BeamhopModule, type Kernel, type RelayId, defineModule } from '@beamhop/core';
import { allowlistResolver, tierResolver, wotResolver } from './access.ts';
import { createActions } from './actions.ts';
import { PolicyModuleConfigSchema } from './config.ts';
import { type LimitExplanation, deriveLimits, explainLimits } from './goals.ts';
import { createHooks } from './hooks.ts';
import { moderationCards, moderationHealth } from './insights.ts';
import type { ModerationQueue } from './moderation.ts';
import { type PolicyModuleOptions, PolicyRuntime, type PolicyStatsSnapshot } from './runtime.ts';
import { INVALIDATE_CHANNEL, type InviteResult, type PolicyState } from './state.ts';
import type { WotGraph, WotMember } from './wot.ts';

export * from './access.ts';
export * from './actions.ts';
export * from './config.ts';
export * from './goals.ts';
export * from './hooks.ts';
export * from './insights.ts';
export * from './lists.ts';
export * from './moderation.ts';
export * from './personas.ts';
export * from './quota.ts';
export * from './runtime.ts';
export * from './state.ts';
export * from './util.ts';
export * from './wot.ts';

/** Service exposed as `kernel.use<PolicyService>('policy')`. */
export interface PolicyService {
  explainLimits(relayId: RelayId, tier?: string): LimitExplanation[];
  resolveTier(relayId: RelayId, pubkey: string): Promise<string>;
  /** Join via invite code (public portal). */
  redeemInvite(relayId: RelayId, code: string, pubkey: string): Promise<InviteResult>;
  refreshWot(relayId: RelayId): Promise<WotGraph | undefined>;
  wotMember(relayId: RelayId, pubkey: string): Promise<WotMember | undefined>;
  stats(): PolicyStatsSnapshot;
  purgeRecycleBin(): Promise<number>;
  readonly queue: ModerationQueue;
  readonly state: PolicyState;
  /** Resolves when background bookkeeping (queue writes, first-seen) has settled. */
  idle(): Promise<void>;
}

const runtimes = new WeakMap<Kernel, { rt: PolicyRuntime; cleanup: Array<() => void> }>();

export function createPolicyModule(opts: PolicyModuleOptions = {}): BeamhopModule {
  return defineModule({
    id: 'policy',
    configSchema: PolicyModuleConfigSchema,
    register(kernel) {
      const rt = new PolicyRuntime(kernel, opts);
      const cleanup: Array<() => void> = [];
      runtimes.set(kernel, { rt, cleanup });

      kernel.setLimitsResolver((relay, tier) => deriveLimits(relay, tier));
      for (const h of createHooks(rt)) cleanup.push(kernel.policy.add(h));
      kernel.access.push(allowlistResolver(rt), wotResolver(rt), tierResolver(rt));
      kernel.health.push(moderationHealth(rt));
      kernel.cards.push(moderationCards(rt));
      for (const a of createActions(rt)) kernel.actions.register(a);

      cleanup.push(
        kernel.bus.on('event.accepted', ({ relayId, event }) => {
          const at = kernel.ports.clock.now();
          rt.track(rt.state.markSeen(relayId, event.pubkey, at), 'policy.first-seen');
          rt.track(rt.state.markActive(relayId, event.pubkey, at), 'policy.active');
        }),
        kernel.bus.on('auth.success', ({ relayId, pubkey }) =>
          rt.track(rt.state.markActive(relayId, pubkey, kernel.ports.clock.now()), 'policy.active'),
        ),
        kernel.bus.on('blob.uploaded', ({ relayId, pubkey }) =>
          rt.track(rt.state.markActive(relayId, pubkey, kernel.ports.clock.now()), 'policy.active'),
        ),
        kernel.bus.on('event.held', ({ relayId, event, by, reason }) =>
          rt.track(rt.queue.addHeld(relayId, event, by, reason), 'policy.queue'),
        ),
        kernel.bus.on('report.received', ({ relayId, report }) =>
          rt.track(rt.queue.addReport(relayId, report), 'policy.queue'),
        ),
        kernel.bus.on('blob.quarantined', ({ relayId, sha256, reason }) =>
          rt.track(rt.queue.addBlob(relayId, sha256, reason), 'policy.queue'),
        ),
      );

      const service: PolicyService = {
        explainLimits(relayId, tier) {
          const relay = kernel.relay(relayId);
          if (!relay) throw new Error(`unknown relay ${relayId}`);
          return explainLimits(relay, tier);
        },
        resolveTier: (relayId, pubkey) => rt.resolveTier(relayId, pubkey),
        async redeemInvite(relayId, code, pubkey) {
          const r = await rt.state.redeemInvite(relayId, code, pubkey);
          rt.clearTierCache();
          return r;
        },
        refreshWot: (relayId) => rt.refreshWot(relayId),
        wotMember: (relayId, pubkey) => rt.wotMember(relayId, pubkey),
        stats: () => rt.stats.snapshot(),
        purgeRecycleBin: () => rt.queue.purge(kernel.ports.clock.now()),
        queue: rt.queue,
        state: rt.state,
        idle: () => rt.idle(),
      };
      kernel.provide('policy', service);
    },

    start(kernel) {
      const entry = runtimes.get(kernel);
      if (!entry) return;
      const { rt, cleanup } = entry;
      const sched = kernel.ports.scheduler;

      sched.every('policy.recycle-purge', 3600, async () => {
        await rt.queue.purge(kernel.ports.clock.now());
      });
      cleanup.push(() => sched.cancel('policy.recycle-purge'));

      let wotJobs: string[] = [];
      const scheduleWot = () => {
        for (const name of wotJobs) sched.cancel(name);
        wotJobs = [];
        for (const relay of kernel.config().relays) {
          if (relay.access.mode !== 'wot') continue;
          const name = `policy.wot:${relay.id}`;
          sched.every(name, relay.access.wot.refreshMinutes * 60, async () => {
            await rt.refreshWot(relay.id);
          });
          wotJobs.push(name);
        }
      };
      scheduleWot();
      cleanup.push(() => {
        for (const name of wotJobs) sched.cancel(name);
      });
      cleanup.push(kernel.onConfigChange(() => scheduleWot()));

      cleanup.push(
        kernel.ports.pubsub.subscribe(INVALIDATE_CHANNEL, (msg) => {
          const m = msg as { relayId?: string; what?: string; origin?: string };
          if (!m?.relayId || m.origin === rt.state.origin) return;
          rt.invalidate(m.relayId, m.what ?? 'all');
        }),
      );
    },

    stop(kernel) {
      const entry = runtimes.get(kernel);
      if (!entry) return;
      for (const fn of entry.cleanup.splice(0)) fn();
      return entry.rt.idle();
    },
  });
}

/** The policy module with default options (no upstream WoT fetcher). */
export const policyModule = createPolicyModule();
