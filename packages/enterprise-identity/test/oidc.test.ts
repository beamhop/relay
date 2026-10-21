// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeEvent, makeKey } from '@beamhop/testkit';
import { type EnterpriseIdentityService, IDENTITY_SERVICE } from '../src/index.ts';
import {
  FakeKeyVault,
  type MockIdp,
  cookieFrom,
  createMockIdp,
  keyvaultModule,
  makeKernel,
  routedFetch,
  runAction,
  ssoLogin,
} from './helpers.ts';

async function setup(
  opts: { keyvault?: FakeKeyVault; type?: 'oidc' | 'google' | 'microsoft'; hd?: string } = {},
) {
  const issuer = opts.type === 'microsoft' ? 'https://login.example.com/tenant-1/v2.0' : undefined;
  const idp: MockIdp = await createMockIdp(issuer);
  const fetch = routedFetch({ [new URL(idp.issuer).origin]: idp.app });
  const h = await makeKernel({
    fetch,
    extraModules: opts.keyvault ? [keyvaultModule(opts.keyvault)] : [],
    enterprise: {
      relays: ['corp'],
      idps: [
        {
          id: 'corp-idp',
          type: opts.type ?? 'oidc',
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: idp.clientSecret,
          ...(opts.hd ? { hostedDomain: opts.hd } : {}),
        },
      ],
      nip05: { domain: 'acme.com' },
    },
  });
  const identity = h.kernel.use<EnterpriseIdentityService>(IDENTITY_SERVICE);
  if (!identity) throw new Error('module not registered');
  return { h, idp, fetch, identity };
}

