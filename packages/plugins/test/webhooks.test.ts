// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { assertPublicUrl, isInternalHostname, isPrivateAddress } from '../src/net/ssrf.ts';
import {
  DEAD_COLLECTION,
  QUEUE_COLLECTION,
  RETRY_JOB,
  type WebhookDispatcher,
  backoffSeconds,
  createWebhooksModule,
  signPayload,
  verifySignature,
} from '../src/webhooks/index.ts';
import { bootKernel, ev, runAction } from './helpers.ts';

const SECRET = 'a-very-secret-shared-key';

interface Seen {
  url: string;
  headers: Headers;
  body: string;
}

function recorder(statuses: number[] = []) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    return new Response('ok', { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  return { seen, fetchFn };
}

async function boot(fetchFn: typeof fetch, hooks: unknown[], extra: Record<string, unknown> = {}) {
  const r = await bootKernel({ modules: { webhooks: { hooks, ...extra } } }, [
    createWebhooksModule({
      fetch: fetchFn,
      resolveHost: async (h) => (h === 'internal.example.com' ? ['10.1.2.3'] : ['93.184.216.34']),
    }),
  ]);
  return { ...r, w: r.kernel.use<WebhookDispatcher>('webhooks')! };
}

describe('ssrf guard', () => {
  test('classifies addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.20.1.1',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '100.64.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
    expect(isInternalHostname('localhost')).toBe(true);
    expect(isInternalHostname('db.internal')).toBe(true);
    expect(isInternalHostname('intranet')).toBe(true);
    expect(isInternalHostname('example.com')).toBe(false);
  });

  test('blocks private targets, odd schemes and encodings unless allowed', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/x')).rejects.toThrow('Private');
    await expect(assertPublicUrl('http://2130706433/')).rejects.toThrow('Private');
    await expect(assertPublicUrl('http://[::1]:8080/')).rejects.toThrow('Private');
    await expect(assertPublicUrl('ftp://example.com/')).rejects.toThrow('http');
    await expect(assertPublicUrl('https://u:p@example.com/')).rejects.toThrow('passwords');
    await expect(
      assertPublicUrl('https://internal.example.com/', { resolveHost: async () => ['10.0.0.1'] }),
    ).rejects.toThrow('private');
    await assertPublicUrl('https://example.com/hook');
    await assertPublicUrl('http://127.0.0.1/x', { allowPrivate: true });
  });
});

