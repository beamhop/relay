// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional (enterprise) modules are hot-loaded: `modules.enable` on a vanilla node makes
 * company sign-in (routes, actions, admin screen) appear without a restart, and
 * `modules.disable` removes all of it again. Runs in-process, and against a real
 * listening server when local port binding is allowed.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminClaimService } from '@beamhop/admin-api';
import { type Kernel, type Logger, createKernel, manageOptionalModules } from '@beamhop/core';
import { makeEvent, makeKey, memoryPorts } from '@beamhop/testkit';
import {
  MASTER_KEY_FILE,
  bunRuntimeModule,
  keyvaultDefaultSection,
  loadModules,
  optionalModuleSources,
  startServer,
} from '../src/index.ts';
import { canBind, tempDir, testConfig } from './helpers.ts';

const quiet: Logger = {
  log() {},
  child() {
    return quiet;
  },
};

type Fetch = (path: string, init?: RequestInit) => Response | Promise<Response>;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('hex');
}

/** Claim the node via NIP-98 and return an owner session token. */
async function claim(kernel: Kernel, fetchFn: Fetch, base: string): Promise<string> {
  const code = (await (kernel.use('admin.claim') as AdminClaimService).issueCode()).code;
  const url = `${base}/api/v1/nodes/self/auth/nostr`;
  const body = JSON.stringify({ claimCode: code, displayName: 'Owner' });
  const ev = makeEvent(makeKey(), {
    kind: 27235,
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['payload', await sha256Hex(body)],
    ],
    content: '',
    created_at: kernel.ports.clock.now(),
  });
  const res = await fetchFn('/api/v1/nodes/self/auth/nostr', {
    method: 'POST',
    body,
    headers: {
      authorization: `Nostr ${btoa(JSON.stringify(ev))}`,
      'content-type': 'application/json',
    },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** The scenario from the bug report, against any fetch (in-process or real server). */
async function exercise(kernel: Kernel, fetchFn: Fetch, base: string) {
  const token = await claim(kernel, fetchFn, base);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  // biome-ignore lint/suspicious/noExplicitAny: test convenience for arbitrary JSON
  const run = async (id: string, input: unknown): Promise<any> => {
    const res = await fetchFn(`/api/v1/nodes/self/actions/${id}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ input }),
    });
    const json = await res.json();
    if (res.status !== 200) throw new Error(`${id} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const catalog = async () => {
    const res = await fetchFn('/api/v1/nodes/self/actions', { headers: auth });
    return ((await res.json()) as { actions: Array<{ id: string }> }).actions.map((a) => a.id);
  };
  const ui = async () => {
    const res = await fetchFn('/api/v1/nodes/self/ui', { headers: auth });
    const { routes } = (await res.json()) as {
      routes: Array<{ path: string; title: string; chunk: string }>;
    };
    return routes.filter((r) => r.chunk.startsWith('enterprise'));
  };

  // Vanilla: nothing from enterprise.
  expect((await fetchFn('/api/v1/sso/providers')).status).toBe(404);
  expect((await catalog()).filter((id) => id.startsWith('enterprise.'))).toEqual([]);
  expect(await ui()).toEqual([]);
  expect(kernel.isEnabled('enterprise-identity')).toBe(false);
  const listed = (await run('modules.list', {})).output.modules as Array<{
    id: string;
    title: string;
    available: boolean;
    enabled: boolean;
  }>;
  expect(listed.map((m) => m.id)).toEqual([
    'enterprise-identity',
    'enterprise-keyvault',
    'enterprise-compliance',
    'enterprise-network',
  ]);
  expect(listed[0]).toMatchObject({ title: 'Company sign-in', available: true, enabled: false });

  // Preview explains what appears.
  const preview = await fetchFn('/api/v1/nodes/self/actions/modules.enable/preview', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ input: { id: 'enterprise-identity' } }),
  });
  const diff = ((await preview.json()) as { diff: Array<{ text: string }> }).diff;
  expect(diff.some((l) => l.text.includes('Company sign-in'))).toBe(true);

  // Turn on — no restart.
  const on = await run('modules.enable', { id: 'enterprise-identity' });
  expect(on.output).toMatchObject({ id: 'enterprise-identity', enabled: true, changed: true });
  expect(on.output.ui).toContainEqual(
    expect.objectContaining({ path: '/settings/company', title: 'Company sign-in' }),
  );
  expect(on.output.actions).toContain('enterprise.connect-idp');
  expect(typeof on.undo?.token).toBe('string');
  expect(kernel.config().modules['enterprise-identity']).toBeDefined();

  const providers = await fetchFn('/api/v1/sso/providers');
  expect(providers.status).toBe(200);
  expect(await providers.json()).toEqual({ providers: [] });
  const ids = await catalog();
  expect(ids).toContain('enterprise.connect-idp');
  expect(ids).toContain('enterprise.test-connection');
  expect((await ui()).map((r) => r.path)).toContain('/settings/company');

  // Company sign-in setup right after the hot enable.
  const steps = await run('enterprise.connect-idp', {
    provider: 'microsoft',
    baseUrl: 'https://admin.example.com/admin/settings',
  });
  expect(steps.output.values.redirectUri).toBe(
    'https://admin.example.com/api/v1/sso/entra/callback',
  );
  expect(steps.output.values.scimUrl).toBe('https://admin.example.com/scim/v2');
  const scimToken = steps.output.values.scimToken as string;
  expect(scimToken).toMatch(/^bhscim_/);
  expect(steps.output.applied).toBe(false);
  const saved = await run('enterprise.connect-idp', {
    provider: 'microsoft',
    baseUrl: 'https://admin.example.com',
    clientId: 'client-123',
    clientSecret: 'secret',
    tenant: 'contoso.onmicrosoft.com',
    domain: 'contoso.com',
  });
  expect(saved.output.applied).toBe(true);
  // The token shown in the first call keeps working (not rotated by saving).
  expect(saved.output.values.scimToken).toBeUndefined();
  expect(saved.output.values.scimTokenLast4).toBe(scimToken.slice(-4));
  const after = (await (await fetchFn('/api/v1/sso/providers')).json()) as {
    providers: Array<{ id: string; type: string }>;
  };
  expect(after.providers).toEqual([expect.objectContaining({ id: 'entra', type: 'microsoft' })]);
  const scim = await fetchFn('/scim/v2/ServiceProviderConfig', {
    headers: { authorization: `Bearer ${scimToken}` },
  });
  expect(scim.status).toBe(200);

  // Turn off: everything disappears again.
  const off = await run('modules.disable', { id: 'enterprise-identity' });
  expect(off.output).toMatchObject({ enabled: false, changed: true });
  expect(kernel.isEnabled('enterprise-identity')).toBe(false);
  expect((await fetchFn('/api/v1/sso/providers')).status).toBe(404);
  expect((await fetchFn('/scim/v2/ServiceProviderConfig')).status).toBe(404);
  expect((await catalog()).filter((id) => id.startsWith('enterprise.'))).toEqual([]);
  expect(await ui()).toEqual([]);
  expect(kernel.authProviders.some((p) => p.id === 'enterprise-sso')).toBe(false);
  expect(kernel.access.some((a) => a.id.startsWith('enterprise'))).toBe(false);

  // Undo the disable: back on with the saved provider.
  const undo = await fetchFn(`/api/v1/nodes/self/undo/${off.undo.token}`, {
    method: 'POST',
    headers: auth,
  });
  expect(undo.status).toBe(200);
  expect(kernel.isEnabled('enterprise-identity')).toBe(true);
  const back = (await (await fetchFn('/api/v1/sso/providers')).json()) as {
    providers: Array<{ id: string }>;
  };
  expect(back.providers.map((p) => p.id)).toEqual(['entra']);
  await run('modules.disable', { id: 'enterprise-identity' });
  expect((await fetchFn('/api/v1/sso/providers')).status).toBe(404);
}

describe('optional modules (in-process)', () => {
  test('modules.enable / modules.disable hot-load company sign-in', async () => {
    const config = testConfig();
    const modules = await loadModules(config, quiet);
    expect(modules.some((m) => m.id.startsWith('enterprise'))).toBe(false);
    const kernel = await createKernel({
      runtime: 'bun',
      ports: memoryPorts(),
      config,
      modules: [bunRuntimeModule(), ...modules],
    });
    manageOptionalModules(kernel, optionalModuleSources({ secretsDir: tempDir(), env: {} }, quiet));
    const base = 'http://localhost';
    await exercise(kernel, (path, init) => kernel.http.request(`${base}${path}`, init), base);
  });

  test('Company / Organization persona turns on company sign-in in the same change', async () => {
    const config = testConfig();
    const modules = await loadModules(config, quiet);
    const kernel = await createKernel({
      runtime: 'bun',
      ports: memoryPorts(),
      config,
      modules: [bunRuntimeModule(), ...modules],
    });
    manageOptionalModules(kernel, optionalModuleSources({ secretsDir: tempDir(), env: {} }, quiet));
    const base = 'http://localhost';
    const fetchFn: Fetch = (path, init) => kernel.http.request(`${base}${path}`, init);
    const token = await claim(kernel, fetchFn, base);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const path = '/api/v1/nodes/self/relays/alpha/actions/config.apply-persona';
    const body = JSON.stringify({ input: { persona: 'organization' } });
    const preview = await fetchFn(`${path}/preview`, { method: 'POST', headers, body });
    const diff = ((await preview.json()) as { diff: Array<{ text: string }> }).diff;
    expect(diff.some((l) => l.text.startsWith('Company sign-in turns on'))).toBe(true);
    expect(kernel.isEnabled('enterprise-identity')).toBe(false);
    const res = await fetchFn(path, { method: 'POST', headers, body });
    expect(res.status).toBe(200);
    const { undo } = (await res.json()) as { undo: { token: string } };
    expect(kernel.isEnabled('enterprise-identity')).toBe(true);
    expect(kernel.isEnabled('enterprise-keyvault')).toBe(false);
    expect((await fetchFn('/api/v1/sso/providers')).status).toBe(200);
    // Undo the persona: company sign-in goes away again.
    const u = await fetchFn(`/api/v1/nodes/self/undo/${undo.token}`, { method: 'POST', headers });
    expect(u.status).toBe(200);
    expect(kernel.isEnabled('enterprise-identity')).toBe(false);
    expect((await fetchFn('/api/v1/sso/providers')).status).toBe(404);
  });

  test('key vault default section generates a master key file when the env var is missing', async () => {
    const dir = tempDir();
    const withEnv = await keyvaultDefaultSection({
      secretsDir: dir,
      env: { BEAMHOP_MASTER_KEY: 'x' },
    });
    expect(withEnv).toEqual({ kek: { provider: 'local', keyEnv: 'BEAMHOP_MASTER_KEY' } });
    expect(existsSync(join(dir, MASTER_KEY_FILE))).toBe(false);
    const generated = await keyvaultDefaultSection({ secretsDir: dir, env: {} });
    const path = join(dir, MASTER_KEY_FILE);
    expect(generated).toEqual({ kek: { provider: 'local', keyFile: path } });
    const key = readFileSync(path, 'utf8').trim();
    expect(Buffer.from(key, 'base64').length).toBe(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Stable: a second call keeps the same key.
    await keyvaultDefaultSection({ secretsDir: dir, env: {} });
    expect(readFileSync(path, 'utf8').trim()).toBe(key);
  });

  test('key vault hot-enables with a generated key file', async () => {
    const config = testConfig();
    const modules = await loadModules(config, quiet);
    const kernel = await createKernel({
      runtime: 'bun',
      ports: memoryPorts(),
      config,
      modules: [bunRuntimeModule(), ...modules],
    });
    manageOptionalModules(kernel, optionalModuleSources({ secretsDir: tempDir(), env: {} }, quiet));
    const base = 'http://localhost';
    const fetchFn: Fetch = (path, init) => kernel.http.request(`${base}${path}`, init);
    const token = await claim(kernel, fetchFn, base);
    const res = await fetchFn('/api/v1/nodes/self/actions/modules.enable', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { id: 'enterprise-keyvault' } }),
    });
    expect(res.status).toBe(200);
    expect(kernel.isEnabled('enterprise-keyvault')).toBe(true);
    expect(kernel.use('enterprise.keyvault')).toBeDefined();
    expect(kernel.ports.keyWrapper).toBeDefined();
    const off = await fetchFn('/api/v1/nodes/self/actions/modules.disable', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { id: 'enterprise-keyvault' } }),
    });
    expect(off.status).toBe(200);
    expect(kernel.isEnabled('enterprise-keyvault')).toBe(false);
    expect(kernel.use('enterprise.keyvault')).toBeUndefined();
    expect(kernel.ports.keyWrapper).toBeUndefined();
  });
});

const d = canBind() ? describe : describe.skip;

d('optional modules (real server)', () => {
  test('hot enable/disable over HTTP on a local port, no restart', async () => {
    const config = testConfig();
    const modules = await loadModules(config, quiet);
    const s = await startServer({
      config,
      modules,
      logger: quiet,
      print: () => {},
      hostname: '127.0.0.1',
      port: 0,
    });
    try {
      await exercise(s.kernel, (path, init) => fetch(`${s.url}${path}`, init), s.url);
    } finally {
      await s.stop('test');
    }
  });
});
