// SPDX-License-Identifier: AGPL-3.0-or-later
import { createBlossomModule } from '@beamhop/blossom';
import {
  type BeamhopConfig,
  type BeamhopModule,
  type Clock,
  type Kernel,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { policyModule } from '@beamhop/policy';
import { relayModule } from '@beamhop/relay';
import { memoryPorts } from '@beamhop/testkit';
import { type InProcessTarget, inProcessTarget } from '../src/index.ts';

export const realClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  nowMs: () => Date.now(),
};

/** Relay config used by the harnesses: open relay, generous rate limits. */
export function harnessRelay(hosts: string[]) {
  return {
    id: 'main',
    hosts,
    info: { name: 'Beamhop conformance harness', description: 'CI' },
    limits: { eventsPerMinute: 100_000, reqPerMinute: 100_000 },
  };
}

export function harnessModules(
  fetchForMirror?: (r: Request) => Promise<Response>,
): BeamhopModule[] {
  return [
    policyModule,
    relayModule,
    createBlossomModule({
      allowPrivateMirrorHosts: true,
      ...(fetchForMirror ? { fetch: fetchForMirror } : {}),
    }),
  ];
}

/** Kernel wired in-process (no sockets) with memory storage and the real clock. */
export async function inProcessHarness(): Promise<{ kernel: Kernel; target: InProcessTarget }> {
  const config: BeamhopConfig = parseConfig({ relays: [harnessRelay(['relay.test'])] });
  const ref: { target?: InProcessTarget } = {};
  const kernel = await createKernel({
    runtime: 'test',
    ports: memoryPorts({ clock: realClock }),
    config,
    // BUD-04 mirror fetches go back into the same kernel.
    modules: harnessModules((r) => ref.target!.fetch(r)),
  });
  const target = inProcessTarget(kernel, { relayId: 'main', origin: 'http://relay.test' });
  ref.target = target;
  return { kernel, target };
}

/** Local port binding may be denied (sandboxed CI); socket tests skip then. */
export function canBind(): boolean {
  try {
    const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}
