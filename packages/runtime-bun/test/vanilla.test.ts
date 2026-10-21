// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Vanilla profile (PLAN §12.0.6), binary side: a node with the default config and no
 * enterprise modules exposes nothing enterprise to the admin app. No enterprise module
 * is loaded, `/ui` lists no company screens, the action catalog has no enterprise
 * actions, and the config schema the admin app renders has no enterprise sections or
 * enterprise wording. The admin bundle side lives in `scripts/ci/vanilla-check.ts`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { AdminClaimService } from '@beamhop/admin-api';
import { type Kernel, type Logger, createKernel, manageOptionalModules } from '@beamhop/core';
import { makeEvent, makeKey, memoryPorts } from '@beamhop/testkit';
import {
  ENTERPRISE_ACTION_PREFIXES,
  ENTERPRISE_CONFIG_KEYS,
  findEnterpriseTerms,
} from '../../../scripts/ci/enterprise-terms.ts';
import { bunRuntimeModule, loadModules, optionalModuleSources } from '../src/index.ts';
import { tempDir, testConfig } from './helpers.ts';

const quiet: Logger = {
  log() {},
  child() {
    return quiet;
  },
};

const BASE = 'http://localhost';

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('hex');
}

let kernel: Kernel;
let moduleIds: string[];
let auth: Record<string, string>;

const get = async <T>(path: string): Promise<T> => {
  const res = await kernel.http.request(`${BASE}${path}`, { headers: auth });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

/** Every object key in a JSON value (to find enterprise config sections at any depth). */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

beforeAll(async () => {
  const config = testConfig();
  const modules = await loadModules(config, quiet);
  moduleIds = modules.map((m) => m.id);
  kernel = await createKernel({
    runtime: 'bun',
    ports: memoryPorts(),
    config,
    modules: [bunRuntimeModule(), ...modules],
  });
  // As in the binary: enterprise modules are available to switch on, but not loaded.
  manageOptionalModules(kernel, optionalModuleSources({ secretsDir: tempDir(), env: {} }, quiet));

  // Claim the node (NIP-98) to get an owner session.
  const code = (await (kernel.use('admin.claim') as AdminClaimService).issueCode()).code;
  const path = '/api/v1/nodes/self/auth/nostr';
  const body = JSON.stringify({ claimCode: code, displayName: 'Owner' });
  const ev = makeEvent(makeKey(), {
    kind: 27235,
    tags: [
      ['u', `${BASE}${path}`],
      ['method', 'POST'],
      ['payload', await sha256Hex(body)],
    ],
    content: '',
    created_at: kernel.ports.clock.now(),
  });
  const res = await kernel.http.request(`${BASE}${path}`, {
    method: 'POST',
    body,
    headers: {
      authorization: `Nostr ${btoa(JSON.stringify(ev))}`,
      'content-type': 'application/json',
    },
  });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  auth = { authorization: `Bearer ${token}` };
});

describe('vanilla profile (§12.0.6)', () => {
  test('no enterprise module is loaded', () => {
    expect(moduleIds.filter((id) => ENTERPRISE_CONFIG_KEYS.test(id))).toEqual([]);
    for (const id of ['enterprise-identity', 'enterprise-keyvault', 'enterprise-compliance']) {
      expect(kernel.isEnabled(id)).toBe(false);
    }
  });

  test('/ui lists no company screens', async () => {
    const { routes } = await get<{
      routes: Array<{ path: string; title: string; chunk: string }>;
    }>('/api/v1/nodes/self/ui');
    // Generic module screens (e.g. Backups) are fine; nothing enterprise.
    const enterprise = routes.filter(
      (r) =>
        /^(enterprise|compliance|keyvault|identity|company)/.test(r.chunk) ||
        r.path.includes('company') ||
        findEnterpriseTerms(`${r.title} ${r.path}`).length > 0,
    );
    expect(enterprise).toEqual([]);
  });

  test('the action catalog has no enterprise actions or wording', async () => {
    const { actions } = await get<{ actions: Array<{ id: string; title: string }> }>(
      '/api/v1/nodes/self/actions',
    );
    expect(actions.length).toBeGreaterThan(0);
    const ids = actions.map((a) => a.id);
    expect(ids.filter((id) => ENTERPRISE_ACTION_PREFIXES.some((p) => id.startsWith(p)))).toEqual(
      [],
    );
    const worded = actions.filter((a) => findEnterpriseTerms(a.title).length > 0);
    expect(worded.map((a) => a.id)).toEqual([]);
  });

  test('the config schema the admin app renders has no enterprise sections', async () => {
    for (const path of [
      '/api/v1/nodes/self/config/schema',
      '/api/v1/nodes/self/relays/alpha/config/schema',
    ]) {
      const schema = await get<unknown>(path);
      const keys = [...allKeys(schema)];
      expect(keys.length).toBeGreaterThan(10);
      expect(keys.filter((k) => ENTERPRISE_CONFIG_KEYS.test(k))).toEqual([]);
      expect(findEnterpriseTerms(JSON.stringify(schema)).map((h) => h.context)).toEqual([]);
    }
  });

  test('the saved config has no enterprise block', async () => {
    const { config } = await get<{ config: Record<string, unknown> }>('/api/v1/nodes/self/config');
    expect(Object.keys(config).filter((k) => ENTERPRISE_CONFIG_KEYS.test(k))).toEqual([]);
    const modules = (config.modules ?? {}) as Record<string, unknown>;
    expect(Object.keys(modules).filter((k) => ENTERPRISE_CONFIG_KEYS.test(k))).toEqual([]);
  });
});
