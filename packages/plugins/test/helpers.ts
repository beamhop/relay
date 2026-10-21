// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BeamhopModule,
  type Decision,
  type Kernel,
  type NostrEvent,
  type Principal,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { makeEvent, makeKey, memoryPorts } from '@beamhop/testkit';
import type { PluginHost } from '../src/host/host.ts';

export const FIXTURES = join(import.meta.dir, 'fixtures');
export const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bh-plugins-'));
}

export async function bootKernel(config: unknown, modules: BeamhopModule[]) {
  const ports = memoryPorts();
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config: parseConfig({ relays: [{ id: 'default', hosts: ['*'] }], ...(config as object) }),
    modules,
  });
  return { kernel, ports, host: kernel.use<PluginHost>('plugins')! };
}

const key = makeKey();
export function ev(content: string, kind = 1): NostrEvent {
  return makeEvent(key, { content, kind });
}

export function runEvent(kernel: Kernel, e: NostrEvent): Promise<Decision & { by?: string }> {
  return kernel.policy.run('onEvent', [e, { relayId: 'default', now: kernel.ports.clock.now() }]);
}

export async function runAction(kernel: Kernel, id: string, input: unknown) {
  const def = kernel.actions.get(id);
  if (!def) throw new Error(`no action ${id}`);
  const parsed = def.input.parse(input);
  const ctx = { principal: OWNER, relayId: null, ports: kernel.ports };
  const preview = def.preview ? await def.preview(parsed, ctx) : [];
  const result = await def.run(parsed, ctx);
  return { preview, result };
}

export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}
