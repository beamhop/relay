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

test('declared permissions stay off until the owner allows them (plugins.grant-permissions)', async () => {
  const dir = tempDir();
  const { kernel } = await bootKernel({}, [createBunPluginHost({ dir, watch: () => () => {} })]);
  const host = kernel.use<PluginHost>('plugins')!;
  const def = kernel.actions.get('plugins.grant-permissions')!;
  expect(def.permission).toBe('node.manage');
  expect(def.sensitive).toBe(true);
  const ctx = {
    principal: { id: 'o', roles: { '*': 'owner' as const }, via: 'cli' as const },
    relayId: null,
    ports: kernel.ports,
  };
  const code = CODE.replace('priority: 300,', "priority: 300,\n  permissions: ['docs'],");
  await host.install!({ id: 'no-shouting', code, enabled: false });
  await kernel.applyConfig({
    ...kernel.config(),
    plugins: [{ id: 'no-shouting', enabled: true, config: {} }],
  });
  await waitFor(() => host.status()[0]?.status === 'error');
  expect(host.status()[0]!.error).toContain('not approved');

  const r = await runAction(kernel, 'plugins.grant-permissions', {
    id: 'no-shouting',
    permissions: ['docs'],
  });
  expect(r.preview[0]?.text).toBe(
    '“no-shouting” will be able to: keep its own saved data on this server',
  );
  expect(r.preview[0]?.technical).toContain('approvedPermissions += docs');
  await waitFor(() => host.status()[0]?.status === 'running');
  expect((await runEvent(kernel, ev('LOUD NOISES'))).action).toBe('reject');
  const again = await def.preview!(
    def.input.parse({ id: 'no-shouting', permissions: ['docs'] }),
    ctx,
  );
  expect(again).toEqual([{ kind: 'info', text: 'It already has this access' }]);

  await def.undo!(r.result.undo!.payload, ctx);
  const entries = (kernel.config().modules.plugins as { entries: Record<string, object> }).entries;
  expect(entries['no-shouting']).not.toHaveProperty('approvedPermissions');
  // The reload with the narrower access is refused (the host reports why).
  await waitFor(() => !!host.status()[0]?.error?.includes('not approved'));
  await expect(
    runAction(kernel, 'plugins.grant-permissions', { id: 'nope', permissions: ['network'] }),
  ).rejects.toThrow('no plugin called');
  await host.stop();
}, 30_000);
