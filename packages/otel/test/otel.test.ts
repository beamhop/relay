// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import {
  type BeamhopModule,
  type Kernel,
  type Principal,
  createKernel,
  dispatchHttp,
  parseConfig,
} from '@beamhop/core';
import { makeEvent, makeKey, memoryPorts } from '@beamhop/testkit';
import {
  OTEL_FLUSH_JOB,
  OTEL_METRICS_JOB,
  OTEL_SERVICE,
  type OtelModuleOptions,
  type OtelService,
  OtlpTraceExporter,
  type SpanData,
  createOtelModule,
  parseTraceparent,
  sanitizeAttributes,
} from '../src/index.ts';

const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };
const ROUTE = { relayId: 'main', publicUrl: 'https://relay.example.com', ipHash: 'iphash-abc' };
const RAW_IP = '203.0.113.77';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Mock OTLP collector: records every request, answers with `status()`. */
function collector(status: () => number = () => 200) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response('{}', { status: status() });
  };
  return { sent, fetch };
}

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status?: { code: number };
};

function spansOf(sent: Sent[]): OtlpSpan[] {
  return sent
    .filter((s) => s.url.endsWith('/v1/traces'))
    .flatMap((s) =>
      (s.body.resourceSpans as Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>).flatMap((r) =>
        r.scopeSpans.flatMap((x) => x.spans),
      ),
    );
}

function attr(span: OtlpSpan, key: string): unknown {
  const v = span.attributes.find((a) => a.key === key)?.value;
  if (!v) return undefined;
  if ('intValue' in v) return Number(v.intValue);
  return Object.values(v)[0];
}

/** Stand-in feature routes (registered after the otel module, like real modules). */
const appRoutes: BeamhopModule = {
  id: 'app',
  register(kernel) {
    kernel.http.get('/items/:id', (c) => c.text('ok'));
    kernel.http.get('/boom', (c) => c.text('fail', 500));
    kernel.http.get('/:file{[0-9a-f]{64}}', (c) => c.text('blob'));
  },
};

async function setup(
  otel: Record<string, unknown> | undefined,
  opts: OtelModuleOptions & { modules?: BeamhopModule[] } = {},
) {
  const ports = memoryPorts();
  const config = parseConfig({
    relays: [{ id: 'main', hosts: ['relay.example.com'] }],
    modules: otel === undefined ? {} : { otel },
  });
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [createOtelModule(opts), appRoutes, ...(opts.modules ?? [])],
  });
  return { kernel, ports };
}

const request = (kernel: Kernel, path: string, headers: Record<string, string> = {}) =>
  dispatchHttp(
    kernel,
    new Request(`https://relay.example.com${path}`, {
      headers: { 'x-forwarded-for': RAW_IP, ...headers },
    }),
    ROUTE,
  );

const svc = (kernel: Kernel) => kernel.use<OtelService>(OTEL_SERVICE) as OtelService;

describe('disabled by default', () => {
  test('no endpoint: nothing registered, zero requests', async () => {
    const c = collector();
    for (const section of [undefined, {}, { sampleRatio: 1 }]) {
      const { kernel, ports } = await setup(section, { fetch: c.fetch, random: () => 0 });
      expect((await request(kernel, '/items/1')).status).toBe(200);
      kernel.bus.emit('req.served', {
        relayId: 'main',
        connId: 'c1',
        filters: 1,
        results: 2,
        latencyMs: 3,
      });
      await ports.scheduler.tickAll();
      expect(ports.scheduler.jobs.has(OTEL_FLUSH_JOB)).toBe(false);
      expect(kernel.use(OTEL_SERVICE)).toBeUndefined();
      expect(kernel.actions.get('otel.status')).toBeUndefined();
    }
    expect(c.sent).toHaveLength(0);
  });
});

