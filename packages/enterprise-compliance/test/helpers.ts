// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionContext,
  type BeamhopModule,
  type Kernel,
  type Ports,
  type Principal,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { createComplianceModule } from '../src/module.ts';
import type { ExporterOptions } from '../src/siem/exporter.ts';

export const alice: Principal = {
  id: 'a'.repeat(64),
  pubkey: 'a'.repeat(64),
  displayName: 'Alice',
  roles: { '*': 'owner' },
  via: 'nip07',
};
export const bob: Principal = {
  id: 'b'.repeat(64),
  pubkey: 'b'.repeat(64),
  displayName: 'Bob',
  roles: { '*': 'owner' },
  via: 'passkey',
};
export const viewer: Principal = { id: 'v'.repeat(64), roles: { '*': 'viewer' }, via: 'nip07' };

export interface TestEnv {
  kernel: Kernel;
  ports: ReturnType<typeof memoryPorts>;
}

export async function makeKernel(opts: {
  modules?: Record<string, unknown>;
  extra?: BeamhopModule[];
  exporter?: ExporterOptions;
  ports?: Partial<Ports>;
  relays?: unknown[];
  config?: Record<string, unknown>;
  compliance?: boolean;
}): Promise<TestEnv> {
  const ports = memoryPorts(opts.ports ?? {});
  const config = parseConfig({
    relays: opts.relays ?? [{ id: 'main', hosts: ['relay.test'] }],
    modules: opts.modules ?? { 'enterprise-compliance': {} },
    ...(opts.config ?? {}),
  });
  const modules = [...(opts.extra ?? [])];
  if (opts.compliance !== false) modules.push(createComplianceModule(opts.exporter ?? {}));
  const kernel = await createKernel({ runtime: 'test', ports, config, modules });
  return { kernel, ports };
}

/** Run an action the way admin-api does: parse input with the (possibly wrapped) schema. */
export async function runAction(
  kernel: Kernel,
  id: string,
  input: unknown,
  principal: Principal,
  relayId: string | null = null,
  reason?: string,
) {
  const def = kernel.actions.get(id);
  if (!def) throw new Error(`no action ${id}`);
  const parsed = def.input.parse(input ?? {});
  const ctx: ActionContext = { principal, relayId, ports: kernel.ports };
  if (reason) ctx.reason = reason;
  return def.run(parsed, ctx);
}
