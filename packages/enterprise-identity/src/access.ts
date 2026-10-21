// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SSO binding access resolver (§12.2): on enterprise relays (`relays` in the
 * module config) the NIP-42-authenticated pubkey must belong to an ACTIVE
 * binding. It is put at the FRONT of `kernel.access` so revocations win over
 * allowlists and WoT; on every other relay it abstains.
 *
 * Relay grants: when no group mapping grants anything on a relay, every active
 * binding may read and write there (the simple "whole company" start). Once a
 * mapping grants that relay, access follows the mappings.
 */
import type { AccessResolver, Kernel, RelayId } from '@beamhop/core';
import type { EnterpriseIdentityConfig } from './config.ts';
import { entitlementsOf } from './mapping.ts';
import type { Binding, IdentityStore } from './store.ts';

export const ACCESS_RESOLVER_ID = 'enterprise.binding';

export function relayAccessOf(
  kernel: Kernel,
  store: IdentityStore,
): (relayId: RelayId, b: Binding) => Promise<'read' | 'write' | 'none'> {
  return async (relayId, b) => {
    const ent = await entitlementsOf(store, b, (id) => kernel.relay(id));
    const granted = ent.access.get(relayId);
    if (granted) return granted;
    const anyGrant = (await store.mappings()).some((m) =>
      m.relays.some((r) => r.relayId === relayId),
    );
    return anyGrant ? 'none' : 'write';
  };
}

export function bindingAccessResolver(
  kernel: Kernel,
  store: IdentityStore,
  cfg: () => EnterpriseIdentityConfig,
): AccessResolver {
  const accessOf = relayAccessOf(kernel, store);
  const enforced = (relayId: RelayId) => cfg().relays.includes(relayId);

  const decide = async (relayId: RelayId, pubkey: string, need: 'read' | 'write') => {
    const { b, revoked } = await store.lookupPubkey(pubkey);
    if (revoked) return false;
    if (b && b.status === 'active') {
      const a = await accessOf(relayId, b);
      if (a === 'write' || (a === 'read' && need === 'read')) return true;
      return false;
    }
    // Not a company member: let the relay owner through via the other resolvers.
    if (kernel.relay(relayId)?.info.pubkey === pubkey) return undefined;
    return cfg().unboundAccess === 'deny' ? false : undefined;
  };

  return {
    id: ACCESS_RESOLVER_ID,
    async canWrite(relayId, pubkey) {
      if (!enforced(relayId)) return undefined;
      return decide(relayId, pubkey, 'write');
    },
    async canRead(relayId, pubkey) {
      if (!enforced(relayId)) return undefined;
      // Company relays are private: anonymous readers must AUTH first.
      if (pubkey === null) return cfg().unboundAccess === 'deny' ? false : undefined;
      return decide(relayId, pubkey, 'read');
    },
    async tierOf(relayId, pubkey) {
      if (!enforced(relayId)) return undefined;
      const { b, revoked } = await store.lookupPubkey(pubkey);
      if (revoked || !b || b.status !== 'active') return undefined;
      return (await entitlementsOf(store, b, (id) => kernel.relay(id))).tiers.get(relayId);
    },
  };
}
