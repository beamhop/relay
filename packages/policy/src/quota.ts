// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-person storage quotas as people see them: how much each person may store
 * (admin override → tier → relay media setting → goals), how much they use, and
 * how many people are close to or over their limit — now or under proposed goals.
 */
import type { EffectiveLimits, RelayConfig, RelayId } from '@beamhop/core';
import type { PolicyRuntime } from './runtime.ts';

/** Docs collection of per-person quota overrides (written by Blossom's `media.set-quota`). */
export const QUOTA_OVERRIDES = 'blossom.quotas';

/** "Near" the limit from this share of the quota on. */
export const NEAR_QUOTA_RATIO = 0.8;

/** Owners in the blob index that are not people (anonymous uploads, media variants). */
const PERSON = /^[0-9a-f]{64}$/;

export interface QuotaStatus {
  quotaBytes: number;
  usedBytes: number;
  remainingBytes: number;
  overQuota: boolean;
  nearQuota: boolean;
}

export function quotaStatus(usedBytes: number, quotaBytes: number): QuotaStatus {
  const overQuota = usedBytes > quotaBytes;
  return {
    quotaBytes,
    usedBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
    overQuota,
    nearQuota: !overQuota && usedBytes >= quotaBytes * NEAR_QUOTA_RATIO,
  };
}

export async function quotaOverride(
  rt: PolicyRuntime,
  relayId: RelayId,
  pubkey: string,
): Promise<number | undefined> {
  const v = await rt.kernel.ports.docs.get<{ quotaBytes?: number }>(
    QUOTA_OVERRIDES,
    `${relayId}:${pubkey}`,
  );
  return typeof v?.quotaBytes === 'number' ? v.quotaBytes : undefined;
}

/**
 * Effective quota for one person: admin override, else the limits for their tier
 * (`limits` already folds in tier.blobQuotaBytes, blossom.defaultQuotaBytes and goals).
 */
export async function effectiveQuota(
  rt: PolicyRuntime,
  relay: RelayConfig,
  pubkey: string,
  tier: string,
  limitsFor: (tier: string) => EffectiveLimits = (t) => rt.kernel.limits(relay.id, t),
): Promise<number> {
  return (await quotaOverride(rt, relay.id, pubkey)) ?? limitsFor(tier).defaultBlobQuotaBytes;
}

const MAX_SCAN = 50_000;

/** Bytes stored per owner on a relay (blob index scan, capped). */
export async function usageByOwner(
  rt: PolicyRuntime,
  relayId: RelayId,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const page = await rt.kernel.ports.blobIndex.list(relayId, { cursor, limit: 1000 });
    for (const o of page.items) out.set(o.pubkey, (out.get(o.pubkey) ?? 0) + o.size);
    scanned += page.items.length;
    cursor = page.items.length ? page.cursor : undefined;
  } while (cursor && scanned < MAX_SCAN);
  return out;
}

export interface QuotaImpact {
  /** People at ≥80% of their limit (but not over). */
  nearQuota: number;
  /** People storing more than their limit (they cannot upload until they delete something). */
  overQuota: number;
}

/** How many people with stored files would be near/over their quota under `limitsFor`. */
export async function quotaImpact(
  rt: PolicyRuntime,
  relay: RelayConfig,
  usage: Map<string, number>,
  limitsFor: (tier: string) => EffectiveLimits,
): Promise<QuotaImpact> {
  const out: QuotaImpact = { nearQuota: 0, overQuota: 0 };
  for (const [pubkey, used] of usage) {
    if (!PERSON.test(pubkey) || used <= 0) continue;
    const tier = await rt.resolveTier(relay.id, pubkey);
    const s = quotaStatus(used, await effectiveQuota(rt, relay, pubkey, tier, limitsFor));
    if (s.overQuota) out.overQuota++;
    else if (s.nearQuota) out.nearQuota++;
  }
  return out;
}