describe('OIDC sign-in', () => {
  test('team login, PKCE code flow, then self-custody linking with a signed challenge', async () => {
    const { h, idp, identity } = await setup();
    idp.user = {
      sub: 'alice-sub',
      claims: { email: 'Alice@acme.com', email_verified: true, name: 'Alice', groups: ['eng'] },
    };
    const start = await h.req('/api/v1/sso/corp-idp/start?audience=team');
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location') as string);
    expect(loc.origin).toBe('https://idp.example.com');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe(
      'https://relay.example.com/api/v1/sso/corp-idp/callback',
    );

    const cb = await ssoLogin(h, idp, 'corp-idp', 'team');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/app');
    const team = cookieFrom(cb, 'bh_team');
    expect(team).toBeTruthy();
    const cookie = `bh_team=${team}`;

    const b = await identity.store.get('corp-idp:alice-sub');
    expect(b?.email).toBe('alice@acme.com');
    expect(b?.groups).toEqual(['eng']);
    expect(b?.status).toBe('pending');

    // No key yet: the team client must link one.
    const s1 = await h.req('/api/v1/team/session', { method: 'POST', cookie });
    expect(await s1.json()).toMatchObject({ mode: 'link-required' });

    const ch = (await (await h.req('/api/v1/team/link', { cookie })).json()) as {
      challenge: string;
    };
    const key = makeKey();
    const ev = makeEvent(key, {
      kind: 22242,
      tags: [
        ['challenge', ch.challenge],
        ['relay', 'wss://relay.example.com'],
      ],
      content: '',
      created_at: h.ports.clock.now(),
    });
    const link = await h.req('/api/v1/team/link', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: ev }),
    });
    expect(link.status).toBe(200);
    expect(await link.json()).toEqual({ mode: 'self-custody', pubkey: key.pk });

    // Replay of the same challenge fails.
    const again = await h.req('/api/v1/team/link', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: ev }),
    });
    expect(again.status).toBe(400);

    const s2 = await h.req('/api/v1/team/session', { method: 'POST', cookie });
    expect(await s2.json()).toEqual({ mode: 'self-custody', pubkey: key.pk });

    // Profile suggestion for self-custody users.
    const prof = (await (await h.req('/api/v1/team/profile', { cookie })).json()) as {
      profile: Record<string, string>;
    };
    expect(prof.profile).toMatchObject({ name: 'Alice', nip05: 'alice@acme.com' });
  });

  test('challenge signed by a forged event or wrong kind is rejected', async () => {
    const { h, idp } = await setup();
    idp.user = { sub: 'bob', claims: { email: 'bob@acme.com' } };
    const cb = await ssoLogin(h, idp, 'corp-idp', 'team');
    const cookie = `bh_team=${cookieFrom(cb, 'bh_team')}`;
    const ch = (await (await h.req('/api/v1/team/link', { cookie })).json()) as {
      challenge: string;
    };
    const key = makeKey();
    const post = (event: unknown) =>
      h.req('/api/v1/team/link', {
        method: 'POST',
        cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event }),
      });
    const wrongKind = makeEvent(key, {
      kind: 1,
      tags: [['challenge', ch.challenge]],
      created_at: h.ports.clock.now(),
    });
    expect((await post(wrongKind)).status).toBe(400);
    const good = makeEvent(key, {
      kind: 27235,
      tags: [['challenge', ch.challenge]],
      created_at: h.ports.clock.now(),
    });
    expect((await post({ ...good, content: 'tampered' })).status).toBe(400);
    expect((await post(good)).status).toBe(200);
  });

  test('state cookie must match (login CSRF) and nonce is validated', async () => {
    const { h, idp } = await setup();
    idp.user = { sub: 'carol', claims: { email: 'carol@acme.com' } };
    const start = await h.req('/api/v1/sso/corp-idp/start?audience=team');
    const auth = await idp.app.fetch(new Request(start.headers.get('location') as string));
    const cb = new URL(auth.headers.get('location') as string);
    const noCookie = await h.req(`${cb.pathname}${cb.search}`);
    expect(noCookie.status).toBe(400);

    idp.wrongNonce = true;
    const res = await ssoLogin(h, idp, 'corp-idp', 'team');
    expect(res.status).toBe(400);
    expect(cookieFrom(res, 'bh_team')).toBeUndefined();
  });

  test('admin login issues an admin session with roles from group mapping', async () => {
    const { h, idp } = await setup();
    await runAction(h.kernel, 'enterprise.map-group', {
      idp: 'corp-idp',
      group: 'it-admins',
      relays: [],
      adminRole: 'admin',
      channel: false,
    });
    idp.user = { sub: 'dave', claims: { email: 'dave@acme.com', groups: ['IT-Admins'] } };
    const res = await ssoLogin(h, idp, 'corp-idp', 'admin');
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') as string;
    expect(loc.startsWith('/admin#')).toBe(true);
    const token = new URLSearchParams(loc.split('#')[1]).get('sso_token');
    expect(token).toBeTruthy();
    const me = await h.req('/api/v1/nodes/n1/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { id: string; roles: Record<string, string> };
    expect(body.id).toBe('sso:corp-idp:dave');
    expect(body.roles['*']).toBe('admin');

    // Someone without an admin group is refused.
    idp.user = { sub: 'erin', claims: { email: 'erin@acme.com', groups: ['sales'] } };
    const denied = await ssoLogin(h, idp, 'corp-idp', 'admin');
    expect(denied.status).toBe(403);
  });

  test('managed key model with keyvault returns a bunker URL; without keyvault degrades', async () => {
    const kv = new FakeKeyVault();
    const { h, idp, identity } = await setup({ keyvault: kv });
    await runAction(h.kernel, 'enterprise.map-group', {
      group: 'everyone',
      relays: [{ relayId: 'corp', access: 'write' }],
      keyModel: 'managed',
      channel: false,
    });
    idp.user = {
      sub: 'frank',
      claims: { email: 'frank@acme.com', name: 'Frank', groups: ['everyone'] },
    };
    const cb = await ssoLogin(h, idp, 'corp-idp', 'team');
    const cookie = `bh_team=${cookieFrom(cb, 'bh_team')}`;
    const s = (await (await h.req('/api/v1/team/session', { method: 'POST', cookie })).json()) as {
      mode: string;
      pubkey: string;
      bunkerUrl: string;
    };
    expect(s.mode).toBe('managed');
    expect(s.pubkey).toBe(await kv.ensureKey('corp-idp:frank'));
    expect(s.bunkerUrl.startsWith('bunker://')).toBe(true);
    // Profile published as kind 0 signed by the keyvault.
    const profiles = await h.kernel.ports.events.query('corp', [
      { kinds: [0], authors: [s.pubkey] },
    ]);
    expect(profiles.length).toBe(1);
    expect(JSON.parse(profiles[0]?.content ?? '{}')).toMatchObject({
      name: 'Frank',
      nip05: 'frank@acme.com',
    });
    expect((await identity.store.get('corp-idp:frank'))?.keyModel).toBe('managed');

    // Without a keyvault the same mapping degrades to self-custody linking.
    const plain = await setup();
    await runAction(plain.h.kernel, 'enterprise.map-group', {
      group: 'everyone',
      keyModel: 'managed',
      channel: false,
    });
    plain.idp.user = { sub: 'gina', claims: { email: 'gina@acme.com', groups: ['everyone'] } };
    const cb2 = await ssoLogin(plain.h, plain.idp, 'corp-idp', 'team');
    const s2 = await plain.h.req('/api/v1/team/session', {
      method: 'POST',
      cookie: `bh_team=${cookieFrom(cb2, 'bh_team')}`,
    });
    expect(await s2.json()).toMatchObject({ mode: 'link-required' });
  });

  test('Google hosted domain is enforced on the hd claim', async () => {
    const { h, idp } = await setup({ type: 'google', hd: 'acme.com' });
    const start = await h.req('/api/v1/sso/corp-idp/start?audience=team');
    expect(new URL(start.headers.get('location') as string).searchParams.get('hd')).toBe(
      'acme.com',
    );
    idp.user = { sub: 'g-1', claims: { email: 'x@evil.com', hd: 'evil.com' } };
    expect((await ssoLogin(h, idp, 'corp-idp', 'team')).status).toBe(400);
    idp.user = { sub: 'g-2', claims: { email: 'y@acme.com', hd: 'acme.com' } };
    expect((await ssoLogin(h, idp, 'corp-idp', 'team')).status).toBe(302);
  });

  test('Microsoft: oid is the stable subject and group overage keeps provisioned groups', async () => {
    const { h, idp, identity } = await setup({ type: 'microsoft' });
    idp.user = {
      sub: 'pairwise-sub',
      claims: {
        oid: '11111111-2222-3333-4444-555555555555',
        preferred_username: 'Hank@acme.com',
        _claim_names: { groups: 'src1' },
      },
    };
    const res = await ssoLogin(h, idp, 'corp-idp', 'team');
    expect(res.status).toBe(302);
    const b = await identity.store.get('corp-idp:11111111-2222-3333-4444-555555555555');
    expect(b?.email).toBe('hank@acme.com');
    expect(b?.groups).toEqual([]);
  });

  test('providers list and app config only advertise team providers', async () => {
    const { h } = await setup();
    const cfg = (await (await h.req('/app/config.json')).json()) as {
      features: Record<string, boolean>;
    };
    expect(cfg.features).toEqual({ sso: true, directory: true, escrowNotice: false });
    const providers = (await (await h.req('/api/v1/sso/providers')).json()) as {
      providers: Array<{ id: string }>;
    };
    expect(providers.providers.map((p) => p.id)).toEqual(['corp-idp']);
    expect(h.kernel.authProviders.some((p) => p.id === 'enterprise-sso')).toBe(true);
  });
});