describe('webhooks', () => {
  test('signature helpers round-trip', async () => {
    const sig = await signPayload(SECRET, 100, '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifySignature(SECRET, 100, '{"a":1}', sig)).toBe(true);
    expect(await verifySignature(SECRET, 101, '{"a":1}', sig)).toBe(false);
    expect(await verifySignature('other-secret-value!!', 100, '{"a":1}', sig)).toBe(false);
  });

  test('delivers matching app events with a verifiable signature', async () => {
    const { seen, fetchFn } = recorder();
    const { kernel, w } = await boot(fetchFn, [
      {
        id: 'blobs',
        url: 'https://hooks.example.com/in',
        events: ['blob.uploaded'],
        secret: SECRET,
      },
    ]);
    kernel.bus.emit('blob.uploaded', {
      relayId: 'default',
      sha256: 'f'.repeat(64),
      size: 3,
      type: 'x',
      pubkey: 'p',
    });
    kernel.bus.emit('report.received', { relayId: 'default', report: ev('r') }); // not subscribed
    await w.flush();
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    const body = JSON.parse(s.body);
    expect(body).toMatchObject({ webhook: 'blobs', type: 'blob.uploaded', data: { size: 3 } });
    expect(s.headers.get('X-Beamhop-Event')).toBe('blob.uploaded');
    const ts = Number(s.headers.get('X-Beamhop-Timestamp'));
    expect(await verifySignature(SECRET, ts, s.body, s.headers.get('X-Beamhop-Signature')!)).toBe(
      true,
    );
    expect(w.stat('blobs').delivered).toBe(1);
  });

  test('nostr event filters', async () => {
    const { seen, fetchFn } = recorder();
    const { kernel, w } = await boot(fetchFn, [
      { id: 'zaps', url: 'https://hooks.example.com/z', filter: { kinds: [9735] }, secret: SECRET },
    ]);
    kernel.bus.emit('event.accepted', { relayId: 'default', event: ev('note', 1), latencyMs: 1 });
    kernel.bus.emit('event.accepted', { relayId: 'default', event: ev('zap', 9735), latencyMs: 1 });
    await w.flush();
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      type: 'nostr.event',
      data: { event: { kind: 9735 } },
    });
  });

  test('retries with exponential backoff, then dead-letters', async () => {
    const { seen, fetchFn } = recorder([500, 502, 503]);
    const { kernel, ports, w } = await boot(
      fetchFn,
      [{ id: 'h', url: 'https://hooks.example.com/x', events: ['config.changed'], secret: SECRET }],
      { maxAttempts: 3, baseDelaySeconds: 10 },
    );
    kernel.bus.emit('config.changed', { revision: 2, principalId: 'o', summary: 's' });
    await w.flush();
    expect(seen).toHaveLength(1);
    let q = (await ports.docs.list(QUEUE_COLLECTION)).items;
    expect(q).toHaveLength(1);
    expect((q[0]!.value as { nextAt: number }).nextAt).toBe(ports.clock.now() + 10);

    await ports.scheduler.tick(RETRY_JOB); // not due yet
    expect(seen).toHaveLength(1);
    ports.clock.advance(10);
    await ports.scheduler.tick(RETRY_JOB);
    expect(seen).toHaveLength(2);
    q = (await ports.docs.list(QUEUE_COLLECTION)).items;
    expect((q[0]!.value as { nextAt: number }).nextAt).toBe(ports.clock.now() + 20);
    ports.clock.advance(20);
    await ports.scheduler.tick(RETRY_JOB);
    expect(seen).toHaveLength(3);
    expect((await ports.docs.list(QUEUE_COLLECTION)).items).toHaveLength(0);
    const dead = (await ports.docs.list(DEAD_COLLECTION)).items;
    expect(dead).toHaveLength(1);
    expect(dead[0]!.value).toMatchObject({ attempt: 3, lastStatus: 503 });
    expect(w.stat('h')).toMatchObject({ failedAttempts: 3, deadLettered: 1, delivered: 0 });
    // Same delivery id across attempts (receivers can dedupe).
    const ids = new Set(seen.map((s) => s.headers.get('X-Beamhop-Delivery')));
    expect(ids.size).toBe(1);
    expect(await w.deadLetters('h')).toHaveLength(1);
  });

  test('a retry that succeeds stops the backoff', async () => {
    const { seen, fetchFn } = recorder([500, 204]);
    const { kernel, ports, w } = await boot(fetchFn, [
      { id: 'h', url: 'https://hooks.example.com/x', events: ['error'], secret: SECRET },
    ]);
    kernel.bus.emit('error', { source: 't', message: 'm' });
    await w.flush();
    ports.clock.advance(backoffSeconds(1, { baseDelaySeconds: 10, maxDelaySeconds: 3600 }));
    await ports.scheduler.tick(RETRY_JOB);
    expect(seen).toHaveLength(2);
    expect(w.stat('h')).toMatchObject({ delivered: 1, failedAttempts: 1, lastStatus: 204 });
    expect((await ports.docs.list(QUEUE_COLLECTION)).items).toHaveLength(0);
  });

  test('private targets are dead-lettered immediately and never fetched', async () => {
    const { seen, fetchFn } = recorder();
    const { kernel, ports, w } = await boot(fetchFn, [
      { id: 'a', url: 'http://169.254.169.254/latest', events: ['error'], secret: SECRET },
      { id: 'b', url: 'https://internal.example.com/x', events: ['error'], secret: SECRET },
    ]);
    kernel.bus.emit('error', { source: 't', message: 'm' });
    await w.flush();
    expect(seen).toHaveLength(0);
    expect((await ports.docs.list(DEAD_COLLECTION)).items).toHaveLength(2);
  });

  test('backoff is capped', () => {
    expect(backoffSeconds(1, { baseDelaySeconds: 10, maxDelaySeconds: 60 })).toBe(10);
    expect(backoffSeconds(3, { baseDelaySeconds: 10, maxDelaySeconds: 60 })).toBe(40);
    expect(backoffSeconds(9, { baseDelaySeconds: 10, maxDelaySeconds: 60 })).toBe(60);
  });

  test('actions: add, list (no secrets), test, remove', async () => {
    const { seen, fetchFn } = recorder();
    const { kernel, w } = await boot(fetchFn, []);
    const added = await runAction(kernel, 'webhooks.add', {
      url: 'https://hooks.example.com/new',
      events: ['report.received'],
    });
    const { id, secret } = added.result.output as { id: string; secret: string };
    expect(secret).toHaveLength(64);
    expect(added.preview[0]!.text).toContain('hooks.example.com');

    const list = await runAction(kernel, 'webhooks.list', {});
    const hooks = (list.result.output as { hooks: Array<Record<string, unknown>> }).hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.secret).toBeUndefined();

    // Newly added hooks are live without restart.
    kernel.bus.emit('report.received', { relayId: 'default', report: ev('r') });
    await w.flush();
    expect(seen).toHaveLength(1);

    const t = await runAction(kernel, 'webhooks.test', { id });
    expect(t.result.output).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(seen[1]!.body).type).toBe('ping');

    const bad = await kernel.actions.get('webhooks.add')!.preview!(
      { url: 'http://localhost:9000/', events: [] } as never,
      {
        principal: { id: 'o', roles: { '*': 'owner' }, via: 'cli' },
        relayId: null,
        ports: kernel.ports,
      },
    );
    expect(bad.some((l) => l.kind === 'warning')).toBe(true);
    await expect(
      runAction(kernel, 'webhooks.add', { url: 'http://localhost:9000/', events: ['error'] }),
    ).rejects.toThrow('Private');

    await runAction(kernel, 'webhooks.remove', { id });
    kernel.bus.emit('report.received', { relayId: 'default', report: ev('r') });
    await w.flush();
    expect(seen).toHaveLength(2);
  });
});
