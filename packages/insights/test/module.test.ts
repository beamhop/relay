// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { MemoryTimeSeries } from '@beamhop/testkit';
import { makeEvent, makeKey } from '@beamhop/testkit';
import {
  type CheckOutcome,
  METRICS,
  MetricsRegistry,
  computeScore,
  formatPrometheus,
  normalizeReason,
} from '../src/index.ts';
import { setup } from './helpers.ts';

describe('collector + flush', () => {
  test('bus events become counters, live rates and time-series points', async () => {
    const { kernel, ports, rt, advance } = await setup();
    const key = makeKey();
    kernel.bus.emit('conn.open', { relayId: 'main', connId: 'c1', ipHash: 'h' });
    kernel.bus.emit('conn.open', { relayId: 'main', connId: 'c2', ipHash: 'h' });
    kernel.bus.emit('conn.close', { relayId: 'main', connId: 'c2', durationMs: 5 });
    for (let i = 0; i < 30; i++)
      kernel.bus.emit('event.accepted', {
        relayId: 'main',
        event: makeEvent(key),
        latencyMs: i + 1,
      });
    for (let i = 0; i < 10; i++)
      kernel.bus.emit('event.rejected', {
        relayId: 'main',
        eventId: 'x',
        pubkey: key.pk,
        kind: 1,
        reason: i < 7 ? 'rate-limited: slow down' : 'weird: thing',
      });
    kernel.bus.emit('req.served', {
      relayId: 'main',
      connId: 'c1',
      filters: 1,
      results: 5,
      latencyMs: 3,
    });
    kernel.bus.emit('error', { source: 'relay.store', message: 'boom', relayId: 'main' });
    await advance(10);

    const live = rt.live('main').relays[0]!;
    expect(live.connections).toBe(1);
    expect(live.eventsPerSecond).toBe(3);
    expect(live.rejectedPerSecond).toBe(1);
    expect(live.rejectedByReason).toEqual({ 'rate-limited': 7, other: 3 });
    expect(live.acceptRatio).toBe(0.75);
    expect(live.p50Ms).toBeGreaterThan(14);
    expect(live.p50Ms).toBeLessThan(17);

    const ts = ports.metrics as MemoryTimeSeries;
    const accepted = ts.points.filter((p) => p.metric === 'events.accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ v: 30, labels: { relay: 'main' } });
    expect(ts.points.some((p) => p.metric === 'event.latency.p95')).toBe(true);
    expect(ts.points.some((p) => p.metric === 'storage.bytes')).toBe(true);

    const series = await rt.series({
      metric: 'events.rejected',
      relayId: 'main',
      from: ports.clock.now() - 60,
      to: ports.clock.now(),
      stepSeconds: 60,
    });
    expect(series.reduce((a, p) => a + p.v, 0)).toBe(10);
  });

  test('normalizeReason bounds cardinality', () => {
    expect(normalizeReason('blocked: banned')).toBe('blocked');
    expect(normalizeReason('pow: difficulty 20')).toBe('pow');
    expect(normalizeReason('something new')).toBe('other');
  });
});

describe('health score', () => {
  const c = (score: number, status: CheckOutcome['status'], weight = 1): CheckOutcome => ({
    id: `c${score}`,
    subsystem: 'relay',
    weight,
    score,
    status,
    message: '',
  });

  test('weighted mean with worst-check cap and status rules', () => {
    expect(computeScore([])).toEqual({ score: 100, status: 'ok' });
    expect(computeScore([c(100, 'ok', 3), c(80, 'ok', 1)])).toEqual({ score: 95, status: 'ok' });
    // one critical check caps the score at its score + 40
    expect(computeScore([c(100, 'ok', 10), c(10, 'critical', 1)])).toEqual({
      score: 50,
      status: 'critical',
    });
    expect(computeScore([c(100, 'ok', 1), c(60, 'warn', 1)])).toEqual({
      score: 80,
      status: 'warn',
    });
    // zero-weight checks don't affect the number but do affect status
    expect(computeScore([c(100, 'ok', 1), c(0, 'warn', 0)])).toEqual({
      score: 100,
      status: 'warn',
    });
  });

  test('backups, certificates and disk providers feed the score', async () => {
    const { kernel, ports, rt } = await setup({
      config: { backups: { enabled: true, schedule: 'daily' } },
      beforeStart: () => {},
    });
    let report = await rt.score(null);
    const backups = report.checks.find((x) => x.id === 'insights.backups')!;
    expect(backups.status).toBe('warn');

    await ports.docs.put('lifecycle.backups', 'last', { at: ports.clock.now() - 3600, ok: true });
    kernel.provide('runtime.tls', {
      certificates: () => [{ host: 'relay.example.com', notAfter: ports.clock.now() + 2 * 86400 }],
    });
    kernel.provide('runtime.disk', { usage: () => ({ freeBytes: 30, totalBytes: 100 }) });
    ports.clock.advance(11);
    report = await rt.score(null);
    const by = Object.fromEntries(report.checks.map((x) => [x.id, x]));
    expect(by['insights.backups']!.status).toBe('ok');
    expect(by['insights.certificates']!.status).toBe('critical');
    expect(by['insights.certificates']!.message).toContain('expires in 2 days');
    expect(by['insights.storage']!.status).toBe('ok');
    expect(report.status).toBe('critical');
    expect(report.score).toBeLessThanOrEqual(50);

    await ports.docs.put('lifecycle.backups', 'last', {
      at: ports.clock.now(),
      ok: false,
      error: 'bucket gone',
    });
    ports.clock.advance(11);
    report = await rt.score(null);
    expect(report.checks.find((x) => x.id === 'insights.backups')!.message).toBe(
      'The last backup failed',
    );
  });

  test('a throwing check counts as warn 50', async () => {
    const { kernel, rt } = await setup();
    kernel.health.push({
      id: 'broken',
      subsystem: 'network',
      weight: 1,
      run: async () => {
        throw new Error('nope');
      },
    });
    const r = await rt.score('main');
    expect(r.checks.find((x) => x.id === 'broken')).toMatchObject({ score: 50, status: 'warn' });
  });
});

describe('prometheus', () => {
  test('text exposition format with HELP/TYPE, escaping, summaries', () => {
    const reg = new MetricsRegistry(0);
    reg.inc(METRICS.eventsAccepted, { relay: 'main' }, 5);
    reg.inc(METRICS.eventsRejected, { relay: 'main', reason: 'say "hi"\\\n' }, 2);
    reg.set(METRICS.connections, { relay: 'main' }, 3);
    reg.observe(METRICS.eventLatency, { relay: 'main' }, 10);
    reg.observe(METRICS.eventLatency, { relay: 'main' }, 20);
    const text = formatPrometheus({ ...reg.snapshot(), constLabels: { node: 'n1' } });
    const lines = text.split('\n');
    expect(text.endsWith('\n')).toBe(true);
    expect(lines).toContain('# HELP beamhop_events_accepted_total Events accepted and stored');
    expect(lines).toContain('# TYPE beamhop_events_accepted_total counter');
    expect(lines).toContain('beamhop_events_accepted_total{node="n1",relay="main"} 5');
    expect(lines).toContain(
      'beamhop_events_rejected_total{node="n1",reason="say \\"hi\\"\\\\\\n",relay="main"} 2',
    );
    expect(lines).toContain('# TYPE beamhop_connections gauge');
    expect(lines).toContain('beamhop_connections{node="n1",relay="main"} 3');
    expect(lines).toContain('# TYPE beamhop_event_latency_milliseconds summary');
    expect(lines).toContain('beamhop_event_latency_milliseconds_sum{node="n1",relay="main"} 30');
    expect(lines).toContain('beamhop_event_latency_milliseconds_count{node="n1",relay="main"} 2');
    expect(
      lines.some((l) =>
        l.startsWith('beamhop_event_latency_milliseconds{node="n1",quantile="0.5",relay="main"}'),
      ),
    ).toBe(true);
    // every sample line is `name{labels} value`
    for (const l of lines.filter((x) => x && !x.startsWith('#')))
      expect(l).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? [-+0-9.eE]+|NaN|[+-]Inf$/);
  });

  test('/metrics requires a bearer token or an admin principal', async () => {
    const token = 'a-very-secret-token-123';
    const { kernel } = await setup({ insights: { prometheus: { token } } });
    kernel.authProviders.push({
      id: 'test',
      label: 'test',
      async authenticate(req) {
        return req.headers.get('x-admin') === 'yes'
          ? { id: 'v', roles: { '*': 'viewer' }, via: 'token' }
          : null;
      },
    });
    const get = (headers: Record<string, string> = {}) =>
      kernel.http.fetch(new Request('https://relay.example.com/metrics', { headers }));
    expect((await get()).status).toBe(401);
    expect((await get({ authorization: 'Bearer wrong-token-wrong-token' })).status).toBe(401);
    const ok = await get({ authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('version=0.0.4');
    expect((await get({ 'x-admin': 'yes' })).status).toBe(200);
  });
});

describe('analytics', () => {
  test('active users, kinds, clients, agents, countries and storage by user', async () => {
    const { kernel, ports, act, rt } = await setup();
    const keys = Array.from({ length: 50 }, () => makeKey());
    for (const k of keys)
      kernel.bus.emit('event.accepted', {
        relayId: 'main',
        event: makeEvent(k, { kind: 1, tags: [['client', 'Amethyst']] }),
        latencyMs: 1,
      });
    for (const k of keys.slice(0, 5))
      kernel.bus.emit('event.accepted', {
        relayId: 'main',
        event: makeEvent(k, { kind: 7 }),
        latencyMs: 1,
      });
    kernel.bus.emit('conn.open', {
      relayId: 'main',
      connId: 'a',
      ipHash: 'h',
      userAgent: 'Damus/1.10 (iOS)',
      country: 'de',
    });
    kernel.bus.emit('conn.open', { relayId: 'main', connId: 'b', ipHash: 'h', country: 'XX' });
    await ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: 'a'.repeat(64),
      pubkey: keys[0]!.pk,
      size: 1000,
      type: 'image/png',
      uploadedAt: ports.clock.now(),
    });
    const res = await act('insights.analytics', { days: 7 });
    const report = res.output as Awaited<ReturnType<typeof rt.analytics>>;
    // HyperLogLog: approximate (±1.6%; small sets may lose one to a register collision)
    expect(Math.abs(report.activeUsers.daily - 50)).toBeLessThanOrEqual(2);
    expect(report.activeUsers.monthly).toBe(report.activeUsers.daily);
    expect(report.dailyActive).toHaveLength(7);
    expect(report.dailyActive.at(-1)).toMatchObject({ newUsers: 50, events: 55 });
    expect(report.topKinds).toEqual([
      { kind: 1, count: 50 },
      { kind: 7, count: 5 },
    ]);
    expect(report.topClients).toEqual([{ name: 'Amethyst', count: 50 }]);
    expect(report.topUserAgents).toEqual([{ name: 'Damus', count: 1 }]);
    expect(report.countries).toEqual([{ country: 'DE', count: 1 }]);
    expect(report.storageByUser).toEqual([{ pubkey: keys[0]!.pk, bytes: 1000, files: 1 }]);
  });

  test('weekly retention cohorts and multi-day uniques', async () => {
    const { kernel, ports, rt } = await setup();
    const a = makeKey();
    const b = makeKey();
    const c = makeKey();
    const post = (k: { pk: string; sk: string }) =>
      kernel.bus.emit('event.accepted', { relayId: 'main', event: makeEvent(k), latencyMs: 1 });
    post(a);
    post(b);
    await rt.flush();
    ports.clock.advance(7 * 86400);
    post(a);
    post(c);
    await rt.flush();
    ports.clock.advance(7 * 86400);
    post(a);
    post(b);
    post(c);
    const report = await rt.analytics('main');
    expect(report.cohorts).toHaveLength(2);
    expect(report.cohorts[0]).toMatchObject({ size: 2, retained: [1, 2] });
    expect(report.cohorts[1]).toMatchObject({ size: 1, retained: [1] });
    expect(report.activeUsers.daily).toBe(3);
    expect(report.activeUsers.weekly).toBe(3);
    expect(report.activeUsers.monthly).toBe(3);
  });

  test('state survives a restart via DocStore', async () => {
    const first = await setup();
    const k = makeKey();
    first.kernel.bus.emit('event.accepted', {
      relayId: 'main',
      event: makeEvent(k, { tags: [['client', 'x']] }),
      latencyMs: 1,
    });
    await first.rt.flush();
    await first.rt.analyticsStore!.flush(first.ports.clock.now());
    const { createInsightsModule } = await import('../src/index.ts');
    const { createKernel, parseConfig } = await import('@beamhop/core');
    const kernel2 = await createKernel({
      runtime: 'test',
      ports: first.ports,
      config: parseConfig({ relays: [{ id: 'main', hosts: ['relay.example.com'] }] }),
      modules: [createInsightsModule()],
    });
    const rt2 = kernel2.use<typeof first.rt>('insights')!;
    kernel2.bus.emit('event.accepted', {
      relayId: 'main',
      event: makeEvent(makeKey()),
      latencyMs: 1,
    });
    const r = await rt2.analytics('main');
    expect(r.activeUsers.daily).toBe(2);
    expect(r.topClients).toEqual([{ name: 'x', count: 1 }]);
  });
});

