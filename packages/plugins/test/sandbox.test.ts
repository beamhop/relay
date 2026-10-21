// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Kernel } from '@beamhop/core';
import { createBunPluginHost } from '../src/bun/index.ts';
import { FIXTURES, bootKernel, ev, runEvent, tempDir, waitFor } from './helpers.ts';

const ECHO = join(FIXTURES, 'echo-plugin.ts');
let kernels: Kernel[] = [];

afterEach(async () => {
  for (const k of kernels) await k.use<{ stop(): Promise<void> }>('plugins')?.stop();
  kernels = [];
});

async function boot(entry: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const r = await bootKernel(
    {
      plugins: [{ id: 'echo', enabled: true, config: {} }],
      modules: {
        plugins: {
          timeBudgetMs: 400,
          ...extra,
          entries: { echo: { source: ECHO, ...entry } },
        },
      },
    },
    [createBunPluginHost({ dir: tempDir(), hardKillMs: 300, watch: () => () => {} })],
  );
  kernels.push(r.kernel);
  return r;
}

describe('worker sandbox', () => {
  test('runs an untrusted plugin in a worker and returns its decisions', async () => {
    const { kernel, host } = await boot();
    const row = host.status().find((r) => r.id === 'echo')!;
    expect(row.status).toBe('running');
    expect(row.mode).toBe('sandbox');
    expect(row.version).toBe('1.2.3');
    expect((await runEvent(kernel, ev('hello'))).action).toBe('accept');
    const d = await runEvent(kernel, ev('bad'));
    expect(d).toMatchObject({
      action: 'reject',
      prefix: 'blocked',
      message: 'no bad',
      by: 'plugin.echo',
    });
    const req = await kernel.policy.run('onReq', [
      [{ kinds: [4] }],
      { relayId: 'default', now: 1 },
    ]);
    expect(req.action).toBe('reject');
    const stats = host.status()[0]!.stats;
    expect(stats.calls).toBe(3);
    expect(stats.rejections).toBe(2);
    expect(stats.p95Ms).toBeGreaterThan(0);
  });

  test('hook priority is in the plugin band', async () => {
    const { kernel } = await boot();
    const h = kernel.policy.list().find((x) => x.id === 'plugin.echo')!;
    expect(h.priority).toBeGreaterThanOrEqual(300);
  });

  test('host calls (read-events) go over RPC; env is empty; no network or docs without permission', async () => {
    const { kernel, ports } = await boot();
    await ports.events.save('default', ev('stored'));
    expect((await runEvent(kernel, ev('count'))) as { message: string }).toMatchObject({
      message: 'count=1',
    });
    expect(await runEvent(kernel, ev('env'))).toMatchObject({ message: 'env=0' });
    expect(((await runEvent(kernel, ev('net'))) as { message: string }).message).toContain(
      'network permission',
    );
    expect(((await runEvent(kernel, ev('docs'))) as { message: string }).message).toContain(
      '"docs" permission',
    );
  });

  test('context crosses the boundary as plain data', async () => {
    const { kernel } = await boot();
    const conn = {
      id: 'c9',
      relayId: 'default',
      ipHash: 'h',
      openedAt: 1,
      authed: new Set(['a', 'b']),
      challenge: 'x',
      state: new Map(),
      send() {},
      bufferedAmount: () => 0,
      close() {},
    };
    const d = await kernel.policy.run('onEvent', [
      ev('conn'),
      { relayId: 'default', now: 1, conn },
    ]);
    expect(d).toMatchObject({ message: 'conn=c9:2' });
  });

  test('config is validated in the sandbox', async () => {
    const { kernel, host } = await boot();
    await kernel.applyConfig({
      ...kernel.config(),
      plugins: [{ id: 'echo', enabled: true, config: { word: 'spam' } }],
    });
    await host.reconcile();
    expect((await runEvent(kernel, ev('bad'))).action).toBe('accept');
    expect((await runEvent(kernel, ev('spam'))).action).toBe('reject');
    await kernel.applyConfig({
      ...kernel.config(),
      plugins: [{ id: 'echo', enabled: true, config: { word: 42 } }],
    });
    await host.reconcile();
    // A bad config keeps the previous instance running and reports the error.
    const row = host.status()[0]!;
    expect(row.error).toContain('not valid');
    expect((await runEvent(kernel, ev('spam'))).action).toBe('reject');
  });

  test('slow call: fail open by default, fail closed when configured', async () => {
    const open = await boot({ timeBudgetMs: 30 });
    expect((await runEvent(open.kernel, ev('slow'))).action).toBe('accept');
    expect(open.host.status()[0]!.stats.timeouts).toBe(1);

    const closed = await boot({ timeBudgetMs: 30, failMode: 'closed' });
    const d = await runEvent(closed.kernel, ev('slow'));
    expect(d).toMatchObject({ action: 'reject', prefix: 'error' });
  });

  test('errors count and are answered by the fail mode', async () => {
    const { kernel, host } = await boot();
    expect((await runEvent(kernel, ev('throw'))).action).toBe('accept');
    const s = host.status()[0]!.stats;
    expect(s.errors).toBe(1);
    expect(s.lastError).toContain('boom');
    // A success resets the consecutive-failure counter.
    expect((await runEvent(kernel, ev('ok'))).action).toBe('accept');
  });

  test('stuck worker is killed and restarted', async () => {
    const { kernel, host } = await boot({ timeBudgetMs: 50 }, { breaker: { threshold: 1000 } });
    expect((await runEvent(kernel, ev('loop'))).action).toBe('accept');
    // While restarting, calls are answered by the fail mode; afterwards it works again.
    await waitFor(async () => (await runEvent(kernel, ev('bad'))).action === 'reject');
    expect(host.status()[0]!.status).toBe('running');
  });

  test('circuit breaker turns a crash-looping plugin off and raises a card', async () => {
    const { kernel, host, ports } = await boot({}, { breaker: { threshold: 3 } });
    for (let i = 0; i < 3; i++) await runEvent(kernel, ev('throw'));
    await waitFor(() => host.status()[0]!.status === 'tripped');
    expect(kernel.policy.list().some((h) => h.id === 'plugin.echo')).toBe(false);
    expect((await runEvent(kernel, ev('bad'))).action).toBe('accept');
    const state = await ports.docs.get<{ tripped: boolean }>('plugins.state', 'echo');
    expect(state?.tripped).toBe(true);
    const cards = (await Promise.all(kernel.cards.map((c) => c.cards(null)))).flat();
    const card = cards.find((c) => c.id === 'plugins.tripped.echo')!;
    expect(card.primary).toMatchObject({ actionId: 'plugins.enable', input: { id: 'echo' } });
    // Config changes do not bring it back; only plugins.enable does.
    await host.reconcile();
    expect(host.status()[0]!.status).toBe('tripped');
    await host.untrip('echo');
    await host.reconcile();
    expect(host.status()[0]!.status).toBe('running');
  });

  test('a plugin asking for unapproved permissions is not loaded', async () => {
    const { host } = await boot({ approvedPermissions: [] });
    const row = host.status()[0]!;
    expect(row.status).toBe('error');
    expect(row.error).toContain('read-events');
  });

  test('disabling unloads the plugin', async () => {
    const { kernel, host } = await boot();
    await kernel.applyConfig({
      ...kernel.config(),
      plugins: [{ id: 'echo', enabled: false, config: {} }],
    });
    await host.reconcile();
    expect(host.status()[0]!.status).toBe('disabled');
    expect((await runEvent(kernel, ev('bad'))).action).toBe('accept');
  });

  test('trusted plugins run in-process', async () => {
    const { kernel, host } = await boot({ trusted: true });
    expect(host.status()[0]!.mode).toBe('in-process');
    expect((await runEvent(kernel, ev('bad'))).action).toBe('reject');
  });
});
