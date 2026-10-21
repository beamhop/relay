// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type KernelEnv, defineModule } from '@beamhop/core';
import { FakeClock, MemoryLogger } from '@beamhop/testkit';
import type { Context } from 'hono';
import { AlarmScheduler } from '../src/ports/scheduler.ts';
import { CONFIG_CHANNEL } from '../src/room.ts';
import { FakeStorage, setup, upgradeRequest } from './fakes.ts';

const routeEcho = defineModule({
  id: 'route-echo',
  register(kernel) {
    kernel.http.get('*', (c: Context<KernelEnv>) => c.json(c.var.route));
  },
});

describe('Worker fetch routing', () => {
  test('HTTP goes to kernel.http with the resolved virtual relay', async () => {
    const ctx = setup({ modules: [routeEcho] });
    const res = await ctx.runtime.worker.fetch(
      new Request('https://beta.example/beta/info', {
        headers: { 'cf-connecting-ip': '198.51.100.7' },
      }),
      ctx.env,
    );
    expect(res.status).toBe(200);
    const route = (await res.json()) as { relayId: string; publicUrl: string; ipHash: string };
    expect(route.relayId).toBe('beta');
    expect(route.publicUrl).toBe('https://beta.example/beta');
    expect(route.ipHash).toMatch(/^[0-9a-f]{32}$/);

    const alpha = await ctx.runtime.worker.fetch(
      new Request('https://ALPHA.example:443/'),
      ctx.env,
    );
    expect(((await alpha.json()) as { relayId: string }).relayId).toBe('alpha');
  });

  test('unknown host → 404 in plain language', async () => {
    const ctx = setup({ modules: [routeEcho] });
    const res = await ctx.runtime.worker.fetch(new Request('https://nope.example/'), ctx.env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('No relay');
  });

  test('WebSocket upgrades go to the relay shard room with hashed IP only', async () => {
    const ctx = setup();
    await ctx.runtime.worker.fetch(
      upgradeRequest('https://beta.example/beta', {
        'cf-connecting-ip': '198.51.100.7',
        'x-forwarded-for': '198.51.100.7',
      }),
      ctx.env,
    );
    const req = ctx.ns.requests.at(-1);
    expect(req?.name).toBe('beta#0');
    expect(req?.headers.get('x-beamhop-relay')).toBe('beta');
    expect(req?.headers.get('x-beamhop-shard')).toBe('0');
    expect(req?.headers.get('x-beamhop-ip-hash')).toMatch(/^[0-9a-f]{32}$/);
    expect(req?.headers.get('cf-connecting-ip')).toBeNull();
    expect(req?.headers.get('x-forwarded-for')).toBeNull();
  });

  test('cf-ipcountry reaches RouteContext and the room; spoofed headers are dropped', async () => {
    const ctx = setup({ modules: [routeEcho] });
    const res = await ctx.runtime.worker.fetch(
      new Request('https://alpha.example/', { headers: { 'cf-ipcountry': 'de' } }),
      ctx.env,
    );
    expect(((await res.json()) as { country?: string }).country).toBe('DE');
    const unknown = await ctx.runtime.worker.fetch(
      new Request('https://alpha.example/', { headers: { 'cf-ipcountry': 'XX' } }),
      ctx.env,
    );
    expect(((await unknown.json()) as { country?: string }).country).toBeUndefined();

    const ws = setup();
    await ws.runtime.worker.fetch(
      upgradeRequest('https://alpha.example/', { 'cf-ipcountry': 'NL' }),
      ws.env,
    );
    expect(ws.ns.requests.at(-1)?.headers.get('x-beamhop-country')).toBe('NL');
    await ws.runtime.worker.fetch(
      upgradeRequest('https://alpha.example/', { 'x-beamhop-country': 'FR' }),
      ws.env,
    );
    expect(ws.ns.requests.at(-1)?.headers.get('x-beamhop-country')).toBeNull();
  });

  test('client-supplied x-beamhop headers are overwritten', async () => {
    const ctx = setup();
    await ctx.runtime.worker.fetch(
      upgradeRequest('https://alpha.example/', { 'x-beamhop-relay': 'beta' }),
      ctx.env,
    );
    expect(ctx.ns.requests.at(-1)?.headers.get('x-beamhop-relay')).toBe('alpha');
  });

  test('kernel is cached per isolate (env)', async () => {
    const ctx = setup({ modules: [routeEcho] });
    const a = await ctx.runtime.internals.workerContext(ctx.env);
    const b = await ctx.runtime.internals.workerContext(ctx.env);
    expect(a.kernel).toBe(b.kernel);
  });

  test('BEAMHOP_CONFIG overrides the bundled config', async () => {
    const ctx = setup({
      modules: [routeEcho],
      env: {
        BEAMHOP_CONFIG: JSON.stringify({ relays: [{ id: 'solo', hosts: ['solo.example'] }] }),
      },
    });
    const res = await ctx.runtime.worker.fetch(new Request('https://solo.example/'), ctx.env);
    expect(((await res.json()) as { relayId: string }).relayId).toBe('solo');
  });

  test('memory fallback is used and logged when bindings are missing', async () => {
    const ctx = setup();
    const { services } = await ctx.runtime.internals.workerContext(ctx.env);
    expect(services.stores.sources.events).toBe('memory');
    expect(ctx.logs.some((l) => l.includes('temporary memory storage'))).toBe(true);
  });

  test('config changes in the Worker are broadcast to rooms', async () => {
    const ctx = setup();
    const w = await ctx.runtime.internals.workerContext(ctx.env);
    const sent: unknown[] = [];
    const orig = w.pubsub.publish.bind(w.pubsub);
    w.pubsub.publish = async (ch, m) => {
      sent.push([ch, m]);
      return orig(ch, m);
    };
    const next = { ...w.kernel.config() };
    await w.kernel.applyConfig(next);
    expect(sent[0]).toEqual([CONFIG_CHANNEL, next]);
    // Every shard of every relay is targeted.
    expect(w.pubsub.targets(CONFIG_CHANNEL)).toEqual(['alpha#0', 'beta#0']);
  });
});

describe('Cron Triggers → Scheduler', () => {
  test('jobs run once per interval across cron ticks', async () => {
    const runs: number[] = [];
    const jobs = defineModule({
      id: 'jobs',
      register() {},
      start(kernel) {
        kernel.ports.scheduler.every('retention', 120, async () => {
          runs.push(kernel.ports.clock.nowMs());
        });
        kernel.ports.scheduler.every('fails', 60, async () => {
          throw new Error('boom');
        });
      },
    });
    const ctx = setup({ modules: [jobs] });
    const t0 = 1_700_000_000_000;
    const cron = (t: number) =>
      ctx.runtime.worker.scheduled({ scheduledTime: t, cron: '* * * * *' }, ctx.env);
    expect(await cron(t0)).toEqual(['fails', 'retention']);
    expect(await cron(t0 + 60_000)).toEqual(['fails']);
    expect(await cron(t0 + 120_000)).toEqual(['fails', 'retention']);
    expect(runs.length).toBe(2);
    expect(ctx.logs.some((l) => l.includes('Scheduled job failed'))).toBe(true);
  });
});

describe('Durable Object alarms → Scheduler', () => {
  test('sub-minute jobs run on alarms while sockets are open; others are left to cron', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(1_000_000);
    let active = true;
    const logger = new MemoryLogger();
    const s = new AlarmScheduler(storage, clock, logger, () => active);
    let flushes = 0;
    s.every('flush', 5, async () => {
      flushes++;
    });
    s.every('retention', 3600, async () => {});
    expect(s.skipped.has('retention')).toBe(true);
    await s.arm();
    expect(await storage.getAlarm()).toBe(1_005_000);

    clock.ms = 1_005_000;
    storage.alarm = null; // the runtime clears the alarm when it fires
    expect(await s.onAlarm()).toEqual(['flush']);
    expect(flushes).toBe(1);
    expect(await storage.getAlarm()).toBe(1_010_000);

    // Next-run times survive hibernation.
    const s2 = new AlarmScheduler(storage, clock, logger, () => active);
    s2.every('flush', 5, async () => {});
    storage.alarm = null;
    await s2.restore();
    expect(await storage.getAlarm()).toBe(1_010_000);

    // No sockets → no re-arm, so the room can hibernate.
    active = false;
    clock.ms = 1_010_000;
    storage.alarm = null;
    await s2.onAlarm();
    expect(await storage.getAlarm()).toBeNull();
  });
});
