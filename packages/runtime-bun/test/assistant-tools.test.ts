// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * With every module the server ships, the assistant gets none of the read actions that
 * contact other servers (they are marked `outbound`), even for the owner.
 */
import { describe, expect, test } from 'bun:test';
import { toolsFor } from '@beamhop/ai';
import { type Logger, type Principal, createKernel } from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { bunRuntimeModule, loadModules } from '../src/index.ts';
import { testConfig } from './helpers.ts';

const quiet: Logger = {
  log() {},
  child() {
    return quiet;
  },
};

/** Read actions known to reach out: provider, feed, DNS/TLS, or any URL from the input. */
const OUTBOUND = [
  'ai-setup.list-models',
  'experience.test-relay',
  'system.update-check',
  'system.doctor',
  'plugins.catalog',
];

describe('assistant tools on a full server', () => {
  test('outbound reads are marked and never offered', async () => {
    const config = testConfig({ ai: { enabled: true } });
    const kernel = await createKernel({
      runtime: 'bun',
      ports: memoryPorts(),
      config,
      modules: [bunRuntimeModule(), ...(await loadModules(config, quiet))],
    });
    const owner = { id: 'owner', roles: { '*': 'owner' }, via: 'token' } as Principal;
    for (const id of OUTBOUND) {
      const def = kernel.actions.get(id);
      expect([id, !!def]).toEqual([id, true]);
      expect([id, def?.outbound]).toEqual([id, true]);
    }
    for (const relayId of [null, 'alpha'])
      for (const proposals of [false, true]) {
        const offered = toolsFor(kernel, owner, relayId, { proposals }).map((t) => t.actionId);
        for (const id of OUTBOUND) expect(offered).not.toContain(id);
        // Every action the assistant can read with stays on this server.
        for (const t of toolsFor(kernel, owner, relayId, { proposals }))
          if (t.kind === 'read' && t.actionId)
            expect(kernel.actions.get(t.actionId)?.outbound).toBeFalsy();
      }
  });
});
