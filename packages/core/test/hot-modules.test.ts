// SPDX-License-Identifier: AGPL-3.0-or-later
/** Hot enable/disable of modules: everything a module registers is removed again. */
import { describe, expect, test } from 'bun:test';
import { memoryPorts } from '@beamhop/testkit';
import { z } from 'zod';
import {
  ACCEPT,
  type BeamhopModule,
  type Kernel,
  MODULE_MANAGER_SERVICE,
  type ModuleManager,
  createKernel,
  defineAction,
  defineModule,
  manageOptionalModules,
  parseConfig,
} from '../src/index.ts';

const base = defineModule({
  id: 'base',
  register(k) {
    k.http.get('/base', (c) => c.text('base'));
    k.http.use('/api/*', async (c, next) => {
      c.set('principal', { id: 'p1', roles: { '*': 'owner' }, via: 'cli' });
      await next();
    });
    k.http.get('/api/base', (c) => c.text('api'));
  },
});

let started = 0;
let stopped = 0;
const extra = (id = 'extra'): BeamhopModule =>
  defineModule({
    id,
    configSchema: z.object({ greeting: z.string().default('hi') }),
    register(k) {
      k.http.get(`/${id}/hello`, (c) =>
        c.json({
          greeting: k.moduleConfig<{ greeting: string }>(id)?.greeting,
          principal: c.get('principal')?.id ?? null,
          route: c.get('route')?.relayId ?? null,
        }),
      );
      k.http.post(`/api/${id}/echo`, async (c) =>
        c.json({ body: await c.req.json(), principal: c.get('principal')?.id }),
      );
      k.actions.register(
        defineAction({
          id: `${id}.do`,
          title: 'Do it',
          description: 'Does it.',
          scope: 'node',
          permission: 'config.write',
          input: z.object({}),
          async run() {
            return { output: {}, summary: 'done' };
          },
        }),
      );
      k.policy.add({ id: `${id}.hook`, priority: 50, onEvent: () => ACCEPT });
      k.access.push({ id: `${id}.access`, canWrite: async () => undefined });
      k.authProviders.push({ id: `${id}.auth`, label: 'x', authenticate: async () => null });
      k.health.push({
        id: `${id}.health`,
        subsystem: 'security',
        weight: 1,
        run: async () => ({ score: 100, status: 'ok', message: 'ok' }),
      });
      k.cards.push({ id: `${id}.cards`, cards: async () => [] });
      k.ui.push({
        path: `/settings/${id}`,
        title: 'Extra',
        placement: 'settings-section',
        chunk: id,
      });
      k.playbooks.push({ id: `${id}.pb`, title: 'pb', steps: [] });
      k.gates?.push({ id: `${id}.gate`, check: () => undefined });
      k.provide(`${id}.svc`, { ok: true });
      k.bus.on('config.changed', () => {});
      k.onConfigChange(() => {});
    },
    start(k) {
      started++;
      k.ports.scheduler.every(`${id}.job`, 60, async () => {});
    },
    stop() {
      stopped++;
    },
  });

function footprint(k: Kernel, id = 'extra') {
  const has = (x: { id: string }) => x.id.startsWith(id);
  return {
    actions: k.actions.list().filter(has).length,
    hooks: k.policy.list().filter(has).length,
    access: k.access.filter(has).length,
    auth: k.authProviders.filter(has).length,
    health: k.health.filter(has).length,
    cards: k.cards.filter(has).length,
    ui: k.ui.filter((u) => u.chunk === id).length,
    playbooks: k.playbooks.filter(has).length,
    gates: (k.gates ?? []).filter(has).length,
    service: k.use(`${id}.svc`) !== undefined,
    jobs: [...(k.ports.scheduler as unknown as { jobs: Map<string, unknown> }).jobs.keys()].filter(
      (j) => j.startsWith(id),
    ).length,
  };
}

const NONE = {
  actions: 0,
  hooks: 0,
  access: 0,
  auth: 0,
  health: 0,
  cards: 0,
  ui: 0,
  playbooks: 0,
  gates: 0,
  service: false,
  jobs: 0,
};
const ALL = {
  actions: 1,
  hooks: 1,
  access: 1,
  auth: 1,
  health: 1,
  cards: 1,
  ui: 1,
  playbooks: 1,
  gates: 1,
  service: true,
  jobs: 1,
};

const boot = (modules: BeamhopModule[] = [base], config: Record<string, unknown> = {}) =>
  createKernel({
    runtime: 'test',
    ports: memoryPorts(),
    config: parseConfig({ relays: [{ id: 'main', hosts: ['localhost'] }], ...config }),
    modules,
  });