describe('http spans', () => {
  test('route pattern, method, status; never the URL, query or IP', async () => {
    const c = collector();
    const { kernel, ports } = await setup(
      {
        endpoint: 'http://collector.test:4318',
        sampleRatio: 1,
        headers: { 'x-scope-orgid': 'acme' },
        secretHeaders: { authorization: 'Bearer t0ken' },
        serviceName: 'relay-eu',
      },
      { fetch: c.fetch },
    );
    await request(kernel, '/items/item-xyz987?token=supersecret&npub=abc');
    await request(kernel, '/boom');
    await request(kernel, `/${'ab'.repeat(32)}`);
    await ports.scheduler.tick(OTEL_FLUSH_JOB);

    expect(c.sent).toHaveLength(1);
    const req = c.sent[0]!;
    expect(req.url).toBe('http://collector.test:4318/v1/traces');
    expect(req.headers.authorization).toBe('Bearer t0ken');
    expect(req.headers['x-scope-orgid']).toBe('acme');
    expect(req.headers['content-type']).toBe('application/json');
    const resource = JSON.stringify(
      (req.body.resourceSpans as Array<{ resource: unknown }>)[0]!.resource,
    );
    expect(resource).toContain('relay-eu');

    const spans = spansOf(c.sent);
    expect(spans.map((s) => s.name)).toEqual(['GET /items/:id', 'GET /boom', 'GET /:file']);
    const [items, boom, blob] = spans as [OtlpSpan, OtlpSpan, OtlpSpan];
    expect(attr(items, 'http.route')).toBe('/items/:id');
    expect(attr(items, 'http.request.method')).toBe('GET');
    expect(attr(items, 'http.response.status_code')).toBe(200);
    expect(attr(items, 'beamhop.relay.id')).toBe('main');
    expect(items.status).toBeUndefined();
    expect(boom.status?.code).toBe(2);
    expect(attr(blob, 'beamhop.blossom.op')).toBe('get');

    const raw = JSON.stringify(req.body);
    for (const leak of [
      'supersecret',
      'npub',
      'item-xyz987',
      RAW_IP,
      'iphash-abc',
      'Bearer',
      'ab'.repeat(32),
    ])
      expect(raw).not.toContain(leak);
  });

  test('W3C traceparent: joins the caller trace and honours its sampled flag', async () => {
    const c = collector();
    const { kernel, ports } = await setup(
      { endpoint: 'http://collector.test:4318', sampleRatio: 0 },
      { fetch: c.fetch },
    );
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parent = '00f067aa0ba902b7';
    await request(kernel, '/items/1', { traceparent: `00-${traceId}-${parent}-01` });
    await request(kernel, '/items/2', { traceparent: `00-${traceId}-${parent}-00` });
    await request(kernel, '/items/3');
    await ports.scheduler.tick(OTEL_FLUSH_JOB);
    const spans = spansOf(c.sent);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toBe(traceId);
    expect(spans[0]!.parentSpanId).toBe(parent);
    expect(spans[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('sampling', () => {
  test('sampleRatio decides root spans', async () => {
    const c = collector();
    const rolls = [0.1, 0.9, 0.4, 0.6];
    let i = 0;
    const { kernel, ports } = await setup(
      { endpoint: 'http://collector.test:4318', sampleRatio: 0.5 },
      { fetch: c.fetch, random: () => rolls[i++ % rolls.length]! },
    );
    for (let n = 0; n < 4; n++) await request(kernel, `/items/${n}`);
    await ports.scheduler.tick(OTEL_FLUSH_JOB);
    expect(spansOf(c.sent)).toHaveLength(2);
  });

  test('sampleRatio 0 records nothing', async () => {
    const c = collector();
    const { kernel, ports } = await setup(
      { endpoint: 'http://collector.test:4318', sampleRatio: 0 },
      { fetch: c.fetch, random: () => 0 },
    );
    await request(kernel, '/items/1');
    kernel.bus.emit('req.served', {
      relayId: 'main',
      connId: 'c',
      filters: 1,
      results: 0,
      latencyMs: 1,
    });
    await ports.scheduler.tick(OTEL_FLUSH_JOB);
    expect(c.sent).toHaveLength(0);
  });
});

describe('relay, blossom and admin spans', () => {
  test('attributes without pubkeys, content or free-text reasons', async () => {
    const c = collector();
    const { kernel, ports } = await setup(
      { endpoint: 'http://collector.test:4318', sampleRatio: 1 },
      { fetch: c.fetch },
    );
    const key = makeKey();
    const event = makeEvent(key, { kind: 1, content: 'my private thoughts' });
    kernel.bus.emit('event.accepted', { relayId: 'main', event, connId: 'c1', latencyMs: 7 });
    kernel.bus.emit('event.rejected', {
      relayId: 'main',
      eventId: event.id,
      pubkey: key.pk,
      kind: 4,
      reason: `blocked: ${key.pk} is not welcome`,
      by: 'plugin.keyword-filter',
    });
    kernel.bus.emit('event.rejected', {
      relayId: 'main',
      eventId: event.id,
      pubkey: key.pk,
      kind: 1,
      reason: 'shadow: spam',
    });
    kernel.bus.emit('req.served', {
      relayId: 'main',
      connId: 'c1',
      filters: 3,
      results: 20,
      latencyMs: 15,
    });
    kernel.bus.emit('blob.uploaded', {
      relayId: 'main',
      sha256: 'f'.repeat(64),
      size: 1234,
      type: 'image/png',
      pubkey: key.pk,
    });
    kernel.bus.emit('admin.action', {
      relayId: null,
      actionId: 'moderation.ban-pubkey',
      principalId: key.pk,
      input: { pubkey: key.pk },
      summary: `Banned ${key.pk}`,
      ok: false,
    });
    await Bun.sleep(5); // admin principal hash is async
    await ports.scheduler.tick(OTEL_FLUSH_JOB);
    const spans = spansOf(c.sent);
    const byName = (n: string) => spans.filter((s) => s.name === n);

    const [accepted, rejected, hidden] = byName('relay.event') as [OtlpSpan, OtlpSpan, OtlpSpan];
    expect(attr(accepted, 'beamhop.event.outcome')).toBe('accepted');
    expect(attr(accepted, 'nostr.event.kind')).toBe(1);
    expect(attr(rejected, 'beamhop.event.outcome')).toBe('rejected');
    expect(attr(rejected, 'beamhop.event.reason')).toBe('blocked');
    expect(attr(rejected, 'beamhop.policy.by')).toBe('plugin.keyword-filter');
    expect(attr(hidden, 'beamhop.event.outcome')).toBe('hidden');
    const req = byName('relay.req')[0]!;
    expect(attr(req, 'beamhop.req.filters')).toBe(3);
    expect(attr(req, 'beamhop.req.results')).toBe(20);
    const up = byName('blossom.upload')[0]!;
    expect(attr(up, 'beamhop.blob.size')).toBe(1234);
    const admin = byName('admin.action')[0]!;
    expect(attr(admin, 'beamhop.admin.action')).toBe('moderation.ban-pubkey');
    expect(attr(admin, 'beamhop.admin.ok')).toBe(false);
    expect(attr(admin, 'beamhop.admin.principal_hash')).toMatch(/^[0-9a-f]{16}$/);
    expect(admin.status?.code).toBe(2);

    const raw = JSON.stringify(c.sent);
    for (const leak of [key.pk, 'private thoughts', 'not welcome', 'spam', 'f'.repeat(64)])
      expect(raw).not.toContain(leak);
  });

  test('status action reports exporter counters', async () => {
    const c = collector();
    const { kernel, ports } = await setup(
      { endpoint: 'http://collector.test:4318', sampleRatio: 1 },
      { fetch: c.fetch },
    );
    await request(kernel, '/items/1');
    await ports.scheduler.tick(OTEL_FLUSH_JOB);
    const action = kernel.actions.get('otel.status')!;
    const res = await action.run({}, { principal: OWNER, relayId: null, ports });
    expect(res.output).toMatchObject({ exported: 1, dropped: 0 });
    expect(res.summary).toBe('1 traces sent, 0 dropped');
    expect(svc(kernel).stats().exported).toBe(1);
  });
});

describe('exporter', () => {
  const span = (n: number): SpanData => ({
    traceId: '1'.repeat(32),
    spanId: n.toString(16).padStart(16, '0'),
    name: `s${n}`,
    kind: 1,
    startMs: 1000,
    endMs: 1001,
    attributes: {},
  });
  const base = (fetch: ReturnType<typeof collector>['fetch']) => ({
    endpoint: () => 'http://collector.test:4318',
    headers: () => ({}),
    resource: () => ({ serviceName: 'beamhop', instanceId: 'n1' }),
    fetch,
    sleep: async () => {},
  });

  test('bounded queue drops on overflow and counts it', async () => {
    const c = collector();
    const ex = new OtlpTraceExporter({ ...base(c.fetch), maxQueue: 3, maxBatch: 2 });
    for (let i = 0; i < 5; i++) ex.enqueue(span(i));
    expect(ex.stats()).toMatchObject({ queued: 3, dropped: 2 });
    await ex.flush();
    expect(c.sent).toHaveLength(2); // batches of 2 + 1
    expect(ex.stats()).toMatchObject({ queued: 0, exported: 3, dropped: 2 });
  });

  test('retries transient failures with backoff, then succeeds', async () => {
    const codes = [503, 429, 200];
    const c = collector(() => codes.shift() ?? 200);
    const delays: number[] = [];
    const ex = new OtlpTraceExporter({
      ...base(c.fetch),
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 1,
      retryBaseMs: 100,
    });
    ex.enqueue(span(1));
    await ex.flush();
    expect(c.sent).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
    expect(ex.stats()).toMatchObject({ exported: 1, retries: 2, failedBatches: 0 });
  });

  test('gives up after max attempts; permanent 4xx is not retried', async () => {
    const down = collector(() => 503);
    const ex = new OtlpTraceExporter({ ...base(down.fetch), maxAttempts: 3 });
    ex.enqueue(span(1));
    await ex.flush();
    expect(down.sent).toHaveLength(3);
    expect(ex.stats()).toMatchObject({ exported: 0, dropped: 1, failedBatches: 1 });
    expect(ex.stats().lastError).toContain('503');

    const bad = collector(() => 400);
    const ex2 = new OtlpTraceExporter({ ...base(bad.fetch), maxAttempts: 3 });
    ex2.enqueue(span(1));
    await ex2.flush();
    expect(bad.sent).toHaveLength(1);
  });

  test('network errors are retried', async () => {
    let calls = 0;
    const ex = new OtlpTraceExporter({
      ...base(async () => {
        calls++;
        if (calls < 2) throw new Error('connection refused');
        return new Response('{}');
      }),
    });
    ex.enqueue(span(1));
    await ex.flush();
    expect(ex.stats()).toMatchObject({ exported: 1, retries: 1 });
  });
});

describe('metrics', () => {
  test('exports insights counters as OTLP metrics when enabled', async () => {
    const c = collector();
    const fakeInsights: BeamhopModule = {
      id: 'insights',
      register(kernel) {
        kernel.provide('insights', {
          startedAt: 1_700_000_000,
          registry: {
            snapshot: () => ({
              counters: [
                {
                  def: { id: 'events.accepted', help: 'Events accepted', type: 'counter' },
                  labels: { relay: 'main' },
                  total: 5,
                },
              ],
              gauges: [],
              summaries: [],
            }),
          },
        });
      },
    };
    const { ports } = await setup(
      {
        endpoint: 'http://collector.test:4318',
        sampleRatio: 0,
        metrics: { enabled: true, intervalSeconds: 30 },
      },
      { fetch: c.fetch, modules: [fakeInsights] },
    );
    expect(ports.scheduler.jobs.get(OTEL_METRICS_JOB)?.interval).toBe(30);
    await ports.scheduler.tick(OTEL_METRICS_JOB);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]!.url).toBe('http://collector.test:4318/v1/metrics');
    expect(JSON.stringify(c.sent[0]!.body)).toContain('events_accepted');
  });
});

describe('helpers', () => {
  test('parseTraceparent rejects invalid headers', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(
      parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-x'),
    ).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
  });

  test('sanitizeAttributes drops unknown keys', () => {
    expect(
      sanitizeAttributes({ 'http.route': '/x', 'client.address': RAW_IP, 'user.id': 'npub1' }),
    ).toEqual({ 'http.route': '/x' });
  });
});
