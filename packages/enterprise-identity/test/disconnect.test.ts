// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type ActionContext, type Principal, can } from '@beamhop/core';
import { type EnterpriseIdentityService, IDENTITY_SERVICE } from '../src/index.ts';
import type { AdminDirectoryLike } from '../src/services.ts';
import { cookieFrom, createMockIdp, makeKernel, routedFetch, ssoLogin } from './helpers.ts';

const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };

async function setup() {
  const idp = await createMockIdp();
  const fetch = routedFetch({ [new URL(idp.issuer).origin]: idp.app });
  const h = await makeKernel({
    fetch,
    enterprise: {
      relays: ['corp'],
      idps: [
        { id: 'other', type: 'google', clientId: 'g' },
        {
          id: 'corp-idp',
          type: 'oidc',
          label: 'Sign in with Acme',
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: idp.clientSecret,
        },
      ],
    },
  });
  const identity = h.kernel.use<EnterpriseIdentityService>(IDENTITY_SERVICE);
  if (!identity) throw new Error('module not registered');
  const def = h.kernel.actions.get('enterprise.disconnect-idp');
  if (!def) throw new Error('action not registered');
  const ctx: ActionContext = { principal: OWNER, relayId: null, ports: h.kernel.ports };
  return { h, idp, identity, def, ctx };
}

describe('enterprise.disconnect-idp', () => {
  test('preview, run (versioned config change, sessions end) and undo', async () => {
    const { h, idp, identity, def, ctx } = await setup();
    idp.user = {
      sub: 'alice-sub',
      claims: { email: 'alice@acme.com', email_verified: true, name: 'Alice' },
    };
    const cb = await ssoLogin(h, idp, 'corp-idp', 'team');
    expect(cookieFrom(cb, 'bh_team')).toBeTruthy();
    expect(await identity.sessions.list('corp-idp:alice-sub')).toHaveLength(1);
    const dir = h.kernel.use<AdminDirectoryLike>('admin.directory');
    if (!dir) throw new Error('no admin directory');
    await dir.put({
      id: 'sso:corp-idp:bob-sub',
      roles: { '*': 'admin' },
      createdAt: 1,
      createdBy: 'enterprise-identity',
    });
    const cfgSvc = h.kernel.use<{ current(): Promise<{ revision: number }> }>('admin.config');
    if (!cfgSvc) throw new Error('no admin.config');
    const rev0 = (await cfgSvc.current()).revision;

    const input = def.input.parse({ provider: 'corp-idp' });
    const lines = await def.preview?.(input, ctx);
    const texts = (lines ?? []).map((l) => l.text);
    expect(texts).toContain('“Sign in with Acme” will be removed from the sign-in options');
    expect(texts).toContain('1 person who signs in with it will no longer be able to sign in');
    expect(texts).toContain('1 open session from it will end');
    expect(texts).toContain('1 admin signed in with it will be signed out of the admin app');

    const res = await def.run(input, ctx);
    expect(res.output).toEqual({ provider: 'corp-idp', sessionsEnded: 1, adminsSignedOut: 1 });
    expect(identity.idp('corp-idp')).toBeUndefined();
    expect(identity.idp('other')).toBeDefined();
    expect((await cfgSvc.current()).revision).toBeGreaterThan(rev0);
    expect(await identity.sessions.list('corp-idp:alice-sub')).toHaveLength(0);
    expect(await dir.get('sso:corp-idp:bob-sub')).toBeNull();
    // Signing in with it no longer works.
    const start = await h.req('/api/v1/sso/corp-idp/start?audience=team');
    expect(start.status).toBe(404);

    if (!res.undo || !def.undo) throw new Error('no undo');
    await def.undo(res.undo.payload, ctx);
    const back = identity.idp('corp-idp');
    expect(back?.clientSecret).toBe(idp.clientSecret);
    expect(back?.label).toBe('Sign in with Acme');
    expect(h.kernel.config().modules['enterprise-identity']).toMatchObject({
      idps: [{ id: 'other' }, { id: 'corp-idp' }],
    });
    expect(await dir.get('sso:corp-idp:bob-sub')).not.toBeNull();
    expect((await h.req('/api/v1/sso/corp-idp/start?audience=team')).status).toBe(302);
  });

  test('unknown provider: warning preview and refusal', async () => {
    const { def, ctx } = await setup();
    const input = def.input.parse({ provider: 'nope' });
    expect((await def.preview?.(input, ctx))?.[0]?.kind).toBe('warning');
    await expect(def.run(input, ctx)).rejects.toThrow(/no sign-in provider/);
  });

  test('only owners may disconnect a provider', async () => {
    const { def } = await setup();
    const admin: Principal = { id: 'a', roles: { '*': 'admin' }, via: 'cli' };
    expect(def.permission).toBe('node.manage');
    expect(can(admin, def.permission, null)).toBe(false);
    expect(can(OWNER, def.permission, null)).toBe(true);
    expect(def.technical).toBeTruthy();
  });
});
