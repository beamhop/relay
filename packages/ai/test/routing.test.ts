// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tool routing: the model gets the built-ins plus the best-matching actions, and
 * `find_tools` reaches every other action the admin may run.
 */
import { describe, expect, test } from 'bun:test';
import { type ActionDef, defineAction, defineModule } from '@beamhop/core';
import { z } from 'zod';
import {
  AiModuleConfigSchema,
  FIND_TOOLS,
  FakeLLM,
  rankTools,
  readTool,
  runAssistant,
} from '../src/index.ts';
import { P, boot } from './helpers.ts';

const settings = (o: Record<string, unknown> = {}) => AiModuleConfigSchema.parse(o);

const read = (id: string, title: string, description: string, keywords?: string[]): ActionDef =>
  defineAction({
    id,
    title,
    description,
    scope: 'relay',
    permission: 'relay.read',
    readOnly: true,
    ...(keywords ? { keywords } : {}),
    input: z.object({}),
    async run() {
      return { output: { groups: [{ id: 'g1' }, { id: 'g2' }] }, summary: `${id} ran` };
    },
  });

const GROUPS = read('groups.list', 'Groups', 'Group chats on this relay and who is in them.');
const FILLER = Array.from({ length: 30 }, (_, i) =>
  read(`filler.thing-${i}`, `Thing ${i}`, `Details about thing number ${i}.`),
);

const actionsModule = defineModule({
  id: 'routing-sample',
  register(k) {
    for (const d of [...FILLER, GROUPS]) k.actions.register(d);
  },
});

const offered = (llm: FakeLLM, call: number) => llm.calls[call]!.tools.map((t) => t.name);

describe('rankTools', () => {
  test('"teams" finds groups (synonym), plural and filler words ignored', () => {
    const tools = [...FILLER, GROUPS].map(readTool);
    const top = rankTools(tools, 'how many teams do we have?', 3).map((t) => t.actionId);
    expect(top[0]).toBe('groups.list');
    expect(rankTools(tools, 'how many do we have?', 3)).toEqual([]);
  });
});

describe('assistant tool routing', () => {
  test('only relevant action tools are sent up front', async () => {
    const llm = new FakeLLM([
      { toolCalls: [{ name: 'groups_list', args: {} }] },
      'You have **2** groups.',
    ]);
    const { kernel } = await boot({ llm, extra: [actionsModule] });
    const r = await runAssistant(
      { kernel, llm, settings: settings({ maxTools: 4 }) },
      P.owner,
      { message: 'How many teams do we have?', context: { relayId: 'main' } },
      () => {},
    );
    const first = offered(llm, 0);
    expect(first).toContain('groups_list');
    expect(first).toContain(FIND_TOOLS);
    expect(first).toContain('get_health'); // built-ins always
    expect(first.filter((n) => n.startsWith('filler_'))).toEqual([]);
    expect(r.toolCalls.map((c) => [c.name, c.ok])).toEqual([['groups_list', true]]);
  });

  test('find_tools unlocks any permitted action for the next round', async () => {
    const llm = new FakeLLM([
      { toolCalls: [{ name: FIND_TOOLS, args: { query: 'thing 7' } }] },
      { toolCalls: [{ name: 'filler_thing-7', args: {} }] },
      'Done.',
    ]);
    const { kernel } = await boot({ llm, extra: [actionsModule] });
    const r = await runAssistant(
      { kernel, llm, settings: settings({ maxTools: 2 }) },
      P.owner,
      { message: 'Anything odd?', context: { relayId: 'main' } },
      () => {},
    );
    expect(offered(llm, 0)).not.toContain('filler_thing-7');
    expect(offered(llm, 1)).toContain('filler_thing-7');
    expect(r.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      [FIND_TOOLS, true],
      ['filler_thing-7', true],
    ]);
  });

  test('find_tools never reveals actions the admin may not run', async () => {
    const llm = new FakeLLM([
      { toolCalls: [{ name: FIND_TOOLS, args: { query: 'restart the server' } }] },
      'OK.',
    ]);
    const { kernel } = await boot({ llm, extra: [actionsModule] });
    await runAssistant(
      { kernel, llm, settings: settings({ maxTools: 2 }) },
      P.viewer,
      { message: 'Please restart the server', context: { relayId: 'main' } },
      () => {},
    );
    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).not.toContain('node_restart');
    expect(offered(llm, 1)).not.toContain('propose_node_restart');
  });
});
