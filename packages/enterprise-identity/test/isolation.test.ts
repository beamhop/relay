// SPDX-License-Identifier: AGPL-3.0-or-later
/** §12.0: without `config.modules['enterprise-identity']` the module contributes nothing. */
import { describe, expect, test } from 'bun:test';
import type { Kernel } from '@beamhop/core';
import { EnterpriseIdentityConfigSchema, IDENTITY_SERVICE, MODULE_ID } from '../src/index.ts';
import { type Harness, makeKernel } from './helpers.ts';

const PATHS: Array<[string, string]> = [
  ['GET', '/api/v1/sso/providers'],
  ['GET', '/api/v1/sso/google/start'],
  ['GET', '/api/v1/sso/google/callback?code=x&state=y'],
  ['POST', '/api/v1/team/session'],
  ['GET', '/api/v1/team/directory'],
  ['GET', '/api/v1/team/link'],
  ['GET', '/app/config.json'],
  ['GET', '/.well-known/nostr.json?name=alice'],
  ['GET', '/scim/v2/Users'],
  ['GET', '/scim/v2/ServiceProviderConfig'],
];

function footprint(k: Kernel) {
  return {
    actions: k.actions.list().filter((a) => a.id.startsWith('enterprise.')),
    access: k.access.filter((a) => a.id.startsWith('enterprise')),
    auth: k.authProviders.filter((p) => p.id.startsWith('enterprise')),
    ui: k.ui.filter((u) => u.chunk.startsWith('enterprise')),
    service: k.use(IDENTITY_SERVICE),
    jobs: [...(k.ports.scheduler as unknown as { jobs: Map<string, unknown> }).jobs.keys()].filter(
      (j) => j.startsWith('enterprise'),
    ),
    routes: k.http.routes.filter((r) => /sso|team|scim|nostr\.json|config\.json/.test(r.path)),
  };
}

async function noRoutes(h: Harness) {
  for (const [method, path] of PATHS) {
    const res = await h.req(path, { method });
    // 401 can only come from admin-api auth under /api/v1, never from this module.
    const ok = res.status === 404 || (res.status === 401 && path.startsWith('/api/v1/'));
    expect(ok ? 'absent' : `${method} ${path} → ${res.status}`).toBe('absent');
  }
}

describe('isolation', () => {
  test('module present but not configured: no routes, actions, hooks, jobs, services', async () => {
    const h = await makeKernel({ enterprise: null });
    const fp = footprint(h.kernel);
    expect(fp).toEqual({
      actions: [],
      access: [],
      auth: [],
      ui: [],
      service: undefined,
      jobs: [],
      routes: [],
    });
    await noRoutes(h);
    // No enterprise state written.
    const docs = h.kernel.ports.docs;
    expect((await docs.list('enterprise.bindings')).items).toEqual([]);
    expect((await docs.list('enterprise.secrets')).items).toEqual([]);
  });

  test('module not loaded at all (vanilla profile) equals the unconfigured footprint', async () => {
    const vanilla = await makeKernel({ enterprise: null, includeEnterprise: false });
    const off = await makeKernel({ enterprise: null });
    expect(vanilla.kernel.actions.list().map((a) => a.id)).toEqual(
      off.kernel.actions.list().map((a) => a.id),
    );
    expect(vanilla.kernel.access.map((a) => a.id)).toEqual(off.kernel.access.map((a) => a.id));
    expect(vanilla.kernel.http.routes.length).toBe(off.kernel.http.routes.length);
  });

  test('empty section or enabled:false also registers nothing', async () => {
    for (const enterprise of [{}, { enabled: false, relays: ['corp'] }]) {
      const h = await makeKernel({ enterprise });
      const fp = footprint(h.kernel);
      expect(fp.actions).toEqual([]);
      expect(fp.routes).toEqual([]);
      expect(fp.access).toEqual([]);
    }
  });

  test('configured: routes and actions appear', async () => {
    const h = await makeKernel({ enterprise: { relays: ['corp'] } });
    const fp = footprint(h.kernel);
    expect(fp.actions.map((a) => a.id)).toContain('enterprise.map-group');
    expect(fp.access.map((a) => a.id)).toEqual(['enterprise.binding']);
    expect(h.kernel.access[0]?.id).toBe('enterprise.binding');
    expect((await h.req('/app/config.json')).status).toBe(200);
    expect((await h.req('/scim/v2/Users')).status).toBe(401);
  });

  test('schema marks absent vs written sections and is stable when re-parsed', () => {
    const absent = EnterpriseIdentityConfigSchema.parse({}) as { configured: boolean };
    expect(absent.configured).toBe(false);
    expect(
      (EnterpriseIdentityConfigSchema.parse(absent) as { configured: boolean }).configured,
    ).toBe(false);
    const written = EnterpriseIdentityConfigSchema.parse({ relays: [] }) as { configured: boolean };
    expect(written.configured).toBe(true);
    expect(
      (EnterpriseIdentityConfigSchema.parse(written) as { configured: boolean }).configured,
    ).toBe(true);
    expect(MODULE_ID).toBe('enterprise-identity');
  });
});
