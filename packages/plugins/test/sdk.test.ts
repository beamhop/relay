// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { createKernel, parseConfig } from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { z } from 'zod';
import { createBundledPluginHost } from '../src/bundled.ts';
import { definePlugin, hold, isPluginDefinition, reject } from '../src/sdk/index.ts';
import {
  createPluginTestbed,
  createTestbed,
  expectAccept,
  expectDecision,
  expectReject,
} from '../src/testing/index.ts';

const counter = definePlugin({
  id: 'counter',
  name: 'Counter',
  description: 'test',
  version: '1.0.0',
  permissions: ['docs'],
  configSchema: z.object({ max: z.number().int().default(2) }),
  hooks: (api) => {
    let n = 0;
    return {
      async onEvent() {
        n++;
        await api.docs.put('n', n);
        if (n > api.config.max) return reject('rate-limited', 'too many');
      },
      onUpload(info) {
        if (info.size > 10) return hold('big');
      },
      onConnect(ctx) {
        if (ctx.conn?.ipHash === 'banned') return reject('blocked', 'go away');
      },
      onAuth(pubkey) {
        if (pubkey === 'x') return reject('auth-required', 'nope');
      },
      onBlobServe(sha) {
        if (sha === 'b'.repeat(64)) return reject('blocked', 'gone');
      },
    };
  },
});

describe('definePlugin', () => {
  test('validates the manifest eagerly', () => {
    expect(() => definePlugin({ id: 'Bad Id', name: 'x', description: '', onEvent() {} })).toThrow(
      /Invalid plugin manifest/,
    );
    expect(() =>
      definePlugin({ id: 'ok', name: 'x', description: '', version: 'one', onEvent() {} }),
    ).toThrow(/semver/);
  });

  test('priority is clamped into the plugin band', () => {
    const p = definePlugin({ id: 'p', name: 'p', description: '', priority: 5, onEvent() {} });
    expect(p.manifest.priority).toBe(300);
    expect(isPluginDefinition(p)).toBe(true);
    expect(p.id).toBe('plugin.p');
  });

  test('shorthand form with top-level hooks works in the testbed', async () => {
    const p = definePlugin({
      id: 'short',
      name: 'Short',
      description: 'top-level hooks',
      onEvent(event) {
        if (event.content.includes('nope'))
          return { action: 'reject', prefix: 'blocked', message: 'x' };
        return { action: 'accept' };
      },
    });
    const bed = createTestbed(p);
    expect((await bed.event({ kind: 1, content: 'nope' })).action).toBe('reject');
    expect((await bed.event({ kind: 1, content: 'fine' })).action).toBe('accept');
  });
});

describe('testbed', () => {
  test('runs every hook through the pipeline and keeps stats', async () => {
    const tb = await createPluginTestbed({ plugin: counter });
    expectAccept(await tb.event());
    expectAccept(await tb.event());
    const d = await tb.event();
    expectReject(d, 'rate-limited', 'too many');
    expect(d.by).toBe('plugin.counter');
    expectDecision(await tb.upload({ size: 11 }), 'hold');
    expectAccept(await tb.upload({ size: 1 }));
    expectReject(await tb.connect({ conn: { ipHash: 'banned' } }), 'blocked');
    expectAccept(await tb.connect());
    expectReject(await tb.auth('x'), 'auth-required');
    expectReject(await tb.blobServe('b'.repeat(64)));
    expectAccept(await tb.req([{ kinds: [1] }]));
    expect(await tb.ports.docs.get('plugin.counter', 'n')).toBe(3);
    const s = tb.status()[0]!;
    expect(s.stats.calls).toBe(9); // onReq is not implemented, so it is never called
    expect(s.stats.rejections).toBe(5);
  });

  test('configure hot-reloads with a fresh instance', async () => {
    const tb = await createPluginTestbed({ plugin: counter, config: { max: 0 } });
    expectReject(await tb.event());
    await tb.configure('counter', { max: 5 });
    expectAccept(await tb.event());
  });

  test('assertion helpers throw on mismatch', () => {
    expect(() => expectAccept({ action: 'shadow' })).toThrow();
    expect(() => expectReject({ action: 'accept' })).toThrow();
    expect(() =>
      expectReject({ action: 'reject', prefix: 'blocked', message: 'm' }, 'pow'),
    ).toThrow();
  });

  test('plugins without a permission cannot use it', async () => {
    const sneaky = definePlugin({
      id: 'sneaky',
      name: 'Sneaky',
      description: '',
      hooks: (api) => ({
        async onEvent() {
          await api.fetch('https://example.com');
        },
      }),
    });
    const tb = await createPluginTestbed({ plugin: sneaky, run: { failMode: 'closed' } });
    expectReject(await tb.event(), 'error');
    expect(tb.status()[0]!.stats.lastError).toContain('network');
  });
});

