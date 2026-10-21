// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Group mapping (§12.4): IdP group → relay access, tier, admin role, key model.
 *
 * Resolution rules (documented decisions):
 * - A mapping matches when its `group` equals (case-insensitive) any identifier of
 *   one of the person's groups: raw ref from the IdP, group id, external id,
 *   display name or group email. `idp: '*'` matches every IdP.
 * - Relay access is the union; `write` beats `read`.
 * - Tier per relay: among matching mappings that grant access to that relay and
 *   name a tier the relay defines, the tier listed LAST in the relay's `tiers`
 *   wins (tiers are listed from basic to premium).
 * - Admin role: highest of owner > admin > moderator > viewer. It applies to the
 *   mapping's relays, or node-wide (`*`) when the mapping lists no relays.
 * - Key model: `managed` if any matching mapping asks for it, else `self-custody`
 *   if any asks for it, else the module default.
 */
import type { RelayConfig, RelayId, Role } from '@beamhop/core';
import type { KeyModel } from './config.ts';
import type { Binding, GroupMapping, IdentityStore } from './store.ts';

export const ROLE_RANK: Record<Role, number> = { viewer: 1, moderator: 2, admin: 3, owner: 4 };

export interface Entitlements {
  access: Map<RelayId, 'read' | 'write'>;
  tiers: Map<RelayId, string>;
  roles: Record<RelayId | '*', Role>;
  keyModel: KeyModel | undefined;
  matched: GroupMapping[];
}

/** All identifiers a person's groups are known by (lowercased). */
export async function groupIdentifiers(store: IdentityStore, b: Binding): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ref of b.groups) {
    out.add(ref.toLowerCase());
    const g = await store.getGroup(b.idp, ref);
    if (!g) continue;
    out.add(g.id.toLowerCase());
    out.add(g.displayName.toLowerCase());
    if (g.externalId) out.add(g.externalId.toLowerCase());
    if (g.email) out.add(g.email.toLowerCase());
  }
  return out;
}

export function mappingMatches(m: GroupMapping, idp: string, idents: Set<string>): boolean {
  return (m.idp === '*' || m.idp === idp) && idents.has(m.group.toLowerCase());
}

export function resolveEntitlements(
  mappings: GroupMapping[],
  idp: string,
  idents: Set<string>,
  relayOf: (id: RelayId) => RelayConfig | undefined,
): Entitlements {
  const matched = mappings.filter((m) => mappingMatches(m, idp, idents));
  const access = new Map<RelayId, 'read' | 'write'>();
  const tiers = new Map<RelayId, string>();
  const roles: Record<string, Role> = {};
  let keyModel: KeyModel | undefined;
  for (const m of matched) {
    for (const g of m.relays) {
      if (g.access === 'write' || !access.has(g.relayId)) access.set(g.relayId, g.access);
      if (m.tier) {
        const relay = relayOf(g.relayId);
        const idx = relay?.tiers.findIndex((t) => t.id === m.tier) ?? -1;
        if (idx < 0) continue;
        const cur = tiers.get(g.relayId);
        const curIdx = cur ? (relay?.tiers.findIndex((t) => t.id === cur) ?? -1) : -1;
        if (idx > curIdx) tiers.set(g.relayId, m.tier);
      }
    }
    if (m.adminRole) {
      const scopes = m.relays.length ? m.relays.map((r) => r.relayId) : ['*'];
      for (const s of scopes) {
        const cur = roles[s];
        if (!cur || ROLE_RANK[m.adminRole] > ROLE_RANK[cur]) roles[s] = m.adminRole;
      }
    }
    if (m.keyModel === 'managed') keyModel = 'managed';
    else if (m.keyModel === 'self-custody' && keyModel !== 'managed') keyModel = 'self-custody';
  }
  return { access, tiers, roles, keyModel, matched };
}

export async function entitlementsOf(
  store: IdentityStore,
  b: Binding,
  relayOf: (id: RelayId) => RelayConfig | undefined,
): Promise<Entitlements> {
  return resolveEntitlements(
    await store.mappings(),
    b.idp,
    await groupIdentifiers(store, b),
    relayOf,
  );
}
