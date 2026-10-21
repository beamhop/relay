// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { MemoryDocStore } from '@beamhop/testkit';
import { exportPKCS8, generateKeyPair } from 'jose';
import { COL } from '../src/config.ts';
import { complianceInternals } from '../src/module.ts';
import { type OutboxEntry, verifyOutboxChain } from '../src/siem/exporter.ts';
import { octetFrame, toSyslog } from '../src/siem/format.ts';
import type { SyslogTransportFactory } from '../src/siem/sinks.ts';
import { hmacSha256Hex } from '../src/util.ts';
import { alice, makeKernel, runAction } from './helpers.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(handler?: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return handler ? handler(url, init) : new Response('ok');
  };
  return { calls, fetch };
}

async function seedAudit(docs: MemoryDocStore, n: number, from = 1) {
  let prev = '0'.repeat(64);
  for (let seq = from; seq < from + n; seq++) {
    const hash = seq.toString(16).padStart(64, '0');
    await docs.put('admin.audit', String(seq).padStart(12, '0'), {
      seq,
      at: 1_700_000_000 + seq,
      relayId: null,
      actionId: 'config.update',
      principalId: alice.id,
      input: { x: seq },
      summary: `change ${seq}`,
      ok: true,
      prevHash: prev,
      hash,
    });
    prev = hash;
  }
}

const sinkCfg = (sinks: unknown[], extra: Record<string, unknown> = {}) => ({
  'enterprise-compliance': { siem: { sinks, batchSize: 3, ...extra } },
});

