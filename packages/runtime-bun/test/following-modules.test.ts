// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The assistant follows `ai.enabled` while running: turning it on in the app loads the
 * `ai` module (its actions appear), turning it off unloads it again. No restart.
 */
import { describe, expect, test } from 'bun:test';
import { type Logger, type Principal, createKernel } from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import {
  bunRuntimeModule,
  loadModules,
  manageFollowingModules,
  startServer,
} from '../src/index.ts';
import { canBind, testConfig } from './helpers.ts';

const quiet: Logger = {
  log() {},
  child() {
    return quiet;
  },
};

describe('modules that follow a setting', () => {
  test('ai.enabled loads and unloads the assistant module', async () => {
    const config = testConfig();
    expect(config.ai.enabled).toBe(false);
    const modules = await loadModules(config, quiet);
    expect(modules.some((m) => m.id === 'ai')).toBe(false);
    const kernel = await createKernel({
      runtime: 'bun',
      ports: memoryPorts(),
      config,
      modules: [bunRuntimeModule(), ...modules],
    });
    manageFollowingModules(kernel, quiet);
    const aiActions = () => kernel.actions.list().filter((a) => a.id.startsWith('ai.'));
    expect(aiActions()).toHaveLength(0);

    await kernel.applyConfig({ ...kernel.config(), ai: { ...kernel.config().ai, enabled: true } });
    expect(kernel.isEnabled('ai')).toBe(true);
    expect(aiActions().length).toBeGreaterThan(0);

    await kernel.applyConfig({ ...kernel.config(), ai: { ...kernel.config().ai, enabled: false } });
    expect(kernel.isEnabled('ai')).toBe(false);
    expect(aiActions()).toHaveLength(0);
  });
});

interface ConfigSvc {
  propose(i: { merge: unknown }, p: Principal): Promise<{ id: string }>;
  commit(id: string, p: Principal): Promise<unknown>;
}

const owner = { id: 'owner', roles: { '*': 'owner' }, via: 'token' } as Principal;
const d = canBind() ? describe : describe.skip;

d('without a settings file', () => {
  test('settings saved in the app survive a restart (and load the assistant)', async () => {
    const ports = memoryPorts();
    const boot = async () => {
      const config = testConfig();
      return startServer({
        config,
        modules: await loadModules(config, quiet),
        ports,
        logger: quiet,
        hostname: '127.0.0.1',
        port: 0,
        print: () => {},
        shutdownTimeoutMs: 500,
      });
    };
    const first = await boot();
    const svc = first.kernel.use<ConfigSvc>('admin.config')!;
    const p = await svc.propose({ merge: { ai: { enabled: true, model: 'qwen3' } } }, owner);
    await svc.commit(p.id, owner);
    expect(first.kernel.isEnabled('ai')).toBe(true);
    await first.stop();

    const second = await boot();
    try {
      expect(second.kernel.config().ai).toMatchObject({ enabled: true, model: 'qwen3' });
      expect(second.kernel.isEnabled('ai')).toBe(true);
    } finally {
      await second.stop();
    }
  });
});
