// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Access resolvers (§5.1): allowlist (+ invites), web of trust, and tiers.
 * Resolvers abstain (`undefined`) whenever the relay's access mode does not
 * concern them, so other modules (e.g. enterprise SSO binding) can decide.
 */
import type { AccessResolver } from '@beamhop/core';
import type { PolicyRuntime } from './runtime.ts';

export function allowlistResolver(rt: PolicyRuntime): AccessResolver {
  return {
    id: 'policy.allowlist',
    async canWrite(relayId, pubkey) {
      const relay = rt.relay(relayId);
      if (!relay || relay.access.mode === 'open') return undefined;
      if (rt.isOwner(relay, pubkey)) return true;
      if (await rt.state.isAllowlisted(relayId, pubkey)) return true;
      return relay.access.mode === 'allowlist' ? false : undefined;
    },
    async canRead(relayId, pubkey) {
      const relay = rt.relay(relayId);
      if (!relay || !relay.access.authRequired.read) return undefined;
      if (pubkey === null) return false;
      if (relay.access.mode === 'open') return true;
      if (rt.isOwner(relay, pubkey)) return true;
      if (await rt.state.isAllowlisted(relayId, pubkey)) return true;
      return relay.access.mode === 'allowlist' ? false : undefined;
    },
  };
}

export function wotResolver(rt: PolicyRuntime): AccessResolver {
  return {
    id: 'policy.wot',
    async canWrite(relayId, pubkey) {
      const relay = rt.relay(relayId);
      if (!relay || relay.access.mode !== 'wot') return undefined;
      return (await rt.wotMember(relayId, pubkey)) !== undefined;
    },
    async canRead(relayId, pubkey) {
      const relay = rt.relay(relayId);
      if (!relay || relay.access.mode !== 'wot' || !relay.access.authRequired.read)
        return undefined;
      if (pubkey === null) return false;
      return (await rt.wotMember(relayId, pubkey)) !== undefined;
    },
  };
}

/** Tier: explicit assignment (DocStore `policy.tiers`) > rules; abstains for the default. */
export function tierResolver(rt: PolicyRuntime): AccessResolver {
  return {
    id: 'policy.tiers',
    async tierOf(relayId, pubkey) {
      const relay = rt.relay(relayId);
      if (!relay) return undefined;
      const explicit = await rt.state.explicitTier(relayId, pubkey);
      if (explicit && relay.tiers.some((t) => t.id === explicit.tier)) return explicit.tier;
      return rt.ruleTier(relay, pubkey);
    },
  };
}

/** Evaluate the kernel's AccessResolver chain: first non-undefined answer wins. */
export async function canWriteChain(rt: PolicyRuntime, relayId: string, pubkey: string) {
  for (const r of rt.kernel.access) {
    if (!r.canWrite) continue;
    const v = await r.canWrite(relayId, pubkey);
    if (v !== undefined) return { allowed: v, by: r.id };
  }
  return { allowed: true, by: undefined };
}

export async function canReadChain(rt: PolicyRuntime, relayId: string, pubkey: string | null) {
  for (const r of rt.kernel.access) {
    if (!r.canRead) continue;
    const v = await r.canRead(relayId, pubkey);
    if (v !== undefined) return { allowed: v, by: r.id };
  }
  return { allowed: true, by: undefined };
}
