// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionContext,
  type BeamhopModule,
  type Kernel,
  type Principal,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import {
  type InsightsModuleOptions,
  type InsightsRuntime,
  createInsightsModule,
} from '../src/index.ts';

export const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };

/** Minimal stand-in for the relay module (so availability is "up"). */
export const fakeRelayModule: BeamhopModule = {
  id: 'relay',
  register(kernel) {
    kernel.ws = { onOpen() {}, onMessage() {}, onClose() {} };
  },
};

export async function setup(
  opts: {
    insights?: Record<string, unknown>;
    options?: InsightsModuleOptions;
    modules?: BeamhopModule[];
    config?: Record<string, unknown>;
    beforeStart?: (kernel: Kernel) => void;
  } = {},
) {
  const ports = memoryPorts();
  const config = parseConfig({
    relays: [{ id: 'main', hosts: ['relay.example.com'] }],
    modules: { insights: opts.insights ?? {} },
    ...opts.config,
  });
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [...(opts.modules ?? [fakeRelayModule]), createInsightsModule(opts.options ?? {})],
  });
  const rt = kernel.use<InsightsRuntime>('insights') as InsightsRuntime;
  const ctx = (relayId: string | null = 'main'): ActionContext => ({
    principal: OWNER,
    relayId,
    ports,
  });
  async function act(id: string, raw: unknown, relayId: string | null = 'main') {
    const def = kernel.actions.get(id);
    if (!def) throw new Error(`no action ${id}`);
    return def.run(def.input.parse(raw), ctx(relayId));
  }
  /** Advance the fake clock by `seconds` running the flush job every 10 s. */
  async function advance(seconds: number) {
    for (let s = 0; s < seconds; s += 10) {
      ports.clock.advance(10);
      await ports.scheduler.tick('insights.flush');
    }
  }
  return { ports, kernel, rt, act, advance };
}
