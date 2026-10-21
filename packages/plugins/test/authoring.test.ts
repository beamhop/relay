// SPDX-License-Identifier: AGPL-3.0-or-later
// The contract the AI assistant (`ai.generate-plugin`) relies on: kernel.use('plugins')
// exposes sdkGuide, test(), install({ enabled: false }) and uninstall().
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createBunPluginHost } from '../src/bun/index.ts';
import { createBundledPluginHost } from '../src/bundled.ts';
import type { PluginHost } from '../src/host/host.ts';
import { bootKernel, ev, runAction, runEvent, tempDir, waitFor } from './helpers.ts';

const CODE = `import { definePlugin } from '@beamhop/plugins/sdk';
export default definePlugin({
  id: 'no-shouting',
  name: 'No shouting',
  description: 'Rejects posts in all caps',
  priority: 300,
  onEvent(event) {
    if (event.content.length > 3 && event.content === event.content.toUpperCase()) {
      return { action: 'reject', prefix: 'blocked', message: 'no shouting' };
    }
    return { action: 'accept' };
  },
});
`;

const TESTS = `import { describe, expect, test } from 'bun:test';
import { createTestbed } from '@beamhop/plugins/testbed';
import plugin from './plugin.ts';
describe('no-shouting', () => {
  test('rejects caps', async () => {
    const bed = createTestbed(plugin);
    expect((await bed.event({ kind: 1, content: 'HELLO THERE' })).action).toBe('reject');
    expect((await bed.event({ kind: 1, content: 'hello' })).action).toBe('accept');
  });
});
`;

test('test → install (off) → enable → uninstall', async () => {
  const dir = tempDir();
  const { kernel } = await bootKernel({}, [createBunPluginHost({ dir, watch: () => () => {} })]);
  const host = kernel.use<PluginHost>('plugins')!;
  expect(host.sdkGuide).toContain('definePlugin');
  expect(typeof host.test).toBe('function');

  const ok = await host.test!({ id: 'no-shouting', code: CODE, tests: TESTS });
  expect(ok.output).toContain('pass');
  expect(ok).toMatchObject({ ok: true, passed: 1, failed: 0 });
  const bad = await host.test!({
    id: 'no-shouting',
    code: CODE,
    tests: TESTS.replace("toBe('reject')", "toBe('accept')"),
  });
  expect(bad.ok).toBe(false);
  expect(bad.failed).toBe(1);

  const r = await host.install!({ id: 'no-shouting', code: CODE, enabled: false });
  expect(r).toEqual({ id: 'no-shouting' });
  expect(kernel.config().plugins).toEqual([{ id: 'no-shouting', enabled: false, config: {} }]);
  expect((await runEvent(kernel, ev('LOUD NOISES'))).action).toBe('accept');

  await kernel.applyConfig({
    ...kernel.config(),
    plugins: [{ id: 'no-shouting', enabled: true, config: {} }],
  });
  await waitFor(() => host.status()[0]?.status === 'running');
  expect(host.status()[0]!.mode).toBe('sandbox');
  expect((await runEvent(kernel, ev('LOUD NOISES'))).action).toBe('reject');

  await host.uninstall!('no-shouting');
  expect(kernel.config().plugins).toEqual([]);
  expect(existsSync(`${dir}/local/no-shouting`)).toBe(false);
  expect((await runEvent(kernel, ev('LOUD NOISES'))).action).toBe('accept');
  await host.stop();
}, 30_000);

test('hosts without source support do not advertise test/install', async () => {
  const { kernel } = await bootKernel({}, [createBundledPluginHost()]);
  const host = kernel.use<PluginHost>('plugins')!;
  expect(typeof host.test).toBe('undefined');
  expect(typeof host.install).toBe('undefined');
  expect(host.sdkGuide.length).toBeGreaterThan(100);
});

test('AI plugins show source "ai"; removing a source plugin can be undone', async () => {
  const dir = tempDir();
  const { kernel } = await bootKernel({}, [createBunPluginHost({ dir, watch: () => () => {} })]);
  const host = kernel.use<PluginHost>('plugins')!;
  await host.install!({ id: 'no-shouting', code: CODE, enabled: false, source: 'ai' });
  await kernel.applyConfig({
    ...kernel.config(),
    plugins: [{ id: 'no-shouting', enabled: true, config: {} }],
    modules: {
      ...kernel.config().modules,
      plugins: { entries: { 'no-shouting': { failMode: 'closed' } } },
    },
  });
  await waitFor(() => host.status()[0]?.status === 'running');
  const st = await runAction(kernel, 'plugins.status', {});
  const rows = (st.result.output as { plugins: Array<{ id: string; source?: string }> }).plugins;
  expect(rows.find((r) => r.id === 'no-shouting')?.source).toBe('ai');

  const rm = await runAction(kernel, 'plugins.uninstall', { id: 'no-shouting' });
  expect(rm.preview.map((l) => l.text).join(' ')).toContain('undo');
  expect(kernel.config().plugins).toEqual([]);
  expect(existsSync(`${dir}/local/no-shouting`)).toBe(false);
  expect((await runEvent(kernel, ev('LOUD NOISES'))).action).toBe('accept');
  const undo = rm.result.undo!;
  expect(undo.actionId).toBe('plugins.uninstall');

  await kernel.actions.get('plugins.uninstall')!.undo!(undo.payload, {
    principal: { id: 'o', roles: { '*': 'owner' }, via: 'cli' },
    relayId: null,
    ports: kernel.ports,
  });
  expect(kernel.config().plugins).toEqual([{ id: 'no-shouting', enabled: true, config: {} }]);
  const entries = (kernel.config().modules.plugins as { entries: Record<string, unknown> }).entries;
  expect(entries['no-shouting']).toMatchObject({ failMode: 'closed' });
  expect(existsSync(`${dir}/local/no-shouting`)).toBe(true);
  expect((await host.statusRows()).find((r) => r.id === 'no-shouting')?.source).toBe('ai');
  await waitFor(() => host.status()[0]?.status === 'running');
  expect((await runEvent(kernel, ev('LOUD NOISES'))).action).toBe('reject');
  await host.stop();
}, 30_000);
