// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two-person rule (§12.9): every action id the compliance module gates by
 * default must be a real, registered action once every feature package that
 * contributes actions is loaded. A typo or a missing action would otherwise be
 * silently never gated.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ActionContext,
  type Kernel,
  type Principal,
  createKernel,
  finalizeEvent,
  parseConfig,
} from '@beamhop/core';
import { DEFAULT_GATED_ACTIONS } from '@beamhop/enterprise-compliance';
import { MemoryLogger, makeKey, memoryPorts } from '@beamhop/testkit';
import { DEFAULT_MODULE_PACKAGES, loadModules } from '../src/modules.ts';

const alice: Principal = {
  id: 'a'.repeat(64),
  pubkey: 'a'.repeat(64),
  roles: { '*': 'owner' },
  via: 'nip07',
};
const bob: Principal = {
  id: 'b'.repeat(64),
  pubkey: 'b'.repeat(64),
  roles: { '*': 'owner' },
  via: 'nip07',
};

function masterKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

/** Every feature package the Bun binary ships, all enterprise modules enabled. */
async function fullKernel() {
  const config = parseConfig({
    relays: [{ id: 'main', hosts: ['relay.test'], blossom: { enabled: true } }],
    modules: {
      'enterprise-identity': {
        enabled: true,
        idps: [{ id: 'okta', type: 'oidc', issuer: 'https://okta.example.com', clientId: 'c' }],
      },
      'enterprise-keyvault': { kek: { provider: 'local', key: masterKey() } },
      'enterprise-compliance': {},
      'enterprise-network': {},
    },
  });
  // Load every package regardless of its runtime condition (e.g. AI off by default).
  const packages = DEFAULT_MODULE_PACKAGES.map(({ when: _when, ...p }) => p);
  const modules = await loadModules(config, new MemoryLogger(), packages);
  const ports = memoryPorts();
  const kernel = await createKernel({ runtime: 'test', ports, config, modules });
  return { kernel, ports, modules };
}

async function runAction(
  kernel: Kernel,
  id: string,
  input: unknown,
  principal: Principal,
  relayId: string | null = null,
) {
  const def = kernel.actions.get(id);
  if (!def) throw new Error(`no action ${id}`);
  const ctx: ActionContext = { principal, relayId, ports: kernel.ports };
  return def.run(def.input.parse(input), ctx);
}

/** Request as alice → approval required; bob approves; alice runs it with the approval. */
async function twoPerson(
  kernel: Kernel,
  id: string,
  input: Record<string, unknown>,
  relayId: string | null,
) {
  const first = await runAction(kernel, id, input, alice, relayId);
  const out = first.output as { status?: string; requestId?: string };
  expect(out.status).toBe('approval-required');
  const requestId = out.requestId as string;
  await expect(runAction(kernel, 'approvals.approve', { requestId }, alice)).rejects.toThrow(
    /your own/,
  );
  await runAction(kernel, 'approvals.approve', { requestId }, bob);
  return runAction(kernel, id, { ...input, _approvalId: requestId }, alice, relayId);
}

describe('two-person rule defaults', () => {
  test('every default gated action id is a registered action', async () => {
    const { kernel, modules } = await fullKernel();
    const ids = modules.map((m) => m.id);
    for (const id of ['policy', 'lifecycle', 'enterprise-identity', 'enterprise-keyvault'])
      expect(ids).toContain(id);
    const missing = DEFAULT_GATED_ACTIONS.filter((id) => !kernel.actions.get(id));
    expect(missing).toEqual([]);
    for (const id of DEFAULT_GATED_ACTIONS) expect(kernel.actions.get(id)?.readOnly).toBeFalsy();
  });

  test('bulk delete needs a second admin', async () => {
    const { kernel, ports } = await fullKernel();
    const k = makeKey();
    const post = finalizeEvent(
      { kind: 1, tags: [], content: 'x', created_at: ports.clock.now() },
      k.sk,
    );
    await ports.events.save('main', post);
    const done = await twoPerson(kernel, 'moderation.bulk-delete', { eventIds: [post.id] }, 'main');
    expect(done.output).toEqual({ removed: 1, notFound: 0 });
    expect(await ports.events.getById('main', post.id)).toBeNull();
  });

  test('disconnecting a sign-in provider needs a second admin', async () => {
    const { kernel } = await fullKernel();
    const idps = () =>
      (kernel.config().modules['enterprise-identity'] as { idps: Array<{ id: string }> }).idps;
    expect(idps().map((i) => i.id)).toEqual(['okta']);
    const done = await twoPerson(kernel, 'enterprise.disconnect-idp', { provider: 'okta' }, null);
    expect(done.output).toMatchObject({ provider: 'okta' });
    expect(idps()).toEqual([]);
  });
});
