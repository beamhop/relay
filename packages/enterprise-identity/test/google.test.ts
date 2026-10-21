// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeKey } from '@beamhop/testkit';
import { Hono } from 'hono';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import {
  DIRECTORY_SCOPES,
  type EnterpriseIdentityService,
  GOOGLE_SYNC_JOB,
  type GoogleUser,
  IDENTITY_SERVICE,
  enterpriseRuntime,
} from '../src/index.ts';
import { makeKernel, routedFetch, runAction } from './helpers.ts';

async function mockGoogle() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  const state = {
    users: [] as GoogleUser[],
    groups: [] as Array<{ id: string; email: string; name: string; members: string[] }>,
    tokenCalls: 0,
    usersCalls: 0,
  };
  const oauth = new Hono();
  oauth.post('/token', async (c) => {
    state.tokenCalls++;
    const form = await c.req.parseBody();
    if (form.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      return c.json({ error: 'unsupported_grant_type' }, 400);
    try {
      const { payload } = await jwtVerify(String(form.assertion), publicKey, {
        audience: 'https://oauth2.googleapis.com/token',
        issuer: 'sync@acme.iam.gserviceaccount.com',
        // The kernel runs on the testkit FakeClock.
        currentDate: new Date(1_700_000_000_000 + 60_000),
      });
      if (payload.sub !== 'admin@acme.com') return c.json({ error: 'bad sub' }, 400);
      if (payload.scope !== DIRECTORY_SCOPES.join(' ')) return c.json({ error: 'scope' }, 400);
    } catch {
      return c.json({ error: 'invalid_grant' }, 400);
    }
    return c.json({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' });
  });
  const api = new Hono();
  api.use('*', async (c, next) => {
    if (c.req.header('authorization') !== 'Bearer ya29.test') return c.json({}, 401);
    await next();
  });
  // Two pages of users to exercise pagination.
  api.get('/admin/directory/v1/users', (c) => {
    state.usersCalls++;
    const page = c.req.query('pageToken') === 'p2' ? 1 : 0;
    const size = Number(c.req.query('maxResults')) === 1 ? 1 : 2;
    const slice = state.users.slice(page * size, page * size + size);
    const more = size === 2 && page === 0 && state.users.length > 2;
    return c.json({ users: slice, ...(more ? { nextPageToken: 'p2' } : {}) });
  });
  api.get('/admin/directory/v1/groups', (c) =>
    c.json({ groups: state.groups.map(({ members: _m, ...g }) => g) }),
  );
  api.get('/admin/directory/v1/groups/:id/members', (c) => {
    const g = state.groups.find((x) => x.id === c.req.param('id'));
    return c.json({ members: (g?.members ?? []).map((id) => ({ id, type: 'USER' })) });
  });
  return { pem, state, oauth, api };
}

function guser(id: string, email: string, extra: Partial<GoogleUser> = {}): GoogleUser {
  return {
    id,
    primaryEmail: email,
    name: { fullName: email.split('@')[0], givenName: 'G', familyName: 'U' },
    organizations: [{ title: 'Engineer', department: 'R&D', primary: true }],
    ...extra,
  };
}

describe('Google directory sync', () => {
  test('service-account JWT, pagination, delta detection, suspension → offboarding', async () => {
    const g = await mockGoogle();
    const fetch = routedFetch({
      'https://oauth2.googleapis.com': g.oauth,
      'https://admin.googleapis.com': g.api,
    });
    const h = await makeKernel({
      fetch,
      enterprise: {
        relays: ['corp'],
        idps: [{ id: 'google', type: 'google', clientId: 'c', hostedDomain: 'acme.com' }],
        google: {
          directorySync: {
            enabled: true,
            serviceAccountEmail: 'sync@acme.iam.gserviceaccount.com',
            privateKey: g.pem,
            adminEmail: 'admin@acme.com',
          },
        },
      },
    });
    const identity = h.kernel.use<EnterpriseIdentityService>(IDENTITY_SERVICE);
    const rt = enterpriseRuntime(h.kernel);
    if (!identity || !rt) throw new Error('not registered');
    expect(h.ports.scheduler.jobs.has(GOOGLE_SYNC_JOB)).toBe(true);

    g.state.users = [
      guser('100', 'alice@acme.com', {
        relations: [{ type: 'manager', value: 'carol@acme.com' }],
      }),
      guser('200', 'bob@acme.com'),
      guser('300', 'carol@acme.com'),
    ];
    g.state.groups = [
      { id: 'g1', email: 'eng@acme.com', name: 'Engineering', members: ['100', '200'] },
    ];
    await runAction(h.kernel, 'enterprise.map-group', {
      idp: 'google',
      group: 'eng@acme.com',
      relays: [{ relayId: 'corp', access: 'write' }],
      tier: 'staff',
    });

    const r1 = await rt.google.run();
    expect(r1.users).toEqual({ seen: 3, created: 3, updated: 0, unchanged: 0 });
    expect(r1.groups).toEqual({ seen: 1, changed: 1, removed: 0 });
    expect(g.state.tokenCalls).toBe(1);
    const alice = await identity.store.get('google:100');
    expect(alice).toMatchObject({
      email: 'alice@acme.com',
      title: 'Engineer',
      department: 'R&D',
      manager: 'carol@acme.com',
      groups: ['g1'],
      source: 'google',
    });

    // Nothing changed → nothing written (token is cached too).
    const r2 = await h.kernel.actions.get('enterprise.sync-directory')!.run(
      {},
      {
        principal: { id: 'o', roles: { '*': 'owner' }, via: 'cli' },
        relayId: null,
        ports: h.kernel.ports,
      },
    );
    expect((r2.output as typeof r1).users.unchanged).toBe(3);
    expect(g.state.tokenCalls).toBe(1);

    // Alice links a key and gets access via the group mapping; Carol (her manager) too.
    const ak = makeKey();
    await identity.bindPubkey((await identity.store.get('google:100'))!, ak.pk, 'self-custody');
    const ck = makeKey();
    await identity.bindPubkey((await identity.store.get('google:300'))!, ck.pk, 'self-custody');
    const resolver = h.kernel.access[0];
    expect(await resolver?.canWrite?.('corp', ak.pk)).toBe(true);
    expect(await resolver?.tierOf?.('corp', ak.pk)).toBe('staff');
    // Carol is not in a mapped group → no access on corp.
    expect(await resolver?.canWrite?.('corp', ck.pk)).toBe(false);

    // A login from the same Google account maps onto the synced record (sub == user id).
    expect((await identity.store.get('google:100'))?.npub).toBe(ak.pk);

    // Suspend Alice in Google; delete Bob.
    g.state.users = [
      guser('100', 'alice@acme.com', {
        suspended: true,
        relations: [{ type: 'manager', value: 'carol@acme.com' }],
      }),
      guser('300', 'carol@acme.com'),
    ];
    g.state.groups = [{ id: 'g1', email: 'eng@acme.com', name: 'Engineering', members: ['100'] }];
    const r3 = await rt.google.run();
    expect(r3.suspended).toBe(1);
    expect(r3.deleted).toBe(1);
    expect((await identity.store.get('google:100'))?.status).toBe('suspended');
    expect((await identity.store.get('google:200'))?.status).toBe('deleted');
    expect(await resolver?.canWrite?.('corp', ak.pk)).toBe(false);

    // Unsuspend → pending again.
    g.state.users[0] = guser('100', 'alice@acme.com', {
      relations: [{ type: 'manager', value: 'carol@acme.com' }],
    });
    const r4 = await rt.google.run();
    expect(r4.reactivated).toBe(1);
    expect((await identity.store.get('google:100'))?.status).toBe('pending');

    // Group removed in Google.
    g.state.groups = [];
    const r5 = await rt.google.run();
    expect(r5.groups.removed).toBe(1);
  });

  test('test-connection exercises the Google directory', async () => {
    const g = await mockGoogle();
    const h = await makeKernel({
      fetch: routedFetch({
        'https://oauth2.googleapis.com': g.oauth,
        'https://admin.googleapis.com': g.api,
      }),
      enterprise: {
        idps: [{ id: 'google', type: 'google', clientId: 'c' }],
        google: {
          directorySync: {
            enabled: true,
            serviceAccountEmail: 'sync@acme.iam.gserviceaccount.com',
            privateKey: g.pem,
            adminEmail: 'admin@acme.com',
          },
        },
      },
    });
    const out = (await runAction(h.kernel, 'enterprise.test-connection', { idp: 'google' }))
      .output as { checks: Array<{ name: string; ok: boolean }> };
    expect(out.checks.find((c) => c.name === 'directory')?.ok).toBe(true);
    // Discovery for accounts.google.com is not routed (no network in tests).
    expect(out.checks.find((c) => c.name === 'sign-in')?.ok).toBe(false);
  });
});
