// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { actionTools, explainSetting, toolsFor } from '../src/index.ts';
import { P, boot } from './helpers.ts';

const names = (ts: Array<{ spec: { name: string } }>) => ts.map((t) => t.spec.name).sort();

describe('tool generation from the action registry', () => {
  test('read-only actions → read tools, state-changing → propose tools', async () => {
    const { kernel } = await boot();
    const tools = actionTools(kernel, P.owner, 'main', { proposals: true });
    const byName = new Map(tools.map((t) => [t.spec.name, t]));
    expect(byName.get('sample_stats')?.kind).toBe('read');
    expect(byName.get('propose_sample_set-limit')?.kind).toBe('propose');
    expect(byName.get('propose_sample_ban-user')?.kind).toBe('propose');
    expect(byName.get('propose_node_restart')?.kind).toBe('propose');
    // State-changing actions never get a direct (runnable) tool.
    expect(byName.has('sample_set-limit')).toBe(false);
    // Sensitive reads are never handed to the model.
    expect(byName.has('compliance_export')).toBe(false);
    // JSON Schema from zod, always an object.
    const params = byName.get('propose_sample_set-limit')!.spec.parameters as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.properties.perMinute?.type).toBe('integer');
    expect(params.required).toContain('perMinute');
    expect(byName.get('propose_sample_set-limit')!.spec.description).toContain('does NOT change');
  });

  test('without change intent there are no propose tools', async () => {
    const { kernel } = await boot();
    const tools = toolsFor(kernel, P.owner, 'main', { proposals: false });
    expect(tools.every((t) => t.kind === 'read')).toBe(true);
    expect(names(tools)).toContain('get_health');
    expect(names(tools)).not.toContain('propose_settings_change');
  });

  test('relay-scoped actions need a relay in context', async () => {
    const { kernel } = await boot();
    const tools = names(actionTools(kernel, P.owner, null, { proposals: true }));
    expect(tools).not.toContain('sample_stats');
    expect(tools).toContain('propose_node_restart');
  });
});

describe('permission filtering', () => {
  test('viewer: read tools only, no proposals it could not run', async () => {
    const { kernel } = await boot();
    const tools = names(toolsFor(kernel, P.viewer, 'main', { proposals: true }));
    expect(tools).toContain('sample_stats');
    expect(tools).toContain('get_metrics');
    expect(tools.filter((n) => n.startsWith('propose_'))).toEqual([]);
  });

  test('moderator of one relay: can propose bans there only, nothing node-wide', async () => {
    const { kernel } = await boot();
    const main = names(toolsFor(kernel, P.mainMod, 'main', { proposals: true }));
    expect(main).toContain('propose_sample_ban-user');
    expect(main).not.toContain('propose_sample_set-limit');
    expect(main).not.toContain('propose_node_restart');
    const team = names(toolsFor(kernel, P.mainMod, 'team', { proposals: true }));
    expect(team).toEqual([]);
  });

  test('admin cannot propose owner-only actions; token scopes narrow further', async () => {
    const { kernel } = await boot();
    const admin = names(toolsFor(kernel, P.admin, 'main', { proposals: true }));
    expect(admin).toContain('propose_sample_set-limit');
    expect(admin).not.toContain('propose_node_restart');
    const scoped = names(toolsFor(kernel, P.scoped, 'main', { proposals: true }));
    expect(scoped.filter((n) => n.startsWith('propose_'))).toEqual([]);
    expect(scoped).not.toContain('get_metrics');
  });

  test('a tool re-checks permission when run', async () => {
    const { kernel } = await boot();
    const tool = actionTools(kernel, P.owner, 'main', { proposals: true }).find(
      (t) => t.spec.name === 'propose_sample_set-limit',
    )!;
    const r = await tool.run(
      { perMinute: 5 },
      { kernel, principal: P.viewer, relayId: 'main', newId: () => 'x' },
    );
    expect(r.ok).toBe(false);
  });
});

describe('built-in tools', () => {
  test('config sections mask secrets and IPs', async () => {
    const { kernel } = await boot();
    const tool = toolsFor(kernel, P.owner, null, { proposals: false }).find(
      (t) => t.spec.name === 'get_config_section',
    )!;
    const r = await tool.run(
      { section: 'ai' },
      { kernel, principal: P.owner, relayId: null, newId: () => 'x' },
    );
    expect(r.ok).toBe(true);
    const json = JSON.stringify(r.ok && r.result);
    expect(json).not.toContain('sk-very-secret');
    expect(json).not.toContain('10.1.2.3');
    expect(json).toContain('•••');
  });

  test('explain_setting reads describe() and technical notes', async () => {
    const { kernel } = await boot();
    const r = explainSetting(kernel.config(), 'access.mode', 'main');
    expect(r.found).toBe(true);
    expect(r.description).toBe('Who can post');
    expect(r.technical).toContain('allowlist');
    expect(r.currentValue).toBe('open');
    expect((r.type as { options: string[] }).options).toContain('wot');
    const node = explainSetting(kernel.config(), 'ai.apiKey', null);
    expect(node.currentValue).toBe('•••');
    expect(explainSetting(kernel.config(), 'nope.nothing', null).found).toBe(false);
  });

  test('read action output is returned (IPs are scrubbed later, before prompting)', async () => {
    const { kernel, state } = await boot();
    const tool = toolsFor(kernel, P.owner, 'main', { proposals: false }).find(
      (t) => t.spec.name === 'sample_stats',
    )!;
    const r = await tool.run(
      { days: 3 },
      { kernel, principal: P.owner, relayId: 'main', newId: () => 'x' },
    );
    expect(r.ok && (r.result as { posts: number }).posts).toBe(42);
    expect(state.runs).toEqual(['sample.stats']);
  });
});
