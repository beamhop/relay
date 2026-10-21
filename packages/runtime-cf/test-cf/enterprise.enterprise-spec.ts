import {
  createExecutionContext,
  createScheduledController,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Enterprise modules on Cloudflare, inside workerd (real D1, R2, Durable Objects).
import type { Kernel } from '@beamhop/core';
import { complianceInternals } from '@beamhop/enterprise-compliance';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeEvent, makeKey } from '../../testkit/src/fixtures.ts';
import { CLAIM_COLLECTION, CLAIM_KEY, ensureClaimCode } from '../src/index.ts';
import { logs, runtime } from './enterprise-worker.ts';

const DENIED_IP = '203.0.113.9';
const ALLOWED_IP = '198.51.100.7';

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await runtime.worker.fetch(req, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function kernel(): Promise<Kernel> {
  return (await runtime.internals.workerContext(env as never)).kernel;
}

function hold(k: Kernel, pubkey: string, name: string) {
  const st = complianceInternals(k);
  if (!st) throw new Error('compliance module not loaded');
  return st.holds.create(
    {
      name,
      reason: 'litigation',
      scope: { pubkeys: [pubkey], subjects: [], groups: [], relays: [] },
    },
    'test-admin',
  );
}

beforeAll(async () => {
  // Boot once through a real request.
  await call(new Request('https://relay.test/.well-known/beamhop/network'));
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('enterprise modules on Cloudflare (workerd)', () => {
  it('boots with compliance, network, identity and key vault enabled', async () => {
    const k = await kernel();
    for (const id of [
      'enterprise-compliance',
      'enterprise-network',
      'enterprise-identity',
      'enterprise-keyvault',
    ])
      expect(k.isEnabled(id)).toBe(true);
    // The key vault read its master key from the Worker secret (no process.env on Workers).
    expect(k.ports.keyWrapper).toBeDefined();
    const ids = k.health.map((h) => h.id);
    expect(ids).toContain('enterprise-compliance.cloudflare');
    expect(ids).toContain('enterprise-network.proxy-trust');
    for (const h of k.health.filter((x) => x.id.startsWith('enterprise-'))) {
      const r = await h.run(null);
      expect(['ok', 'warn', 'critical']).toContain(r.status);
    }
  });

  it('publishes the per-group outbound relay policy', async () => {
    const res = await call(
      new Request('https://relay.test/.well-known/beamhop/network', {
        headers: { 'cf-connecting-ip': ALLOWED_IP },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      groups: { team1: { outbound: ['wss://partner.example'] } },
      default: { outbound: [] },
    });
  });

  it('rejects connections from a denied network in the Worker, before the Durable Object', async () => {
    const upgrade = await call(
      new Request('https://relay.test/', {
        headers: { upgrade: 'websocket', 'cf-connecting-ip': DENIED_IP },
      }),
    );
    expect(upgrade.status).toBe(403);
    expect(upgrade.webSocket ?? null).toBeNull();
    const http = await call(
      new Request('https://relay.test/', { headers: { 'cf-connecting-ip': DENIED_IP } }),
    );
    expect(http.status).toBe(403);
    expect(await http.text()).toContain('not allowed');

    const ok = await call(
      new Request('https://relay.test/', {
        headers: { upgrade: 'websocket', 'cf-connecting-ip': ALLOWED_IP },
      }),
    );
    expect(ok.status).toBe(101);
    (ok.webSocket as WebSocket).accept();
    (ok.webSocket as WebSocket).close();

    // The block is logged with the hashed address only.
    expect(logs.some((l) => l.includes('blocked by IP deny list'))).toBe(true);
    expect(logs.some((l) => l.includes(DENIED_IP) || l.includes(ALLOWED_IP))).toBe(false);
  });

  it('a legal hold keeps held posts and files from being deleted', async () => {
    const k = await kernel();
    const key = makeKey();
    await hold(k, key.pk, 'Case 1');
    const ev = makeEvent(key, { content: 'evidence' });
    await k.ports.events.save('main', ev);
    await k.ports.events.deleteByIds('main', [ev.id]);
    const archived = await complianceInternals(k)?.holds.archived('main');
    expect(archived?.map((a) => a.event.id)).toContain(ev.id);

    const bytes = new TextEncoder().encode('held file');
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await k.ports.blobs.put({ sha256: sha, size: bytes.length, type: 'text/plain' }, bytes);
    await k.ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: sha,
      pubkey: key.pk,
      size: bytes.length,
      type: 'text/plain',
      uploadedAt: 1,
    });
    await k.ports.blobIndex.removeOwner('main', sha, key.pk);
    expect(await k.ports.blobs.delete(sha)).toBe(false);
    expect(await env.BLOBS.head(sha)).not.toBeNull();
  });

  it('forwards SIEM records to the configured webhook from the cron trigger', async () => {
    const k = await kernel();
    await hold(k, makeKey().pk, 'Case 2');
    await complianceInternals(k)?.siem.settle();

    const received: Array<{ body: string; signature: string | null }> = [];
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get('https://siem.example')
      .intercept({ path: '/ingest', method: 'POST' })
      .reply(200, (opts) => {
        const headers = new Headers(opts.headers as Record<string, string>);
        received.push({
          body: String(opts.body),
          signature: headers.get('x-beamhop-signature'),
        });
        return 'ok';
      })
      .persist();

    const controller = createScheduledController({
      // Far in the future so every interval job is due.
      scheduledTime: Date.now() + 30 * 86400_000,
      cron: '* * * * *',
    });
    const ctx = createExecutionContext();
    const ran = await runtime.worker.scheduled(controller, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(ran).toContain('enterprise-compliance.siem');
    expect(received.length).toBeGreaterThan(0);
    const records = received.flatMap(
      (r) => (JSON.parse(r.body) as { records: Array<{ type: string; summary: string }> }).records,
    );
    expect(records.map((r) => r.type)).toContain('hold.created');
    expect(records.some((r) => r.summary.includes('Case 2'))).toBe(true);
    expect(received[0]?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    const state = await complianceInternals(k)?.siem.state('hook');
    expect(state?.failures).toBe(0);
    expect(state?.sent).toBeGreaterThan(0);
  });

  it('creates the owner claim code once at first boot and logs it once', async () => {
    const stored = await env.DB.prepare('SELECT value FROM docs WHERE collection = ? AND key = ?')
      .bind(CLAIM_COLLECTION, CLAIM_KEY)
      .first<{ value: string }>();
    expect(stored).not.toBeNull();
    const code = (JSON.parse(stored?.value ?? '{}') as { code: string }).code;
    expect(code).toMatch(/\S{4,}/);
    const announced = () => logs.filter((l) => l.includes('your one-time claim code'));
    expect(announced()).toHaveLength(1);
    expect(announced()[0]).toContain(code);

    // A second boot (another isolate) keeps the same code and does not log it again.
    const k = await kernel();
    const ctx = await runtime.internals.workerContext(env as never);
    const outcome = await ensureClaimCode(k, {
      docs: ctx.services.stores.docs,
      logger: ctx.services.logger,
      clock: ctx.services.clock,
    });
    expect(outcome).toBe('existing');
    expect(announced()).toHaveLength(1);
    const again = await env.DB.prepare('SELECT value FROM docs WHERE collection = ? AND key = ?')
      .bind(CLAIM_COLLECTION, CLAIM_KEY)
      .first<{ value: string }>();
    expect((JSON.parse(again?.value ?? '{}') as { code: string }).code).toBe(code);
  });
});