describe('rollups, retention, OTLP, actions', () => {
  test('hourly rollups answer queries past raw retention; prune removes raw', async () => {
    const { kernel, ports, rt } = await setup({ insights: { retention: { rawHours: 2 } } });
    const ts = ports.metrics as MemoryTimeSeries;
    ports.clock.ms = Math.floor(ports.clock.ms / 3_600_000) * 3_600_000;
    const start = ports.clock.now();
    for (let h = 0; h < 4; h++) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < h + 1; j++)
          kernel.bus.emit('event.accepted', {
            relayId: 'main',
            event: makeEvent(makeKey()),
            latencyMs: 5,
          });
        ports.clock.advance(600);
        await rt.flush();
      }
      await rt.maintain();
    }
    expect(ts.points.every((p) => p.t >= ports.clock.now() - 2 * 3600)).toBe(true);
    const old = await rt.series({
      metric: 'events.accepted',
      relayId: 'main',
      from: start,
      to: ports.clock.now(),
      stepSeconds: 3600,
    });
    // flushes stamped exactly on the hour boundary land in the next hour
    expect(old.map((p) => p.v)).toEqual([5, 11, 17, 23]);
  });

  test('stop() unsubscribes from config changes (no OTLP job revived after stop)', async () => {
    const { createInsightsModule } = await import('../src/index.ts');
    const { parseConfig } = await import('@beamhop/core');
    const { kernel, ports } = await setup();
    const mod = createInsightsModule();
    // A second instance on the same kernel shares the per-kernel subscription slot.
    await mod.stop?.(kernel);
    expect(ports.scheduler.jobs.has('insights.otlp')).toBe(false);
    await kernel.applyConfig(
      parseConfig({
        relays: [{ id: 'main', hosts: ['relay.example.com'] }],
        modules: { insights: { otlp: { endpoint: 'https://otel.example.com' } } },
      }),
    );
    expect(ports.scheduler.jobs.has('insights.otlp')).toBe(false);
  });

  test('OTLP export posts JSON to /v1/metrics via injected fetch', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const { kernel, ports } = await setup({
      insights: { otlp: { endpoint: 'https://otel.example.com', headers: { 'x-key': 'k' } } },
      options: {
        fetch: async (url, init) => {
          calls.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
            headers: init?.headers as Record<string, string>,
          });
          return new Response('{}', { status: 200 });
        },
      },
    });
    kernel.bus.emit('event.accepted', {
      relayId: 'main',
      event: makeEvent(makeKey()),
      latencyMs: 4,
    });
    await ports.scheduler.tick('insights.otlp');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://otel.example.com/v1/metrics');
    expect(calls[0]!.headers['x-key']).toBe('k');
    const body = calls[0]!.body as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{ metrics: Array<{ name: string; sum?: { dataPoints: unknown[] } }> }>;
      }>;
    };
    const metrics = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const acc = metrics.find((m) => m.name === 'beamhop_events_accepted')!;
    expect(acc.sum!.dataPoints[0]).toMatchObject({ asDouble: 1 });
    expect(metrics.some((m) => m.name === 'beamhop_event_latency_milliseconds')).toBe(true);
  });

  test('read-only actions', async () => {
    const { act, kernel } = await setup();
    for (const id of ['insights.overview', 'insights.series', 'insights.analytics']) {
      const def = kernel.actions.get(id)!;
      expect(def.readOnly).toBe(true);
      expect(def.permission).toBe('insights.read');
      expect(def.technical).toBeTruthy();
    }
    const o = await act('insights.overview', {});
    expect(o.summary).toContain('Health');
    const s = await act('insights.series', { metric: 'events.accepted', hours: 1 });
    expect((s.output as { points: unknown[] }).points).toEqual([]);
  });
});

