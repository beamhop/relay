// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { BeamhopModule } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import {
  type Binding,
  type EnterpriseIdentityService,
  IDENTITY_SERVICE,
  MAINTENANCE_JOB,
  type SiemRecordInput,
} from '../src/index.ts';
import {
  FakeKeyVault,
  type MockIdp,
  createMockIdp,
  keyvaultModule,
  makeKernel,
  routedFetch,
  ssoLogin,
} from './helpers.ts';

function binding(subject: string, extra: Partial<Binding> = {}): Binding {
  return {
    idp: 'okta',
    subject,
    groups: [],
    keyModel: 'self-custody',
    status: 'pending',
    source: 'scim',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

async function setup(opts: { keyvault?: FakeKeyVault; idp?: MockIdp } = {}) {
  const siem: SiemRecordInput[] = [];
  const holdCalls: Array<[string, unknown]> = [];
  const holds = { held: new Set<string>() };
  const extra: BeamhopModule[] = [
    {
      id: 'fake-compliance',
      register(k) {
        k.provide('compliance.siem', { record: (r: SiemRecordInput) => siem.push(r) });
        k.provide('lifecycle.holds', {
          // The real lifecycle signature: (relayId, subject).
          isHeld: async (relayId: string, subject: { pubkey?: string }) => {
            holdCalls.push([relayId, subject]);
            return holds.held.has(`${relayId}:${subject.pubkey}`);
          },
        });
      },
    },
  ];
  if (opts.keyvault) extra.push(keyvaultModule(opts.keyvault));
  const idps: unknown[] = [
    { id: 'okta', type: 'oidc', issuer: 'https://okta.example.com', clientId: 'c' },
  ];
  if (opts.idp)
    idps.push({
      id: 'corp-idp',
      type: 'oidc',
      issuer: opts.idp.issuer,
      clientId: opts.idp.clientId,
      clientSecret: opts.idp.clientSecret,
    });
  const h = await makeKernel({
    ...(opts.idp
      ? { fetch: routedFetch({ [new URL(opts.idp.issuer).origin]: opts.idp.app }) }
      : {}),
    extraModules: extra,
    enterprise: {
      relays: ['corp'],
      idps,
      offboarding: { keyDestructionGraceDays: 1 },
    },
  });
  const identity = h.kernel.use<EnterpriseIdentityService>(IDENTITY_SERVICE)!;
  return { h, identity, siem, holdCalls, holds };
}

describe('directory views for compliance and the key vault', () => {
  test('groupsOf / pubkeyOf / members', async () => {
    const { identity } = await setup();
    await identity.store.put(
      binding('alice', { email: 'alice@acme.com', groups: ['grp-1', 'Finance'], scimId: 's-1' }),
    );
    await identity.store.putGroup({
      idp: 'okta',
      id: 'grp-1',
      displayName: 'Legal Team',
      members: ['okta:alice'],
      source: 'scim',
      updatedAt: 1,
    });
    const alice = makeKey();
    await identity.bindPubkey((await identity.store.get('okta:alice'))!, alice.pk, 'self-custody');

    const groups = await identity.groupsOf(alice.pk);
    for (const g of ['grp-1', 'Legal Team', 'legal team', 'Finance', 'finance'])
      expect(groups).toContain(g);
    expect(await identity.groupsOf(makeKey().pk)).toEqual([]);

    expect(await identity.pubkeyOf('alice', 'okta')).toBe(alice.pk);
    expect(await identity.pubkeyOf('okta:alice')).toBe(alice.pk);
    expect(await identity.pubkeyOf('alice')).toBe(alice.pk);
    expect(await identity.pubkeyOf('alice@acme.com')).toBe(alice.pk);
    expect(await identity.pubkeyOf('nobody')).toBeNull();
    expect(await identity.pubkeyOf('alice', 'other-idp')).toBeNull();

    expect(await identity.members()).toEqual([{ pubkey: alice.pk, groups }]);

    // After offboarding the last key still resolves (legal holds, eDiscovery).
    await identity.offboard('okta:alice', 'left');
    expect(await identity.pubkeyOf('alice', 'okta')).toBe(alice.pk);
    expect(await identity.groupsOf(alice.pk)).toContain('Legal Team');
    expect((await identity.members())[0]?.pubkey).toBe(alice.pk);
  });

  test('isSessionActive follows team sessions and the person’s status', async () => {
    const { h, identity } = await setup();
    await identity.store.put(binding('bob', { status: 'active' }));
    const { rec } = await identity.sessions.issue('okta:bob');
    expect(await identity.isSessionActive(rec.sid)).toBe(true);
    expect(await identity.isSessionActive(rec.sid, 'okta:bob')).toBe(true);
    expect(await identity.isSessionActive(rec.sid, 'okta:someone-else')).toBe(false);
    expect(await identity.isSessionActive('nope')).toBe(false);
    h.ports.clock.advance(365 * 86400);
    expect(await identity.isSessionActive(rec.sid)).toBe(false);

    const { rec: again } = await identity.sessions.issue('okta:bob');
    await identity.offboard('okta:bob', 'left');
    expect(await identity.isSessionActive(again.sid)).toBe(false);
  });

  test('key destruction asks lifecycle.holds per relay with { pubkey }', async () => {
    const kv = new FakeKeyVault();
    const { h, identity, holdCalls, holds } = await setup({ keyvault: kv });
    await identity.store.put(binding('emp', { keyModel: 'managed' }));
    const emp = await identity.ensureManaged((await identity.store.get('okta:emp'))!);
    const pk = emp.npub as string;
    await identity.offboard('okta:emp', 'left');
    h.ports.clock.advance(2 * 86400);
    holds.held.add(`public:${pk}`);
    await h.ports.scheduler.tick(MAINTENANCE_JOB);
    expect(kv.destroyed).toEqual([]);
    expect(holdCalls).toContainEqual(['corp', { pubkey: pk }]);
    expect(holdCalls).toContainEqual(['public', { pubkey: pk }]);
    holds.held.clear();
    await h.ports.scheduler.tick(MAINTENANCE_JOB);
    expect(kv.destroyed).toEqual(['okta:emp']);
  });

  test('sign-in and offboarding are recorded for the SIEM export', async () => {
    const idp = await createMockIdp();
    const { h, identity, siem } = await setup({ idp });
    idp.user = { sub: 'carol', claims: { email: 'carol@acme.com', name: 'Carol' } };
    const cb = await ssoLogin(h, idp, 'corp-idp', 'team');
    expect(cb.status).toBe(302);
    expect(siem.at(-1)).toMatchObject({
      stream: 'auth',
      type: 'sso.sign-in',
      data: { idp: 'corp-idp', binding: 'corp-idp:carol', audience: 'team' },
    });
    expect(siem.at(-1)?.summary).toContain('Carol');

    const carol = makeKey();
    await identity.bindPubkey(
      (await identity.store.get('corp-idp:carol'))!,
      carol.pk,
      'self-custody',
    );
    await identity.offboard('corp-idp:carol', 'Left the company');
    expect(siem.at(-1)).toMatchObject({
      stream: 'auth',
      type: 'identity.offboarded',
      data: { binding: 'corp-idp:carol', status: 'suspended', pubkey: carol.pk },
    });
  });
});
