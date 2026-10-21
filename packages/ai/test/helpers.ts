// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BeamhopModule,
  type Kernel,
  type Principal,
  createKernel,
  defineAction,
  defineModule,
  parseConfig,
} from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { z } from 'zod';
import { type AiModuleOptions, createAiModule } from '../src/index.ts';
import { FakeLLM } from '../src/llm.ts';

export const P = {
  owner: { id: 'owner', roles: { '*': 'owner' }, via: 'token', displayName: 'Olive' } as Principal,
  admin: { id: 'admin', roles: { '*': 'admin' }, via: 'token' } as Principal,
  viewer: { id: 'viewer', roles: { '*': 'viewer' }, via: 'token' } as Principal,
  mainMod: { id: 'mod', roles: { main: 'moderator' }, via: 'token' } as Principal,
  scoped: {
    id: 'scoped',
    roles: { '*': 'admin' },
    via: 'token',
    scopes: ['relay.read'],
  } as Principal,
};

export interface SampleState {
  limit: number;
  banned: Set<string>;
  runs: string[];
}

/** A small registry: read-only, state-changing (with preview), sensitive read, and a node action. */
export function sampleModule(state: SampleState): BeamhopModule {
  return defineModule({
    id: 'sample',
    register(k) {
      k.authProviders.push({
        id: 'test',
        label: 'Test',
        async authenticate(req) {
          const id = req.headers.get('x-test-principal');
          return id ? (P[id as keyof typeof P] ?? null) : null;
        },
      });
      k.actions.register(
        defineAction({
          id: 'sample.stats',
          title: 'Show stats',
          description: 'Numbers about the relay.',
          technical: 'counts',
          scope: 'relay',
          permission: 'relay.read',
          readOnly: true,
          input: z.object({ days: z.number().int().min(1).max(30).default(7) }),
          async run(input) {
            state.runs.push('sample.stats');
            return { output: { posts: 42, days: input.days, ip: '10.0.0.1' }, summary: '42 posts' };
          },
        }),
      );
      k.actions.register(
        defineAction({
          id: 'sample.set-limit',
          title: 'Change the post limit',
          description: 'How many posts per minute one person may send.',
          scope: 'relay',
          permission: 'config.write',
          input: z.object({ perMinute: z.number().int().min(1).max(1000) }),
          async preview(input) {
            return [
              { kind: 'change', text: `Posts per minute: ${state.limit} → ${input.perMinute}` },
            ];
          },
          async run(input) {
            state.runs.push('sample.set-limit');
            state.limit = input.perMinute;
            return { output: {}, summary: 'changed' };
          },
          async undo() {},
        }),
      );
      k.actions.register(
        defineAction({
          id: 'sample.ban-user',
          title: 'Ban a user',
          description: 'They can no longer post here.',
          scope: 'relay',
          permission: 'moderation.write',
          input: z.object({ pubkey: z.string().min(1) }),
          async preview(input) {
            return [{ kind: 'add', text: `${input.pubkey} will be banned` }];
          },
          async run(input) {
            state.runs.push('sample.ban-user');
            state.banned.add(input.pubkey);
            return { output: {}, summary: 'banned' };
          },
        }),
      );
      k.actions.register(
        defineAction({
          id: 'compliance.export',
          title: 'Export everything about a user',
          description: 'Data export.',
          scope: 'node',
          permission: 'relay.read',
          readOnly: true,
          sensitive: true,
          input: z.object({}),
          async run() {
            return { output: {}, summary: 'exported' };
          },
        }),
      );
      k.actions.register(
        defineAction({
          id: 'node.restart',
          title: 'Restart the server',
          description: 'Restarts.',
          scope: 'node',
          permission: 'node.manage',
          input: z.object({}),
          async run() {
            state.runs.push('node.restart');
            return { output: {}, summary: 'restarted' };
          },
        }),
      );
    },
  });
}

export interface Booted {
  kernel: Kernel;
  ports: ReturnType<typeof memoryPorts>;
  llm: FakeLLM;
  state: SampleState;
}

export async function boot(
  opts: {
    llm?: FakeLLM;
    enabled?: boolean;
    ai?: AiModuleOptions;
    aiConfig?: Record<string, unknown>;
    extra?: BeamhopModule[];
  } = {},
): Promise<Booted> {
  const ports = memoryPorts();
  const llm = opts.llm ?? new FakeLLM();
  const state: SampleState = { limit: 120, banned: new Set(), runs: [] };
  const config = parseConfig({
    node: { id: 'n1' },
    relays: [
      { id: 'main', hosts: ['localhost'], info: { name: 'Main' } },
      { id: 'team', hosts: ['team.localhost'] },
    ],
    ai: {
      enabled: opts.enabled ?? true,
      apiKey: 'sk-very-secret',
      baseUrl: 'http://10.1.2.3:11434/v1',
    },
    modules: { ai: opts.aiConfig ?? {} },
  });
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [sampleModule(state), ...(opts.extra ?? []), createAiModule({ llm, ...opts.ai })],
  });
  return { kernel, ports, llm, state };
}

/** Parse an SSE body into events. */
export function parseSse(body: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of body.split(/\n\n+/)) {
    if (!block.trim()) continue;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    out.push({ event, data: data.length ? JSON.parse(data.join('\n')) : null });
  }
  return out;
}