describe('hot enable / disable', () => {
  test('enableModule registers everything, disableModule removes exactly that', async () => {
    const k = await boot();
    const baseRoutes = k.http.routes.length;
    expect(footprint(k)).toEqual(NONE);
    expect((await k.http.request('/extra/hello')).status).toBe(404);

    started = 0;
    stopped = 0;
    await k.enableModule?.(extra());
    expect(k.isEnabled('extra')).toBe(true);
    expect(started).toBe(1);
    expect(footprint(k)).toEqual(ALL);
    // Routes live on a detachable sub-app (root routes unchanged) and see route/principal.
    expect(k.http.routes.length).toBe(baseRoutes);
    const res = await k.http.request('/extra/hello', {}, { route: { relayId: 'main' } });
    expect(await res.json()).toEqual({ greeting: 'hi', principal: null, route: 'main' });
    const api = await k.http.request('/api/extra/echo', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(await api.json()).toEqual({ body: { a: 1 }, principal: 'p1' });
    // Built-in routes still win and still work.
    expect(await (await k.http.request('/base')).text()).toBe('base');
    expect(await (await k.http.request('/api/base')).text()).toBe('api');
    // Schema registered and the section parsed with defaults.
    expect(Object.keys(k.moduleSchemas?.() ?? {})).toContain('extra');
    expect(k.modules?.().map((m) => m.id)).toEqual(['base', 'extra']);

    expect(await k.disableModule?.('extra')).toBe(true);
    expect(stopped).toBe(1);
    expect(k.isEnabled('extra')).toBe(false);
    expect(footprint(k)).toEqual(NONE);
    const gone = await k.http.request('/extra/hello');
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe('404 Not Found');
    expect(Object.keys(k.moduleSchemas?.() ?? {})).not.toContain('extra');
    expect(await k.disableModule?.('extra')).toBe(false);

    // And back on again.
    await k.enableModule?.(extra());
    expect(footprint(k)).toEqual(ALL);
    expect((await k.http.request('/extra/hello')).status).toBe(200);
  });

  test('optional modules registered at boot can be disabled too', async () => {
    const m = { ...extra(), optional: true };
    const k = await boot([base, m], { modules: { extra: { greeting: 'hello' } } });
    expect(footprint(k)).toEqual(ALL);
    const res = await k.http.request('/extra/hello');
    expect((await res.json()).greeting).toBe('hello');
    await k.disableModule?.('extra');
    expect(footprint(k)).toEqual(NONE);
    expect((await k.http.request('/extra/hello')).status).toBe(404);
  });

  test('a failing register is rolled back', async () => {
    const k = await boot();
    const bad = defineModule({
      id: 'bad',
      register(kk) {
        kk.ui.push({ path: '/x', title: 'x', placement: 'home-card', chunk: 'bad' });
        kk.http.get('/bad', (c) => c.text('bad'));
        throw new Error('boom');
      },
    });
    await expect(k.enableModule?.(bad) ?? Promise.resolve()).rejects.toThrow('boom');
    expect(k.isEnabled('bad')).toBe(false);
    expect(k.ui).toEqual([]);
    expect((await k.http.request('/bad')).status).toBe(404);
  });

  test('dependencies are respected', async () => {
    const k = await boot();
    const child = defineModule({ id: 'child', dependsOn: ['extra'], register() {} });
    await expect(k.enableModule?.(child) ?? Promise.resolve()).rejects.toThrow(/extra/);
    await k.enableModule?.(extra());
    await k.enableModule?.(child);
    await expect(k.disableModule?.('extra') ?? Promise.resolve()).rejects.toThrow(/child/);
    await k.disableModule?.('child');
    expect(await k.disableModule?.('extra')).toBe(true);
  });

  test('manageOptionalModules follows config.modules and waits in applyConfig', async () => {
    const k = await boot();
    const mgr = manageOptionalModules(k, [
      { id: 'extra', load: async () => extra(), defaultSection: async () => ({ greeting: 'yo' }) },
      { id: 'missing', load: async () => undefined },
    ]);
    expect(k.use<ModuleManager>(MODULE_MANAGER_SERVICE)).toBe(mgr);
    expect(mgr.list().map((s) => [s.id, s.enabled])).toEqual([
      ['extra', false],
      ['missing', false],
    ]);
    const cfg = k.config();
    await k.applyConfig({
      ...cfg,
      modules: { ...cfg.modules, extra: await mgr.defaultSection('extra') },
    });
    // Loaded before applyConfig resolved.
    expect(k.isEnabled('extra')).toBe(true);
    expect(await (await k.http.request('/extra/hello')).json()).toMatchObject({ greeting: 'yo' });
    await k.applyConfig({ ...cfg, modules: { ...cfg.modules } });
    expect(k.isEnabled('extra')).toBe(false);
    expect(footprint(k)).toEqual(NONE);

    // A module that cannot be loaded makes applyConfig fail (so the revision is rolled back).
    await expect(
      k.applyConfig({ ...cfg, modules: { ...cfg.modules, missing: {} } }),
    ).rejects.toThrow(/not available/);
    expect(mgr.list().find((s) => s.id === 'missing')).toMatchObject({
      available: false,
      enabled: false,
    });
  });
});
