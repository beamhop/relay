// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { parseConfig } from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { type RunningServer, SELF_CHECK_PATH, startServer } from '../src/index.ts';
import { canBind, newState, openWs, stubModule, tempDir, testConfig, waitFor } from './helpers.ts';

const BIND = canBind();
if (!BIND) {
  console.warn(
    '[runtime-bun] local port binding is not permitted here; server integration tests skipped',
  );
}
const d = BIND ? describe : describe.skip;

const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop('test');
});

async function boot(
  opts: Partial<Parameters<typeof startServer>[0]> = {},
  state = newState(),
  lines: string[] = [],
) {
  const s = await startServer({
    config: testConfig(),
    modules: [stubModule(state)],
    ports: memoryPorts(),
    hostname: '127.0.0.1',
    port: 0,
    print: (l) => lines.push(l),
    shutdownTimeoutMs: 500,
    ...opts,
  });
  running.push(s);
  return { s, state, lines };
}

d('startServer', () => {
  test('routes by Host header and path prefix, setting the route variable', async () => {
    const { s } = await boot();
    const get = async (path: string, host: string) =>
      (await fetch(`${s.url}${path}`, { headers: { host } })).json();
    expect(await get('/', 'alpha.test')).toMatchObject({
      relayId: 'alpha',
      publicUrl: 'http://alpha.test',
      path: '/',
    });
    expect(await get('/x', 'beta.test:8080')).toMatchObject({ relayId: 'beta' });
    // Path prefix wins and is stripped before dispatch.
    expect(await get('/team/info', 'alpha.test')).toMatchObject({
      relayId: 'team',
      publicUrl: 'http://alpha.test/team',
      path: '/info',
    });
    const miss = await fetch(`${s.url}/`, { headers: { host: 'unknown.test' } });
    expect(miss.status).toBe(404);
  });

  test('X-Forwarded-* honored only with trustProxy', async () => {
    const headers = {
      host: 'alpha.test',
      'x-forwarded-host': 'beta.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.9',
    };
    const off = await boot();
    const r1 = await (await fetch(`${off.s.url}/`, { headers })).json();
    expect(r1).toMatchObject({ relayId: 'alpha', publicUrl: 'http://alpha.test' });

    const cfg = testConfig({
      node: { dataDir: tempDir(), tls: { mode: 'proxy' }, trustProxy: true },
    });
    const on = await boot({ config: cfg });
    const r2 = await (await fetch(`${on.s.url}/`, { headers })).json();
    expect(r2).toMatchObject({ relayId: 'beta', publicUrl: 'https://beta.test' });
  });

  test('WebSocket connections get a full Connection and reach kernel.ws', async () => {
    const { s, state } = await boot();
    const wsUrl = `${s.url.replace('http', 'ws')}/`;
    const a = openWs(wsUrl, { host: 'beta.test' });
    await a.opened;
    await waitFor(() => a.messages.length >= 1);
    const [hello, relayId, challenge] = JSON.parse(a.messages[0] ?? '[]');
    expect(hello).toBe('HELLO');
    expect(relayId).toBe('beta');
    expect(challenge).toMatch(/^[0-9a-f]{32}$/);
    a.ws.send('one');
    a.ws.send(new TextEncoder().encode('two'));
    await waitFor(() => a.messages.length >= 3);
    const e1 = JSON.parse(a.messages[1] ?? '[]');
    const e2 = JSON.parse(a.messages[2] ?? '[]');
    expect(e1.slice(0, 3)).toEqual(['ECHO', 'one', 1]);
    expect(e2.slice(0, 3)).toEqual(['ECHO', 'two', 2]); // per-connection state; binary decoded
    expect(e1[3]).toMatch(/^[0-9a-f]{16}$/); // hashed IP, never raw
    expect(e1[3]).not.toContain('127.0.0.1');
    expect(typeof e1[4]).toBe('number'); // bufferedAmount
    const conn = state.opened[0];
    expect(conn?.relayId).toBe('beta');
    expect(conn?.authed).toBeInstanceOf(Set);
    expect(s.connections()).toBe(1);

    a.ws.send('close');
    await waitFor(() => a.closeCode() !== undefined);
    expect(a.closeCode()).toBe(4000);
    await waitFor(() => state.closed.length === 1);
    expect(state.closed[0]).toBe(conn?.id ?? '');
    expect(s.connections()).toBe(0);
  });

  test('prints admin URL and claim code on first boot', async () => {
    const lines: string[] = [];
    const { s } = await boot({}, newState(), lines);
    expect(s.firstBoot).toBe(true);
    expect(s.claim?.code).toBe('CLAIM-1234');
    const text = lines.join('\n');
    expect(text).toContain(`http://alpha.test:${s.port}/admin/`); // tls off → plain http
    expect(s.adminUrl).toBe(`http://alpha.test:${s.port}/admin/`);
    expect(text).toContain('CLAIM-1234');
    expect(existsSync(s.layout.stateFile)).toBe(true);

    // Second boot on the same data dir, already claimed: quiet.
    const state = newState();
    state.claimed = true;
    const lines2: string[] = [];
    const cfg = parseConfig({ ...s.kernel.config() });
    await s.stop();
    const again = await boot({ config: cfg }, state, lines2);
    expect(again.s.firstBoot).toBe(false);
    expect(again.s.claim).toBeNull();
    expect(lines2).toEqual([]);
  });

  test('safe mode restores last known good config with plugins off', async () => {
    const state = newState();
    state.lkg = parseConfig({
      relays: [{ id: 'restored', hosts: ['restored.test'] }],
      plugins: [{ id: 'p1', enabled: true, config: {} }],
    });
    const lines: string[] = [];
    const cfg = testConfig({ plugins: [{ id: 'p2', enabled: true, config: {} }] });
    const { s } = await boot({ config: cfg, safe: true }, state, lines);
    expect(s.safe).toBe(true);
    const k = s.kernel.config();
    expect(k.relays.map((r) => r.id)).toEqual(['restored']);
    expect(k.plugins.every((p) => !p.enabled)).toBe(true);
    expect(k.node.dataDir).toBe(cfg.node.dataDir);
    const r = await (await fetch(`${s.url}/`, { headers: { host: 'restored.test' } })).json();
    expect(r.relayId).toBe('restored');
    const health = await (await fetch(`${s.url}/healthz`)).json();
    expect(health.safeMode).toBe(true);
    expect(lines.join('\n')).toContain('SAFE MODE');
  });

  test('/healthz and graceful shutdown', async () => {
    const { s, state } = await boot();
    const h = await fetch(`${s.url}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: 'ok', connections: 0, tls: 'off' });

    const a = openWs(`${s.url.replace('http', 'ws')}/`, { host: 'alpha.test' });
    await a.opened;
    await waitFor(() => s.connections() === 1);
    await s.stop('test');
    await waitFor(() => a.closeCode() !== undefined);
    expect(a.closeCode()).toBe(1001);
    expect(state.closed.length).toBe(1);
    expect(state.stopped).toBe(1);
    await s.stop('again'); // idempotent
    expect(state.stopped).toBe(1);
    await expect(fetch(`${s.url}/healthz`)).rejects.toThrow();
  });

  test('proxy self-check reports header problems and answers over WebSocket', async () => {
    const cfg = testConfig({
      node: { dataDir: tempDir(), tls: { mode: 'proxy' }, trustProxy: true },
    });
    const { s } = await boot({ config: cfg });
    const bad = await (
      await fetch(`${s.url}${SELF_CHECK_PATH}?nonce=abc`, { headers: { host: 'alpha.test' } })
    ).json();
    expect(bad.ok).toBe(false);
    expect(bad.nonce).toBe('abc');
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(JSON.stringify(bad)).not.toContain('127.0.0.1');

    const good = await (
      await fetch(`${s.url}${SELF_CHECK_PATH}`, {
        headers: {
          host: 'internal:3334',
          'x-forwarded-host': 'alpha.test',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '198.51.100.7',
        },
      })
    ).json();
    expect(good.ok).toBe(true);
    expect(good.relay).toEqual({ id: 'alpha', publicUrl: 'https://alpha.test' });
    expect(JSON.stringify(good)).not.toContain('198.51.100.7');

    const w = openWs(`${s.url.replace('http', 'ws')}${SELF_CHECK_PATH}?nonce=n1`);
    await w.opened;
    await waitFor(() => w.messages.length > 0 && w.closeCode() !== undefined);
    expect(JSON.parse(w.messages[0] ?? '{}')).toMatchObject({
      type: 'beamhop-self-check',
      ok: true,
      nonce: 'n1',
    });
  });

  test('falls back to memory storage with a loud warning when storage packages are missing', async () => {
    const warnings: string[] = [];
    const base = memoryPorts();
    const logger = {
      log: (level: string, msg: string) => {
        if (level === 'warn') warnings.push(msg);
      },
      child() {
        return this;
      },
    };
    const { s } = await boot({
      ports: { clock: base.clock },
      logger,
      storageLoaders: { importSql: async () => ({}), importBlobs: async () => undefined },
    });
    expect(s.memoryFallbacks.sort()).toEqual(['blobIndex', 'blobs', 'docs', 'events', 'metrics']);
    expect(warnings.some((w) => w.includes('IN-MEMORY'))).toBe(true);
    const h = await (await fetch(`${s.url}/healthz`)).json();
    expect(h.memoryStorage).toBe(true);
  });
});