describe('SIEM export', () => {
  test('webhook: batches audit + event log with hash-chain fields and HMAC signature', async () => {
    const { calls, fetch } = mockFetch();
    const docs = new MemoryDocStore();
    const { kernel } = await makeKernel({
      modules: sinkCfg([
        { type: 'webhook', id: 'hook', url: 'https://siem.example/in', secret: 's3cret' },
      ]),
      exporter: { fetch },
      ports: { docs },
    });
    await seedAudit(docs, 4);
    kernel.bus.emit('auth.success', { relayId: 'main', connId: 'c1', pubkey: 'p'.repeat(64) });
    const st = complianceInternals(kernel)!;
    const res = await st.siem.tick();
    expect(res.hook?.sent).toBe(5);
    expect(calls.length).toBe(2); // batchSize 3 → 3 + 2
    const body = String(calls[0]!.init.body);
    const sig = (calls[0]!.init.headers as Record<string, string>)['x-beamhop-signature'];
    expect(sig).toBe(`sha256=${await hmacSha256Hex('s3cret', body)}`);
    const recs = [...JSON.parse(body).records, ...JSON.parse(String(calls[1]!.init.body)).records];
    expect(recs.map((r: { id: string }) => r.id)).toEqual([
      'audit:1',
      'audit:2',
      'audit:3',
      'audit:4',
      'evt:1',
    ]);
    expect(recs[1].chain).toEqual({
      log: 'admin.audit',
      seq: 2,
      prevHash: (1).toString(16).padStart(64, '0'),
      hash: (2).toString(16).padStart(64, '0'),
    });
    expect(recs[4].stream).toBe('auth');
    // Nothing new → no calls.
    await st.siem.tick();
    expect(calls.length).toBe(2);
  });

  test('cursor persists: a restarted node resumes without re-sending', async () => {
    const { calls, fetch } = mockFetch();
    const docs = new MemoryDocStore();
    const mods = sinkCfg([{ type: 'webhook', id: 'hook', url: 'https://siem.example/in' }]);
    const a = await makeKernel({ modules: mods, exporter: { fetch }, ports: { docs } });
    await seedAudit(docs, 2);
    await complianceInternals(a.kernel)!.siem.tick();
    expect(calls.length).toBe(1);

    const b = await makeKernel({ modules: mods, exporter: { fetch }, ports: { docs } });
    await seedAudit(docs, 2, 3);
    await complianceInternals(b.kernel)!.siem.tick();
    expect(calls.length).toBe(2);
    const ids = JSON.parse(String(calls[1]!.init.body)).records.map((r: { id: string }) => r.id);
    expect(ids).toEqual(['audit:3', 'audit:4']);
  });

  test('failures back off and retry from the same cursor', async () => {
    let fail = true;
    const { calls, fetch } = mockFetch(() =>
      fail ? new Response('down', { status: 503 }) : new Response('ok'),
    );
    const docs = new MemoryDocStore();
    const { kernel, ports } = await makeKernel({
      modules: sinkCfg([{ type: 'webhook', id: 'hook', url: 'https://siem.example/in' }]),
      exporter: { fetch },
      ports: { docs },
    });
    await seedAudit(docs, 2);
    const siem = complianceInternals(kernel)!.siem;
    const r1 = await siem.tick();
    expect(r1.hook?.error).toContain('503');
    const st = await siem.state('hook');
    expect(st.failures).toBe(1);
    expect(st.auditSeq).toBe(0);
    await siem.tick(); // still backing off
    expect(calls.length).toBe(1);
    fail = false;
    ports.clock.advance(10);
    const r2 = await siem.tick();
    expect(r2.hook?.sent).toBe(2);
    expect((await siem.state('hook')).failures).toBe(0);
  });

  test('event log is hash-chained and verifiable; outbox is cleaned after export', async () => {
    const { fetch } = mockFetch();
    const docs = new MemoryDocStore();
    const { kernel } = await makeKernel({
      modules: sinkCfg([{ type: 'webhook', id: 'hook', url: 'https://siem.example/in' }]),
      exporter: { fetch },
      ports: { docs },
    });
    for (let i = 0; i < 3; i++)
      kernel.bus.emit('config.changed', { revision: i, principalId: 'x', summary: `rev ${i}` });
    const siem = complianceInternals(kernel)!.siem;
    await siem.settle();
    const entries = (await docs.list<OutboxEntry>(COL.outbox)).items.map((i) => i.value);
    expect(entries).toHaveLength(3);
    expect((await verifyOutboxChain(entries)).ok).toBe(true);
    const tampered = entries.map((e, i) => (i === 1 ? { ...e, summary: 'edited' } : e));
    expect(await verifyOutboxChain(tampered)).toEqual({ ok: false, brokenAt: 2 });
    await siem.tick();
    expect((await docs.list(COL.outbox)).items).toHaveLength(0);
  });

  test('backpressure: bounded outbox drops oldest event records and counts them', async () => {
    let fail = true;
    const { fetch } = mockFetch(() =>
      fail ? new Response('x', { status: 500 }) : new Response('ok'),
    );
    const { kernel, ports } = await makeKernel({
      modules: sinkCfg([{ type: 'webhook', id: 'hook', url: 'https://siem.example/in' }], {
        maxOutbox: 100,
        batchSize: 500,
      }),
      exporter: { fetch },
    });
    const siem = complianceInternals(kernel)!.siem;
    await siem.tick();
    for (let i = 0; i < 150; i++)
      kernel.bus.emit('config.changed', { revision: i, principalId: 'x', summary: `rev ${i}` });
    await siem.settle();
    fail = false;
    ports.clock.advance(3600);
    const r = await siem.tick();
    expect(r.hook?.sent).toBe(100);
    expect((await siem.state('hook')).dropped).toBe(50);
  });

  test('Splunk HEC format', async () => {
    const { calls, fetch } = mockFetch();
    const docs = new MemoryDocStore();
    const { kernel } = await makeKernel({
      modules: sinkCfg([
        {
          type: 'splunk',
          id: 'spl',
          url: 'https://splunk.example:8088',
          token: 'tok',
          index: 'sec',
        },
      ]),
      exporter: { fetch },
      ports: { docs },
    });
    await seedAudit(docs, 2);
    await complianceInternals(kernel)!.siem.tick();
    expect(calls[0]!.url).toBe('https://splunk.example:8088/services/collector/event');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Splunk tok');
    const lines = String(calls[0]!.init.body)
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].index).toBe('sec');
    expect(lines[0].event.chain.seq).toBe(1);
  });

  test('Microsoft Sentinel: client-credentials token, cached, then Logs Ingestion API', async () => {
    const { calls, fetch } = mockFetch((url) =>
      url.includes('/oauth2/')
        ? Response.json({ access_token: 'aad-token', expires_in: 3600 })
        : new Response(null, { status: 204 }),
    );
    const docs = new MemoryDocStore();
    const { kernel } = await makeKernel({
      modules: sinkCfg([
        {
          type: 'sentinel',
          id: 'sent',
          tenantId: 'tenant-1',
          clientId: 'cid',
          clientSecret: 'csecret',
          dceEndpoint: 'https://dce.ingest.monitor.azure.com',
          dcrImmutableId: 'dcr-123',
        },
      ]),
      exporter: { fetch },
      ports: { docs },
    });
    await seedAudit(docs, 4);
    await complianceInternals(kernel)!.siem.tick();
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(String(calls[0]!.init.body)).toContain(
      'scope=https%3A%2F%2Fmonitor.azure.com%2F.default',
    );
    const ingest = calls.filter((c) => c.url.includes('dataCollectionRules'));
    expect(ingest).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    expect(ingest[0]!.url).toBe(
      'https://dce.ingest.monitor.azure.com/dataCollectionRules/dcr-123/streams/Custom-Beamhop_CL?api-version=2023-01-01',
    );
    expect((ingest[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer aad-token',
    );
    const rows = JSON.parse(String(ingest[0]!.init.body));
    expect(rows[0].ChainSeq).toBe(1);
    expect(rows[0].TimeGenerated).toMatch(/^2023-/);
  });

  test('Google Chronicle: service-account JWT exchange, then batchCreate', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const { calls, fetch } = mockFetch((url) =>
      url.includes('oauth2.googleapis.com')
        ? Response.json({ access_token: 'g-token', expires_in: 3600 })
        : Response.json({}),
    );
    const docs = new MemoryDocStore();
    const { kernel } = await makeKernel({
      modules: sinkCfg([
        {
          type: 'chronicle',
          id: 'chr',
          customerId: 'cust-1',
          region: 'europe',
          serviceAccount: { clientEmail: 'sa@proj.iam.gserviceaccount.com', privateKeyPem: pem },
        },
      ]),
      exporter: { fetch },
      ports: { docs },
    });
    await seedAudit(docs, 1);
    await complianceInternals(kernel)!.siem.tick();
    expect(String(calls[0]!.init.body)).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
    );
    expect(calls[1]!.url).toBe(
      'https://europe-malachiteingestion-pa.googleapis.com/v2/unstructuredlogentries:batchCreate',
    );
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(body.customer_id).toBe('cust-1');
    expect(JSON.parse(body.entries[0].log_text).chain.seq).toBe(1);
  });

  test('syslog: RFC 5424 with structured chain data, octet-counted frames', async () => {
    const sent: Uint8Array[] = [];
    const transport: SyslogTransportFactory = async (o) => {
      expect(o).toMatchObject({ host: 'log.example', port: 6514, transport: 'tls' });
      return {
        async send(frames) {
          sent.push(...frames);
        },
        async close() {},
      };
    };
    const docs = new MemoryDocStore();
    const { kernel } = await makeKernel({
      modules: sinkCfg([{ type: 'syslog', id: 'sys', host: 'log.example' }]),
      exporter: { syslogTransport: transport },
      ports: { docs },
    });
    await seedAudit(docs, 2);
    await complianceInternals(kernel)!.siem.tick();
    expect(sent).toHaveLength(2);
    const text = new TextDecoder().decode(sent[0]);
    const [len, ...rest] = text.split(' ');
    expect(Number(len)).toBe(new TextEncoder().encode(rest.join(' ')).length);
    expect(rest.join(' ')).toMatch(
      /^<110>1 2023-\S+ local beamhop - config.update \[beamhop@32473 log="admin.audit" seq="1" hash="0+1" prevHash="0+"/,
    );
  });

  test('syslog escaping and framing helpers', () => {
    const msg = toSyslog(
      {
        id: 'x',
        stream: 'audit',
        type: 'has space',
        at: 0,
        node: 'n',
        relayId: 'r"]\\',
        summary: 's',
        ok: false,
        chain: { log: 'admin.audit', seq: 1, prevHash: 'a', hash: 'b' },
      },
      { facility: 13, appName: 'beamhop', hostname: 'h' },
    );
    expect(msg.startsWith('<108>1 ')).toBe(true);
    expect(msg).toContain('has_space');
    expect(msg).toContain('relay="r\\"\\]\\\\"');
    expect(new TextDecoder().decode(octetFrame('é'))).toBe('2 é');
  });

  test('compliance.test-sink reports success and failure without moving cursors', async () => {
    const { fetch } = mockFetch((url) =>
      url.includes('bad') ? new Response('nope', { status: 401 }) : new Response('ok'),
    );
    const { kernel } = await makeKernel({
      modules: sinkCfg([
        { type: 'webhook', id: 'good', url: 'https://good.example/' },
        { type: 'webhook', id: 'bad', url: 'https://bad.example/' },
      ]),
      exporter: { fetch },
    });
    const r = await runAction(kernel, 'compliance.test-sink', {}, alice);
    const out = r.output as { results: Record<string, { ok: boolean; error?: string }> };
    expect(out.results.good?.ok).toBe(true);
    expect(out.results.bad?.ok).toBe(false);
    expect(out.results.bad?.error).toContain('401');
    expect(r.summary).toContain('1 of 2');
  });
});