describe('standalone module form (runtime-cf compatibility)', () => {
  test('a definition registers itself when enabled in config', async () => {
    const ports = memoryPorts();
    const kernel = await createKernel({
      runtime: 'test',
      ports,
      config: parseConfig({ plugins: [{ id: 'counter', enabled: true, config: { max: 0 } }] }),
      modules: [counter],
    });
    const d = await kernel.policy.run('onEvent', [
      { id: 'x', pubkey: 'p', created_at: 1, kind: 1, tags: [], content: '', sig: 's' },
      { relayId: 'default', now: 1 },
    ]);
    expect(d.action).toBe('reject');
  });

  test('disabled definitions contribute nothing', async () => {
    const kernel = await createKernel({
      runtime: 'test',
      ports: memoryPorts(),
      config: parseConfig({ plugins: [{ id: 'counter', enabled: false, config: {} }] }),
      modules: [counter],
    });
    expect(kernel.policy.list()).toHaveLength(0);
  });
});

describe('bundled host', () => {
  const boot = (importMap: Record<string, Record<string, unknown>>, plugins: unknown[]) =>
    createKernel({
      runtime: 'test',
      ports: memoryPorts(),
      config: parseConfig({ plugins }),
      modules: [createBundledPluginHost(importMap)],
    });
  const event = { id: 'x', pubkey: 'p', created_at: 1, kind: 1, tags: [], content: 'hi', sig: 's' };
  const ctx = { relayId: 'default', now: 1 };

  test('loads definitions, PolicyHooks and factories from the import map, plus built-ins', async () => {
    const kernel = await boot(
      {
        counter: { default: counter },
        legacy: {
          hooks: { id: 'legacy', priority: 10, onEvent: () => reject('blocked', 'legacy') },
        },
        made: {
          default: (c: { msg: string }) => ({
            id: 'm',
            priority: 400,
            onReq: () => reject('blocked', c.msg),
          }),
        },
      },
      [
        { id: 'counter', enabled: true, config: { max: 5 } },
        { id: 'legacy', enabled: true, config: {} },
        { id: 'made', enabled: true, config: { msg: 'from factory' } },
        { id: 'kind-allowlist', enabled: true, config: { kinds: [1] } },
        { id: 'not-bundled', enabled: true, config: {} },
      ],
    );
    const host = kernel.use<{
      status(): Array<{ id: string; status: string; error?: string; mode?: string }>;
    }>('plugins')!;
    const byId = Object.fromEntries(host.status().map((r) => [r.id, r]));
    expect(byId.counter!.status).toBe('running');
    expect(byId.legacy!.status).toBe('running');
    expect(byId['kind-allowlist']!.mode).toBe('in-process');
    expect(byId['not-bundled']!.status).toBe('error');
    expect(byId['not-bundled']!.error).toContain('deploy again');
    // Legacy hook priority 10 is clamped into the plugin band.
    const legacy = kernel.policy.list().find((h) => h.id === 'plugin.legacy')!;
    expect(legacy.priority).toBe(300);
    expect(await kernel.policy.run('onEvent', [event, ctx])).toMatchObject({ message: 'legacy' });
    expect(await kernel.policy.run('onReq', [[{}], ctx])).toMatchObject({
      message: 'from factory',
    });
    // Built-ins can be added from the catalog (settings may come later when added turned off).
    const install = kernel.actions.get('plugins.install')!;
    await expect(
      install.run(
        { id: 'wot-strict', enable: false },
        {
          principal: { id: 'o', roles: { '*': 'owner' }, via: 'cli' },
          relayId: null,
          ports: kernel.ports,
        },
      ),
    ).resolves.toBeDefined();
  });
});
