// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The assistant can never do more than the signed-in admin: its tools follow the
 * admin API's own rule (`mayRunAction`), every tool re-checks when it runs, and the
 * built-in lookups return only what the API would show that admin.
 */
import { describe, expect, test } from 'bun:test';
import { type Principal, defineAction, defineModule, mayRunAction } from '@beamhop/core';
import { z } from 'zod';
import {
  AiModuleConfigSchema,
  type AiService,
  FakeLLM,
  configSection,
  explainSetting,
  readTool,
  runAssistant,
  toolsFor,
} from '../src/index.ts';
import { P, boot } from './helpers.ts';

const mainAdmin = { id: 'main-admin', roles: { main: 'admin' }, via: 'token' } as Principal;
const settings = () => AiModuleConfigSchema.parse({});

describe('the tool list is exactly what the admin API allows', () => {
  test('for every role, relay and token scope', async () => {
    const { kernel } = await boot();
    const relayIds = kernel.config().relays.map((r) => r.id);
    const who: Principal[] = [...Object.values(P), mainAdmin];
    for (const p of who)
      for (const relayId of [null, 'main', 'team'])
        for (const proposals of [false, true]) {
          const offered = new Set(
            toolsFor(kernel, p, relayId, { proposals })
              .filter((t) => t.actionId)
              .map((t) => t.actionId),
          );
          const allowed = new Set(
            kernel.actions
              .list()
              .filter((d) => (d.scope === 'relay' ? !!relayId : true))
              .filter((d) => mayRunAction(d, p, d.scope === 'relay' ? relayId : null, relayIds))
              // Sensitive and outbound reads never reach a model; changes only when asked.
              .filter((d) => (d.readOnly ? !d.sensitive && !d.outbound : proposals))
              .map((d) => d.id),
          );
          expect([p.id, relayId, proposals, [...offered].sort()]).toEqual([
            p.id,
            relayId,
            proposals,
            [...allowed].sort(),
          ]);
        }
  });
});

describe('a tool the admin may not use cannot be called', () => {
  test('naming it anyway runs nothing', async () => {
    const llm = new FakeLLM([
      {
        toolCalls: [
          { name: 'propose_node_restart', args: {} },
          { name: 'node_restart', args: {} },
          { name: 'propose_sample_set-limit', args: { perMinute: 1 } },
        ],
      },
      'OK.',
    ]);
    const { kernel, state } = await boot({ llm });
    const r = await runAssistant(
      { kernel, llm, settings: settings() },
      P.mainMod,
      { message: 'Please restart the server and change the limit', context: { relayId: 'main' } },
      () => {},
    );
    expect(r.toolCalls.every((c) => !c.ok)).toBe(true);
    expect(r.proposals).toEqual([]);
    expect(state.runs).toEqual([]);
  });
});

