// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The assistant follows `ai.enabled` while running: turning it on in the app loads the
 * `ai` module (its actions appear), turning it off unloads it again. No restart.
 */
import { describe, expect, test } from 'bun:test';
import { type Logger, createKernel } from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { bunRuntimeModule, loadModules, manageFollowingModules } from '../src/index.ts';
import { testConfig } from './helpers.ts';

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
