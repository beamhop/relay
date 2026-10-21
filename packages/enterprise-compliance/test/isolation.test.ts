// SPDX-License-Identifier: AGPL-3.0-or-later
/** Isolation rule (§12.0): absent config keys → nothing registered, nothing wrapped. */
import { describe, expect, test } from 'bun:test';
import { createKernel, defineAction, defineModule, parseConfig } from '@beamhop/core';
import { type MemoryBlobStore, type MemoryEventStore, memoryPorts } from '@beamhop/testkit';
import { z } from 'zod';
// The real runtime loader (opt-in by config key).
import { loadModules } from '../../runtime-bun/src/modules.ts';
import * as pkg from '../src/index.ts';

const packages = [
  {
    name: '@beamhop/enterprise-compliance',
    load: async () => pkg as Record<string, unknown>,
    optIn: true,
  },
];

const sensitive = defineModule({
  id: 'test-sensitive',
  register(k) {
    k.actions.register(
      defineAction({
        id: 'backups.restore',
        title: 'Restore',
        description: 'x',
        scope: 'node',
        permission: 'node.manage',
        sensitive: true,
        input: z.object({}),
        async run() {
          return { output: { ran: true }, summary: 'ran' };
        },
      }),
    );
  },
});

describe('isolation', () => {
  test('package exports exactly two modules', () => {
    const mods = Object.values(pkg).filter(
      (v) =>
        !!v &&
        typeof v === 'object' &&
        typeof (v as { register?: unknown }).register === 'function',
    ) as Array<{ id: string }>;
    expect(mods.map((m) => m.id).sort()).toEqual(['enterprise-compliance', 'enterprise-network']);
  });

  test('no config keys → no module loaded; each key loads only its module', async () => {
    const logger = memoryPorts().logger;
    const none = await loadModules(parseConfig({}), logger, packages);
    expect(none).toEqual([]);
    const net = await loadModules(
      parseConfig({ modules: { 'enterprise-network': {} } }),
      logger,
      packages,
    );
    expect(net.map((m) => m.id)).toEqual(['enterprise-network']);
    const comp = await loadModules(
      parseConfig({ modules: { 'enterprise-compliance': {} } }),
      logger,
      packages,
    );
    expect(comp.map((m) => m.id)).toEqual(['enterprise-compliance']);
  });

  test('vanilla kernel: no gates, no wrapped stores, sensitive actions run directly', async () => {
    const ports = memoryPorts();
    const events = ports.events as MemoryEventStore;
    const blobs = ports.blobs as MemoryBlobStore;
    const kernel = await createKernel({
      runtime: 'test',
      ports,
      config: parseConfig({ relays: [{ id: 'main', hosts: ['x'] }] }),
      modules: [sensitive],
    });
    expect(kernel.gates).toEqual([]);
    expect(Object.hasOwn(events, 'applyDeletion')).toBe(false);
    expect(Object.hasOwn(blobs, 'delete')).toBe(false);
    expect(kernel.use('enterprise.approvals')).toBeUndefined();
    expect(
      kernel.actions
        .list()
        .some((a) => a.id.startsWith('compliance.') || a.id.startsWith('approvals.')),
    ).toBe(false);
    const def = kernel.actions.get('backups.restore')!;
    const r = await def.run(
      {},
      { principal: { id: 'x', roles: { '*': 'owner' }, via: 'nip07' }, relayId: null, ports },
    );
    expect(r.output).toEqual({ ran: true });
  });

  test('compliance module stop() restores stores and actions', async () => {
    const ports = memoryPorts();
    const mod = pkg.createComplianceModule();
    const kernel = await createKernel({
      runtime: 'test',
      ports,
      config: parseConfig({ modules: { 'enterprise-compliance': {} } }),
      modules: [sensitive, mod],
    });
    expect(Object.hasOwn(ports.events, 'applyDeletion')).toBe(true);
    expect(kernel.actions.get('backups.restore')!.input).not.toBeInstanceOf(z.ZodObject);
    await mod.stop?.(kernel);
    expect(Object.hasOwn(ports.events, 'applyDeletion')).toBe(false);
    expect(Object.hasOwn(ports.blobs, 'delete')).toBe(false);
    expect(kernel.actions.get('backups.restore')!.input).toBeInstanceOf(z.ZodObject);
  });

  test('network module adds exactly one gate and removes it on stop', async () => {
    const kernel = await createKernel({
      runtime: 'test',
      ports: memoryPorts(),
      config: parseConfig({ modules: { 'enterprise-network': {} } }),
      modules: [pkg.networkModule],
    });
    expect(kernel.gates?.map((g) => g.id)).toEqual(['enterprise-network']);
    await pkg.networkModule.stop?.(kernel);
    expect(kernel.gates).toEqual([]);
  });
});