describe('built-in lookups show only what the API would', () => {
  test('server settings and other relays are hidden from an admin of one relay', async () => {
    const { kernel } = await boot();
    const cfg = kernel.config();
    expect(configSection(cfg, 'info', 'main', mainAdmin)).toMatchObject({ section: 'info' });
    expect(configSection(cfg, 'storage', 'main', mainAdmin)).toMatchObject({
      error: 'Not allowed for this admin',
    });
    expect(configSection(cfg, 'ai', 'main', mainAdmin)).toMatchObject({
      error: 'Not allowed for this admin',
    });
    expect(configSection(cfg, 'relays.team.info', 'main', mainAdmin)).toMatchObject({
      error: 'Not allowed for this admin',
    });
    const list = configSection(cfg, 'relays', 'main', mainAdmin) as {
      value: Array<{ id: string }>;
    };
    expect(list.value.map((r) => r.id)).toEqual(['main']);
    // An admin of the whole server sees all of it (secrets still masked).
    expect(configSection(cfg, 'ai', null, P.owner)).toMatchObject({
      value: { enabled: true, apiKey: '•••' },
    });
  });

  test('explain_setting gives the meaning, but values only where the admin may read them', async () => {
    const { kernel } = await boot();
    const cfg = kernel.config();
    const node = explainSetting(cfg, 'ai.baseUrl', 'main', mainAdmin);
    expect(node.found).toBe(true);
    expect(node.currentValue).toBeUndefined();
    const other = explainSetting(cfg, 'relays.team.hosts', 'main', mainAdmin);
    expect(other.currentValue).toBeUndefined();
    const own = explainSetting(cfg, 'info.name', 'main', mainAdmin);
    expect(own.currentValue).toBe('Main');
    expect(explainSetting(cfg, 'ai.baseUrl', null, P.owner).currentValue).toBeDefined();
  });

  test('server-wide errors are only for admins of the whole server', async () => {
    const llm = new FakeLLM([{ toolCalls: [{ name: 'get_recent_errors', args: {} }] }, 'OK.']);
    const { kernel } = await boot({ llm });
    const ai = kernel.use<AiService>('ai')!;
    ai.errors.add({ source: 'storage', message: 'disk write failed' });
    ai.errors.add({ source: 'relay', message: 'main relay hiccup', relayId: 'main' });
    ai.errors.add({ source: 'relay', message: 'team relay hiccup', relayId: 'team' });
    const insightsAdmin = { ...mainAdmin, id: 'main-admin-2' };
    await runAssistant(
      { kernel, llm, settings: settings(), errors: ai.errors },
      insightsAdmin,
      { message: 'Any errors?', context: { relayId: 'main' } },
      () => {},
    );
    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === 'tool')!.content;
    expect(toolMsg).toContain('main relay hiccup');
    expect(toolMsg).not.toContain('disk write failed');
    expect(toolMsg).not.toContain('team relay hiccup');
  });
});

describe('reads that contact other servers stay away from the assistant', () => {
  const fetched: string[] = [];
  const probe = defineAction({
    id: 'sample.probe-url',
    title: 'Check an address',
    description: 'Fetches a URL and says whether it answered.',
    scope: 'node',
    permission: 'config.write',
    readOnly: true,
    outbound: true,
    input: z.object({ url: z.string() }),
    async run(input) {
      fetched.push(input.url);
      return { output: { ok: true }, summary: 'answered' };
    },
  });
  const outboundModule = defineModule({
    id: 'outbound-sample',
    register(k) {
      k.actions.register(probe);
    },
  });

  test('not offered, not findable, and refused when named', async () => {
    const llm = new FakeLLM([
      { toolCalls: [{ name: 'find_tools', args: { query: 'check an address url' } }] },
      { toolCalls: [{ name: 'sample_probe-url', args: { url: 'http://169.254.169.254/' } }] },
      'OK.',
    ]);
    const { kernel } = await boot({ llm, extra: [outboundModule] });
    const r = await runAssistant(
      { kernel, llm, settings: AiModuleConfigSchema.parse({ maxTools: 0 }) },
      P.owner,
      { message: 'Check http://169.254.169.254/ for me', context: { relayId: 'main' } },
      () => {},
    );
    for (const call of llm.calls)
      expect(call.tools.map((t) => t.name)).not.toContain('sample_probe-url');
    expect(llm.calls[1]!.messages.at(-1)!.content).not.toContain('sample_probe-url');
    expect(r.toolCalls.at(-1)).toMatchObject({ name: 'sample_probe-url', ok: false });
    expect(fetched).toEqual([]);
  });

  test('a read tool built for one by mistake still refuses to run it', async () => {
    const { kernel } = await boot({ extra: [outboundModule] });
    const out = await readTool(probe).run(
      { url: 'http://10.0.0.1/' },
      { kernel, principal: P.owner, relayId: null, newId: () => 'x' },
    );
    expect(out.ok).toBe(false);
    expect(fetched).toEqual([]);
  });
});
