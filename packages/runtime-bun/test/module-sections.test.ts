// SPDX-License-Identifier: AGPL-3.0-or-later
// Partial `modules.<id>` sections in beamhop.yaml (or from the app) must reach the
// module parsed, with its schema defaults filled in, on every config path.
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AdminConfigService, adminApiModule } from '@beamhop/admin-api';
import { AlertsModuleConfigSchema, alertsModule } from '@beamhop/alerts';
import { BlossomConfigSchema, blossomModule } from '@beamhop/blossom';
import { type BeamhopConfig, type Connection, createKernel, finalizeEvent } from '@beamhop/core';
import { PolicyModuleConfigSchema, policyModule } from '@beamhop/policy';
import { RELAY_ENGINE_SERVICE, type RelayEngine, relayModule } from '@beamhop/relay';
import { makeKey, memoryPorts } from '@beamhop/testkit';
import { loadConfig } from '../src/config.ts';
import { tempDir } from './helpers.ts';

const FILE = `node:
  listen: 127.0.0.1:0
relays:
  - id: main
    hosts: [relay.test]
modules:
  policy:
    rateLimitByIp: false
  blossom:
    tiers:
      hot: { maxBytes: 1048576 }
  alerts:
    digestTips: false
`;

class Conn implements Connection {
  readonly id = `c${Math.random()}`;
  readonly ipHash = 'iphash';
  readonly authed = new Set<string>();
  readonly state = new Map<string, unknown>();
  readonly relayId = 'main';
  readonly openedAt = Date.now();
  challenge = '';
  frames: unknown[][] = [];
  send(frame: string) {
    this.frames.push(JSON.parse(frame));
  }
  bufferedAmount() {
    return 0;
  }
  close() {}
}

async function boot(text = FILE) {
  const dir = tempDir('beamhop-sections-');
  const file = join(dir, 'beamhop.yaml');
  writeFileSync(file, text);
  const loaded = loadConfig({ env: {}, args: { configPath: file }, cwd: dir });
  const ports = memoryPorts();
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config: loaded.config,
    modules: [adminApiModule, relayModule, policyModule, blossomModule, alertsModule],
  });
  const svc = kernel.use<AdminConfigService>('admin.config')!;
  // The boot path of startServer: the file is recorded as a revision and re-applied.
  await svc.adoptBootConfig(loaded.config, { source: 'file', path: file });
  const engine = kernel.use<RelayEngine>(RELAY_ENGINE_SERVICE)!;
  const key = makeKey();
  let n = 0;
  const post = async () => {
    const c = new Conn();
    await engine.open(c);
    const ev = finalizeEvent(
      { kind: 1, tags: [], content: `hello ${++n}`, created_at: ports.clock.now() },
      key.sk,
    );
    await engine.handle(c, JSON.stringify(['EVENT', ev]));
    return c.frames.find((f) => f[0] === 'OK');
  };
  return { kernel, svc, post };
}

function sectionKeys(schema: { parse(v: unknown): unknown }) {
  return Object.keys(schema.parse({}) as object).sort();
}

describe('partial module sections', () => {
  test('booting from a YAML with partial policy/blossom/alerts sections: posts are accepted', async () => {
    const { kernel, post } = await boot();
    const policy = kernel.moduleConfig<Record<string, unknown>>('policy')!;
    expect(policy.rateLimitByIp).toBe(false);
    expect(Array.isArray(policy.tierRules)).toBe(true);
    expect(Object.keys(policy).sort()).toEqual(sectionKeys(PolicyModuleConfigSchema));
    const blossom = kernel.moduleConfig<{ tiers: Record<string, unknown> }>('blossom')!;
    expect(blossom.tiers.hot).toMatchObject({ maxBytes: 1048576 });
    expect(Object.keys(blossom.tiers).sort()).toEqual(
      Object.keys(BlossomConfigSchema.parse({}).tiers).sort(),
    );
    const alerts = kernel.moduleConfig<Record<string, unknown>>('alerts')!;
    expect(alerts.digestTips).toBe(false);
    expect(Object.keys(alerts).sort()).toEqual(sectionKeys(AlertsModuleConfigSchema));

    const ok = await post();
    expect(ok?.[2]).toBe(true);
  });

  test('a settings change from the app with a partial section: posts are still accepted', async () => {
    const { kernel, svc, post } = await boot('relays:\n  - id: main\n    hosts: [relay.test]\n');
    const next = structuredClone((await svc.current()).config) as BeamhopConfig;
    next.modules = {
      ...next.modules,
      policy: { rateLimitByIp: false },
      blossom: { tiers: { hot: { maxBytes: 2048 } } },
      alerts: {},
    };
    await svc.apply(next, { principalId: 'test', summary: 'partial sections' });
    const policy = kernel.moduleConfig<Record<string, unknown>>('policy')!;
    expect(policy.rateLimitByIp).toBe(false);
    expect(Array.isArray(policy.tierRules)).toBe(true);
    expect(
      kernel.moduleConfig<{ tiers: { hot: { maxBytes?: number } } }>('blossom')!.tiers.hot.maxBytes,
    ).toBe(2048);
    expect(Object.keys(kernel.moduleConfig<object>('alerts')!).sort()).toEqual(
      sectionKeys(AlertsModuleConfigSchema),
    );
    expect((await post())?.[2]).toBe(true);
  });

  test('a section dropped from the config gets the module defaults again', async () => {
    const { kernel, post } = await boot();
    await kernel.applyConfig({ ...kernel.config(), modules: {} });
    expect(kernel.moduleConfig<Record<string, unknown>>('policy')!.rateLimitByIp).toBe(
      PolicyModuleConfigSchema.parse({}).rateLimitByIp,
    );
    expect((await post())?.[2]).toBe(true);
  });
});
