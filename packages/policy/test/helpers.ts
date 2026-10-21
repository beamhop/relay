// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionContext,
  type Connection,
  type Kernel,
  type NostrEvent,
  type PolicyContext,
  type Principal,
  computeEventId,
  createKernel,
  finalizeEvent,
  parseConfig,
} from '@beamhop/core';
import { type TestKey, memoryPorts } from '@beamhop/testkit';
import { type PolicyModuleOptions, type PolicyService, createPolicyModule } from '../src/index.ts';
import { leadingZeroBits } from '../src/util.ts';

export const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };

export async function setup(
  relay: Record<string, unknown> = {},
  policy: Record<string, unknown> = {},
  opts: PolicyModuleOptions = {},
  extraModules: Parameters<typeof createKernel>[0]['modules'] = [],
) {
  const ports = memoryPorts();
  const config = parseConfig({
    relays: [{ id: 'main', hosts: ['relay.example.com'], ...relay }],
    modules: { policy },
  });
  const kernel: Kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [createPolicyModule(opts), ...extraModules],
  });
  const svc = kernel.use<PolicyService>('policy') as PolicyService;

  const ctx = (extra: Partial<PolicyContext> = {}): PolicyContext => ({
    relayId: 'main',
    now: ports.clock.now(),
    ...extra,
  });

  /** A test event dated "now" by the fake clock unless given. */
  const ev = (
    key: TestKey,
    partial: Partial<Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>> = {},
  ) =>
    finalizeEvent(
      {
        kind: partial.kind ?? 1,
        tags: partial.tags ?? [],
        content: partial.content ?? `hello ${Math.random()}`,
        created_at: partial.created_at ?? ports.clock.now(),
      },
      key.sk,
    );

  const run = (event: NostrEvent, extra: Partial<PolicyContext> = {}) =>
    kernel.policy.run('onEvent', [event, ctx(extra)]);

  const actionCtx = (principal: Principal = OWNER): ActionContext => ({
    principal,
    relayId: 'main',
    ports,
  });

  async function act(id: string, raw: unknown, principal: Principal = OWNER) {
    const def = kernel.actions.get(id);
    if (!def) throw new Error(`no action ${id}`);
    const input = def.input.parse(raw);
    const ac = actionCtx(principal);
    const preview = def.preview ? await def.preview(input, ac) : [];
    const result = await def.run(input, ac);
    return {
      preview,
      result,
      undo: async () => {
        if (!def.undo || !result.undo) throw new Error(`${id} has no undo`);
        await def.undo(result.undo.payload, ac);
      },
    };
  }

  return { ports, kernel, svc, ctx, ev, run, act, actionCtx };
}

export function fakeConn(ipHash = 'ip-1', authed: string[] = []): Connection {
  return {
    id: `c-${Math.random()}`,
    relayId: 'main',
    ipHash,
    openedAt: 0,
    authed: new Set(authed),
    challenge: 'x',
    state: new Map(),
    send() {},
    bufferedAmount: () => 0,
    close() {},
  };
}

/** Mine an event with at least `bits` leading zero bits (NIP-13). */
export function mine(
  key: TestKey,
  bits: number,
  createdAt: number,
  opts: { target?: number; content?: string; kind?: number } = {},
): NostrEvent {
  const pubkey = finalizeEvent({ kind: 1, tags: [], content: '', created_at: 0 }, key.sk).pubkey;
  const content = opts.content ?? `pow ${Math.random()}`;
  for (let n = 0; ; n++) {
    const tags = [['nonce', String(n), String(opts.target ?? bits)]];
    const id = computeEventId({
      pubkey,
      created_at: createdAt,
      kind: opts.kind ?? 1,
      tags,
      content,
    });
    if (leadingZeroBits(id) >= bits) {
      return finalizeEvent({ kind: opts.kind ?? 1, tags, content, created_at: createdAt }, key.sk);
    }
  }
}

/** Build a kind 3 follow list. */
export function follows(key: TestKey, targets: string[], createdAt = 1_700_000_000): NostrEvent {
  return finalizeEvent(
    { kind: 3, tags: targets.map((t) => ['p', t]), content: '', created_at: createdAt },
    key.sk,
  );
}
