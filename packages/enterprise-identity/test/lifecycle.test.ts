// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { RelayId } from '@beamhop/core';
import type { PolicyService } from '@beamhop/policy';
import type { GroupsService } from '@beamhop/relay';
import { makeKey } from '@beamhop/testkit';
import {
  type Binding,
  type EnterpriseIdentityService,
  IDENTITY_SERVICE,
  MAINTENANCE_JOB,
} from '../src/index.ts';
import { FakeKeyVault, keyvaultModule, makeKernel, runAction } from './helpers.ts';

function binding(idp: string, subject: string, extra: Partial<Binding> = {}): Binding {
  return {
    idp,
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

async function setup(
  extra: { keyvault?: FakeKeyVault; held?: boolean; owner?: string; unbound?: string } = {},
) {
  const holds = { held: extra.held ?? false };
  const h = await makeKernel({
    ...(extra.owner ? { ownerPubkey: extra.owner } : {}),
    extraModules: [
      ...(extra.keyvault ? [keyvaultModule(extra.keyvault)] : []),
      {
        id: 'lifecycle-fake',
        register(k) {
          k.provide('lifecycle.holds', { isHeld: async () => holds.held });
        },
      },
    ],
    enterprise: {
      relays: ['corp'],
      idps: [{ id: 'okta', type: 'oidc', issuer: 'https://okta.example.com', clientId: 'c' }],
      nip05: { domain: 'acme.com' },
      offboarding: { keyDestructionGraceDays: 7 },
      ...(extra.unbound ? { unboundAccess: extra.unbound } : {}),
    },
  });
  const identity = h.kernel.use<EnterpriseIdentityService>(IDENTITY_SERVICE);
  if (!identity) throw new Error('not registered');
  return { h, identity, holds };
}

async function person(
  identity: EnterpriseIdentityService,
  subject: string,
  extra: Partial<Binding> = {},
) {
  await identity.store.put(binding('okta', subject, extra));
  const k = makeKey();
  const b = await identity.store.get(`okta:${subject}`);
  await identity.bindPubkey(b!, k.pk, extra.keyModel ?? 'self-custody');
  return k;
}

describe('access resolver', () => {
  test('decides on enterprise relays only; first in chain; owner and unbound handling', async () => {
    const owner = makeKey();
    const { h, identity } = await setup({ owner: owner.pk });
    const r = h.kernel.access[0];
    expect(r?.id).toBe('enterprise.binding');
    const alice = await person(identity, 'alice', { email: 'alice@acme.com' });
    const stranger = makeKey();

    expect(await r?.canWrite?.('corp', alice.pk)).toBe(true);
    expect(await r?.canRead?.('corp', alice.pk)).toBe(true);
    expect(await r?.canWrite?.('corp', stranger.pk)).toBe(false);
    expect(await r?.canRead?.('corp', null)).toBe(false);
    // Relay owner: abstain so the normal rules apply.
    expect(await r?.canWrite?.('corp', owner.pk)).toBeUndefined();
    // Other relays: abstain.
    expect(await r?.canWrite?.('public', alice.pk)).toBeUndefined();
    expect(await r?.canRead?.('public', stranger.pk)).toBeUndefined();
    expect(await r?.tierOf?.('public', alice.pk)).toBeUndefined();

    // A pubkey on the policy allowlist is still refused once revoked.
    const policy = h.kernel.use<PolicyService>('policy');
    await policy?.state.allow('corp', {
      pubkey: alice.pk,
      addedAt: 1,
      addedBy: 'x',
    } as never);
    await identity.offboard('okta:alice', 'test');
    expect(await r?.canWrite?.('corp', alice.pk)).toBe(false);
  });

  test('group mappings: read vs write, tier precedence, defer mode', async () => {
    const { h, identity } = await setup({ unbound: 'defer' });
    const r = h.kernel.access[0];
    await runAction(h.kernel, 'enterprise.map-group', {
      idp: 'okta',
      group: 'readers',
      relays: [{ relayId: 'corp', access: 'read' }],
      tier: 'staff',
    });
    await runAction(h.kernel, 'enterprise.map-group', {
      idp: '*',
      group: 'execs',
      relays: [{ relayId: 'corp', access: 'write' }],
      tier: 'exec',
    });
    const reader = await person(identity, 'r1', { groups: ['readers'] });
    const exec = await person(identity, 'e1', { groups: ['readers', 'execs'] });
    const nobody = await person(identity, 'n1', { groups: ['other'] });
    expect(await r?.canRead?.('corp', reader.pk)).toBe(true);
    expect(await r?.canWrite?.('corp', reader.pk)).toBe(false);
    expect(await r?.tierOf?.('corp', reader.pk)).toBe('staff');
    expect(await r?.canWrite?.('corp', exec.pk)).toBe(true);
    expect(await r?.tierOf?.('corp', exec.pk)).toBe('exec');
    expect(await r?.canWrite?.('corp', nobody.pk)).toBe(false);
    // Unbound strangers: defer to other resolvers.
    expect(await r?.canWrite?.('corp', makeKey().pk)).toBeUndefined();

    const list = await runAction(h.kernel, 'enterprise.list-mappings', {});
    expect((list.output as { mappings: Array<{ people: number }> }).mappings.length).toBe(2);
  });

  test('map-group preview and undo', async () => {
    const { h, identity } = await setup();
    await person(identity, 'p1', { groups: ['eng'] });
    const a = h.kernel.actions.get('enterprise.map-group');
    const input = a!.input.parse({ idp: 'okta', group: 'eng', adminRole: 'owner' });
    const ctx = {
      principal: { id: 'o', roles: { '*': 'owner' as const }, via: 'cli' as const },
      relayId: null,
      ports: h.kernel.ports,
    };
    const lines = await a!.preview!(input, ctx);
    expect(lines.some((l) => l.kind === 'add')).toBe(true);
    expect(lines.some((l) => l.text.includes('1 person'))).toBe(true);
    expect(lines.some((l) => l.kind === 'warning')).toBe(true);
    const res = await a!.run(input, ctx);
    expect(await identity.store.getMapping('okta', 'eng')).not.toBeNull();
    await a!.undo!(res.undo!.payload, ctx);
    expect(await identity.store.getMapping('okta', 'eng')).toBeNull();
  });
});

describe('offboarding cascade', () => {
  test('revokes access, admin, allowlist, groups (to manager), blobs, sessions, schedules key destruction', async () => {
    const kv = new FakeKeyVault();
    const { h, identity, holds } = await setup({ keyvault: kv });
    const k = h.kernel;
    const manager = await person(identity, 'mgr', { email: 'boss@acme.com' });
    // Managed-key employee whose manager is boss@acme.com.
    await identity.store.put(
      binding('okta', 'emp', {
        email: 'emp@acme.com',
        manager: 'boss@acme.com',
        keyModel: 'managed',
      }),
    );
    const emp = await identity.ensureManaged((await identity.store.get('okta:emp'))!);
    const pk = emp.npub as string;
    expect(pk).toBe(await kv.ensureKey('okta:emp'));

    // Admin record via SSO + legacy nostr admin record for the same key.
    await runAction(k, 'enterprise.map-group', {
      idp: 'okta',
      group: 'admins',
      adminRole: 'admin',
    });
    await identity.store.put({ ...(await identity.store.get('okta:emp'))!, groups: ['admins'] });
    const session = await identity.issueAdminSession((await identity.store.get('okta:emp'))!);
    const me = () =>
      k.http.fetch(
        new Request('https://relay.example.com/api/v1/nodes/n1/auth/me', {
          headers: { authorization: `Bearer ${session.token}` },
        }),
      );
    expect((await me()).status).toBe(200);
    const dir = k.use<{ put(r: unknown): Promise<void> }>('admin.directory');
    await dir?.put({ id: 'someone-else', roles: { '*': 'owner' }, createdAt: 1, createdBy: 'x' });
    await dir?.put({
      id: pk,
      pubkey: pk,
      roles: { corp: 'moderator' },
      createdAt: 1,
      createdBy: 'x',
    });

    // Allowlist, NIP-29 groups, blobs, team session.
    const policy = k.use<PolicyService>('policy');
    await policy?.state.allow('corp', { pubkey: pk, addedAt: 1, addedBy: 'x' } as never);
    const groups = k.use<GroupsService>('relay.groups') as GroupsService;
    await groups.create('corp' as RelayId, {
      id: 'team-a',
      name: 'Team A',
      members: [{ pubkey: pk, roles: ['admin'] }, { pubkey: manager.pk }],
    });
    await groups.create('corp', { id: 'team-b', name: 'Team B', members: [{ pubkey: pk }] });
    await k.ports.blobIndex.addOwner({
      relayId: 'corp',
      sha256: 'a'.repeat(64),
      pubkey: pk,
      size: 3,
      type: 'text/plain',
      uploadedAt: 1,
    });
    await identity.sessions.issue('okta:emp');
    const disconnected: string[] = [];
    k.provide('relay.engine', {
      ...(k.use('relay.engine') as object),
      disconnectPubkey: (p: string) => {
        disconnected.push(p);
        return 2;
      },
    });

    const report = await identity.offboard('okta:emp', 'Left the company');
    expect(report).toMatchObject({
      pubkey: pk,
      adminRevoked: true,
      sessionsClosed: 1,
      connectionsClosed: 2,
      allowlistsLeft: 1,
      groupsTransferred: 1,
      groupsLeft: 2,
      blobsTransferred: 1,
      successor: manager.pk,
    });
    expect(disconnected).toEqual([pk]);
    expect(kv.revoked).toEqual(['okta:emp']);
    expect((await me()).status).toBe(401);
    expect(await policy?.state.isAllowlisted('corp', pk)).toBe(false);
    const a = await groups.get('corp', 'team-a');
    expect(a?.members[pk]).toBeUndefined();
    expect(a?.members[manager.pk]).toEqual(['admin']);
    expect((await groups.get('corp', 'team-b'))?.members[pk]).toBeUndefined();
    expect((await k.ports.blobIndex.owners('corp', 'a'.repeat(64))).map((o) => o.pubkey)).toEqual([
      manager.pk,
    ]);
    expect(await k.access[0]?.canWrite?.('corp', pk)).toBe(false);
    expect(await k.access[0]?.canRead?.('corp', pk)).toBe(false);

    // Key destruction waits for the grace period and respects legal holds.
    expect(report.keyDestructionAt).toBe(k.ports.clock.now() + 7 * 86400);
    const sched = (k.ports as unknown as { scheduler: { tick(n: string): Promise<void> } })
      .scheduler;
    await sched.tick(MAINTENANCE_JOB);
    expect(kv.destroyed).toEqual([]);
    (k.ports.clock as unknown as { advance(s: number): void }).advance(8 * 86400);
    holds.held = true;
    await sched.tick(MAINTENANCE_JOB);
    expect(kv.destroyed).toEqual([]);
    holds.held = false;
    await sched.tick(MAINTENANCE_JOB);
    expect(kv.destroyed).toEqual(['okta:emp']);

    // Idempotent.
    const again = await identity.offboard('okta:emp', 'again');
    expect(again.groupsLeft).toBe(0);
  });

  test('manual offboard action with preview', async () => {
    const { h, identity } = await setup();
    const k = await person(identity, 'zed', { email: 'zed@acme.com' });
    const prev = await h.kernel.actions.get('enterprise.offboard-person')!.preview!(
      { person: 'zed@acme.com' },
      {
        principal: { id: 'o', roles: { '*': 'owner' }, via: 'cli' },
        relayId: null,
        ports: h.kernel.ports,
      },
    );
    expect(prev[0]?.kind).toBe('remove');
    await runAction(h.kernel, 'enterprise.offboard-person', { person: 'zed@acme.com' });
    expect(await h.kernel.access[0]?.canWrite?.('corp', k.pk)).toBe(false);
  });
});

describe('company identity', () => {
  test('NIP-05 from bindings, directory, contacts, NIP-29 channel sync', async () => {
    const { h, identity } = await setup();
    await runAction(h.kernel, 'enterprise.map-group', {
      idp: 'okta',
      group: 'Design Team',
      relays: [{ relayId: 'corp', access: 'write' }],
      channel: true,
    });
    const alice = await person(identity, 'a', {
      email: 'alice@acme.com',
      name: 'Alice',
      title: 'Designer',
      groups: ['Design Team'],
    });
    const bob = await person(identity, 'b', {
      email: 'bob@acme.com',
      name: 'Bob',
      groups: ['Design Team'],
    });
    await person(identity, 'c', { email: 'carol@other.org', name: 'Carol' });

    const one = await h.req('/.well-known/nostr.json?name=alice');
    expect(one.headers.get('access-control-allow-origin')).toBe('*');
    expect(await one.json()).toEqual({
      names: { alice: alice.pk },
      relays: { [alice.pk]: ['wss://relay.example.com'] },
    });
    const all = (await (await h.req('/.well-known/nostr.json')).json()) as {
      names: Record<string, string>;
    };
    expect(all.names).toEqual({ alice: alice.pk, bob: bob.pk });
    expect(await (await h.req('/.well-known/nostr.json?name=nobody')).json()).toEqual({
      names: {},
      relays: {},
    });

    // Channel synced from the IdP group.
    const groups = h.kernel.use<GroupsService>('relay.groups') as GroupsService;
    const ch = await groups.get('corp', 'design-team');
    expect(ch?.name).toBe('Design Team');
    expect(Object.keys(ch?.members ?? {}).sort()).toEqual([alice.pk, bob.pk].sort());

    // Offboarding Bob updates NIP-05 and the channel.
    await identity.offboard('okta:b', 'left');
    expect(
      ((await (await h.req('/.well-known/nostr.json')).json()) as { names: object }).names,
    ).toEqual({ alice: alice.pk });
    expect(Object.keys((await groups.get('corp', 'design-team'))?.members ?? {})).toEqual([
      alice.pk,
    ]);

    // Directory & contacts need a team session.
    expect((await h.req('/api/v1/team/directory')).status).toBe(401);
    const { token } = await identity.sessions.issue('okta:a');
    const dirRes = await h.req('/api/v1/team/directory', { cookie: `bh_team=${token}` });
    const people = ((await dirRes.json()) as { people: Array<{ name: string; title?: string }> })
      .people;
    expect(people.map((p) => p.name)).toEqual(['Alice', 'Carol']);
    expect(people[0]?.title).toBe('Designer');
    const contacts = (await (
      await h.req('/api/v1/team/contacts', { cookie: `bh_team=${token}` })
    ).json()) as { team: string[]; org: string[]; template: { kind: number } };
    expect(contacts.team).toEqual([]);
    expect(contacts.org.length).toBe(1);
    expect(contacts.template.kind).toBe(3);

    // Suspended people's sessions stop working.
    await identity.offboard('okta:a', 'left');
    expect((await h.req('/api/v1/team/directory', { cookie: `bh_team=${token}` })).status).toBe(
      401,
    );
  });

  test('connect-idp returns copy-paste values and test-connection reports', async () => {
    const { h } = await setup();
    const out = (await runAction(h.kernel, 'enterprise.connect-idp', { provider: 'microsoft' }))
      .output as {
      idp: string;
      steps: Array<{ title: string; copy?: Record<string, string> }>;
      values: { redirectUri: string; scimUrl: string; scimToken: string };
    };
    expect(out.idp).toBe('entra');
    expect(out.values.redirectUri).toBe('https://relay.example.com/api/v1/sso/entra/callback');
    expect(out.values.scimUrl).toBe('https://relay.example.com/scim/v2');
    expect(out.values.scimToken.startsWith('bhscim_')).toBe(true);
    expect(out.steps.some((s) => s.copy?.['Tenant URL'] === out.values.scimUrl)).toBe(true);
    const google = (await runAction(h.kernel, 'enterprise.connect-idp', { provider: 'google' }))
      .output as { values: Record<string, string> };
    expect(google.values.scimToken).toBeUndefined();

    const t = (await runAction(h.kernel, 'enterprise.test-connection', { idp: 'okta' })).output as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
    };
    // No network in tests: discovery fails, and there is no SCIM token for okta.
    expect(t.ok).toBe(false);
    expect(t.checks.map((c) => c.name)).toEqual(['sign-in', 'provisioning']);
  });
});
