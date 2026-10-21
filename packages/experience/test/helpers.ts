// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionContext,
  type AttentionCard,
  type BeamhopModule,
  type Kernel,
  type Principal,
  createKernel,
  defineAction,
  defineModule,
  parseConfig,
} from '@beamhop/core';
import { policyModule } from '@beamhop/policy';
import { memoryPorts } from '@beamhop/testkit';
import { z } from 'zod';
import {
  type ExperienceModuleOptions,
  type ExperienceService,
  createExperienceModule,
} from '../src/index.ts';

export const OWNER: Principal = { id: 'owner-1', roles: { '*': 'owner' }, via: 'cli' };
export const VIEWER: Principal = { id: 'viewer-1', roles: { '*': 'viewer' }, via: 'cli' };

/** A module that serves whatever cards the test puts in `cards`, and a flip action with undo. */
export function fixtureModule() {
  const state = {
    cards: [] as AttentionCard[],
    failing: false,
    flips: new Map<string, number>(),
  };
  const mod: BeamhopModule = defineModule({
    id: 'fixture',
    register(kernel) {
      kernel.cards.push({
        id: 'fixture.cards',
        async cards(relayId) {
          return state.cards.filter((c) => relayId === null || c.relayId === relayId);
        },
      });
      kernel.cards.push({
        id: 'fixture.broken',
        async cards() {
          if (state.failing) throw new Error('boom');
          return [];
        },
      });
      kernel.actions.register(
        defineAction({
          id: 'fixture.flip',
          title: 'Flip a switch',
          description: 'test',
          scope: 'relay',
          permission: 'config.write',
          input: z.object({ name: z.string() }),
          async preview(input) {
            return [{ kind: 'change', text: `flip ${input.name}` }];
          },
          async run(input, ctx) {
            state.flips.set(input.name, (state.flips.get(input.name) ?? 0) + 1);
            return {
              output: { relayId: ctx.relayId },
              summary: `Flipped ${input.name}`,
              undo: {
                actionId: 'fixture.flip',
                payload: input.name,
                expiresAt: ctx.ports.clock.now() + 300,
              },
            };
          },
          async undo(payload) {
            const n = payload as string;
            state.flips.set(n, (state.flips.get(n) ?? 1) - 1);
          },
        }),
      );
    },
  });
  return { mod, state };
}

export async function setup(
  opts: {
    relay?: Record<string, unknown>;
    config?: Record<string, unknown>;
    modules?: BeamhopModule[];
    experience?: ExperienceModuleOptions;
    policy?: boolean;
  } = {},
) {
  const ports = memoryPorts();
  const fixture = fixtureModule();
  const config = parseConfig({
    relays: [{ id: 'main', hosts: ['relay.example.com'], ...opts.relay }],
    ...opts.config,
  });
  const kernel: Kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [
      ...(opts.policy === false ? [] : [policyModule]),
      fixture.mod,
      ...(opts.modules ?? []),
      createExperienceModule(opts.experience),
    ],
  });
  const svc = kernel.use<ExperienceService>('experience') as ExperienceService;

  async function act(
    id: string,
    raw: unknown,
    o: { principal?: Principal; relayId?: string | null } = {},
  ) {
    const def = kernel.actions.get(id);
    if (!def) throw new Error(`no action ${id}`);
    const input = def.input.parse(raw ?? {});
    const ctx: ActionContext = {
      principal: o.principal ?? OWNER,
      relayId: o.relayId === undefined ? (def.scope === 'relay' ? 'main' : null) : o.relayId,
      ports,
    };
    const preview = def.preview ? await def.preview(input, { ...ctx, dryRun: true }) : [];
    const result = await def.run(input, ctx);
    return {
      preview,
      result,
      // biome-ignore lint/suspicious/noExplicitAny: test convenience
      output: result.output as any,
      undo: async () => {
        if (!def.undo || !result.undo) throw new Error(`${id} has no undo`);
        await def.undo(result.undo.payload, ctx);
      },
    };
  }

  const card = (partial: Partial<AttentionCard> & { id: string }): AttentionCard => ({
    relayId: 'main',
    severity: 'info',
    title: `Card ${partial.id}`,
    body: 'Body',
    createdAt: ports.clock.now(),
    ...partial,
  });

  return { ports, kernel, svc, act, fixture: fixture.state, card };
}
