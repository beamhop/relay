// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionContext,
  type BeamhopModule,
  type Connection,
  type Kernel,
  type NostrEvent,
  type Ports,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { RELAY_ENGINE_SERVICE, type RelayEngine, relayModule } from '@beamhop/relay';
import { FakeClock, memoryPorts } from '@beamhop/testkit';
import { toB64 } from '../src/bytes.ts';
import {
  type KeyvaultDeps,
  type KeyvaultRuntime,
  type KeyvaultService,
  SERVICE,
  createKeyvaultModule,
  keyvaultRuntime,
} from '../src/index.ts';

export function randomMasterKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

let seq = 0;

export class FakeConn implements Connection {
  readonly id = `kv${++seq}`;
  readonly ipHash = 'iphash';
  readonly authed = new Set<string>();
  readonly state = new Map<string, unknown>();
  challenge = '';
  frames: unknown[][] = [];
  onFrame?: (f: unknown[]) => void;
  constructor(
    readonly relayId: string,
    readonly openedAt: number,
  ) {}
  send(frame: string): void {
    const f = JSON.parse(frame) as unknown[];
    this.frames.push(f);
    this.onFrame?.(f);
  }
  bufferedAmount(): number {
    return 0;
  }
  close(): void {}
}

export interface SetupOptions {
  keyvault?: Record<string, unknown> | null;
  withRelay?: boolean;
  deps?: KeyvaultDeps;
  ports?: Partial<Ports>;
  modules?: BeamhopModule[];
  realtimeClock?: boolean;
  before?: (kernel: Kernel) => void;
}

export async function setup(opts: SetupOptions = {}) {
  const clock = new FakeClock(opts.realtimeClock ? Date.now() : undefined);
  const ports = memoryPorts({ clock, ...opts.ports });
  const kv =
    opts.keyvault === null
      ? undefined
      : { kek: { provider: 'local', key: randomMasterKey() }, ...opts.keyvault };
  const config = parseConfig({
    relays: [{ id: 'main', hosts: ['relay.test'] }],
    modules: kv ? { 'enterprise-keyvault': kv } : {},
  });
  const modules: BeamhopModule[] = [];
  if (opts.withRelay) modules.push(relayModule);
  modules.push(...(opts.modules ?? []), createKeyvaultModule(opts.deps));
  const kernel = await createKernel({ runtime: 'test', ports, config, modules });
  const svc = kernel.use<KeyvaultService>(SERVICE) as KeyvaultService;
  const rt = keyvaultRuntime(kernel) as KeyvaultRuntime;
  const engine = kernel.use<RelayEngine>(RELAY_ENGINE_SERVICE);
  return { kernel, ports, clock, svc, rt, engine };
}

export function ctx(
  kernel: Kernel,
  relayId: string | null = null,
  principalId = 'token:owner',
): ActionContext {
  return {
    principal: { id: principalId, roles: { '*': 'owner' }, via: 'token' },
    relayId,
    ports: kernel.ports,
  };
}

export async function runAction(
  kernel: Kernel,
  id: string,
  input: unknown,
  c: ActionContext = ctx(kernel),
) {
  const def = kernel.actions.get(id);
  if (!def) throw new Error(`no action ${id}`);
  return def.run(def.input.parse(input), c);
}

export type { NostrEvent };