describe('uptime', () => {
  test('daily up ratio from relay.up samples; gaps count as down; rollups for old days', async () => {
    const { ports, rt, advance } = await setup({ insights: { retention: { rawHours: 2 } } });
    expect(await rt.uptime('main', 7)).toEqual([]);
    ports.clock.ms = (Math.floor(ports.clock.ms / 86_400_000) * 86_400 + 6 * 3600) * 1000;
    await rt.flush();
    await advance(3600); // up for an hour
    await rt.maintain();
    ports.clock.advance(3600); // node down for an hour (no samples)
    await rt.maintain();
    await advance(3600);
    await rt.maintain();
    let days = await rt.uptime('main', 3);
    expect(days).toHaveLength(1);
    expect(days[0]!.upRatio).toBeGreaterThan(0.6);
    expect(days[0]!.upRatio).toBeLessThan(0.7);
    // next day: day one now answered from hourly rollups
    ports.clock.advance(20 * 3600);
    for (let h = 0; h < 4; h++) {
      await advance(3600);
      await rt.maintain();
    }
    days = await rt.uptime('main', 3);
    expect(days).toHaveLength(2);
    expect(days[0]!.upRatio).toBeGreaterThan(0.05);
    // down 00:00-05:00, up 05:00-09:00
    expect(days[1]!.upRatio).toBeCloseTo(4 / 9, 1);
  });
});

describe('grafana dashboard', () => {
  test('ships valid JSON that only uses exported metric names', async () => {
    const { METRIC_DEFS, promName } = await import('../src/index.ts');
    const dash = (await import('../grafana/beamhop.json')).default as {
      panels: Array<{ targets: Array<{ expr: string }> }>;
    };
    const names = new Set([...METRIC_DEFS.values()].map((d) => promName(d)));
    const used = dash.panels.flatMap((p) =>
      p.targets.map((t) => t.expr.match(/beamhop_[a-z_]+/)?.[0]),
    );
    expect(used.length).toBeGreaterThan(10);
    for (const n of used) expect(names.has(n!)).toBe(true);
  });
});
