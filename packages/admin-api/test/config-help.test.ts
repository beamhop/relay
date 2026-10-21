// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every setting served by `/config/schema` — core and every feature module, all loaded as
 * if every feature were turned on (same approach as docs/reference/generate.ts) — must have
 * a plain-language description, and every enum a plain label per value (§6.6).
 */
import { describe, expect, test } from 'bun:test';
import {
  type BeamhopModule,
  auditSchemaHelp,
  createKernel,
  defineModule,
  parseConfig,
} from '@beamhop/core';
import { makeKey, memoryPorts } from '@beamhop/testkit';
// Test-only: the module loader of the Bun runtime (admin-api itself never depends on it).
import { DEFAULT_MODULE_PACKAGES, loadModules } from '../../runtime-bun/src/index.ts';
import { type AdminClaimService, adminApiModule } from '../src/index.ts';
import { NODE, call, nostrLogin } from './helpers.ts';

async function allModuleSchemas(): Promise<BeamhopModule[]> {
  const packages = DEFAULT_MODULE_PACKAGES.map((p) => ({ ...p, when: undefined, optIn: false }));
  const modules = await loadModules(parseConfig({}), memoryPorts().logger, packages);
  // Only the schemas matter here: register nothing else, start nothing.
  return modules
    .filter((m) => m.configSchema && m.id !== adminApiModule.id)
    .map((m) => defineModule({ id: m.id, configSchema: m.configSchema, register() {} }));
}

async function bootAll() {
  const ports = memoryPorts();
  const extra = await allModuleSchemas();
  const config = parseConfig({
    node: { id: 'n1' },
    relays: [{ id: 'main', hosts: ['localhost'] }],
    modules: {
      ...Object.fromEntries(extra.map((m) => [m.id, {}])),
      // Sections with required fields get a minimal, inert sample.
      'enterprise-keyvault': { kek: { provider: 'local', keyEnv: 'BEAMHOP_TEST_UNUSED_KEK' } },
    },
  });
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [adminApiModule, ...extra],
  });
  const claim = kernel.use<AdminClaimService>('admin.claim')!;
  const code = (await claim.issueCode()).code;
  const res = await nostrLogin({ kernel, ports }, makeKey(), { claimCode: code });
  if (res.status !== 200) throw new Error(`claim failed: ${res.text}`);
  return { kernel, token: res.json.token as string, ids: extra.map((m) => m.id) };
}

describe('settings help served by /config/schema', () => {
  test('every setting of every module has a description and labeled enums', async () => {
    const env = await bootAll();
    const res = await call(env.kernel, 'GET', `${NODE}/config/schema`, { token: env.token });
    expect(res.status).toBe(200);
    const modules = res.json.properties.modules.properties as Record<string, unknown>;
    // Every module with settings is really there (not silently skipped).
    expect(Object.keys(modules).sort()).toEqual([...env.ids, adminApiModule.id].sort());
    const problems: string[] = auditSchemaHelp(res.json, { skip: ['modules'] });
    for (const [id, schema] of Object.entries(modules)) {
      problems.push(...auditSchemaHelp(schema, { root: `modules.${id}` }));
    }
    expect(problems).toEqual([]);
  });

  test('the x-* help keywords are published', async () => {
    const env = await bootAll();
    const res = await call(env.kernel, 'GET', `${NODE}/config/schema`, { token: env.token });
    const backups = res.json.properties.backups.properties;
    const target = backups.target.properties ?? backups.target.anyOf?.[0]?.properties;
    expect(target.driver['x-enumLabels'].fs).toBe("This server's disk");
    expect(target.bucket['x-showWhen']).toEqual({ path: 'driver', equals: ['s3', 'r2', 'gcs'] });
    expect(target.endpoint['x-example']).toBeString();
    expect(backups.keep['x-recommended']).toEqual({ value: 14, why: expect.any(String) });
    expect(res.json.properties.node.properties.tls.properties.mode['x-technical']).toBeString();
  });
});
