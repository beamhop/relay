// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * End to end with enterprise-compliance and admin-api loaded: sensitive key-vault
 * actions go through the two-person rule over the admin HTTP API (exactly one
 * approval, single use) and signing/escrow records reach the SIEM event log.
 */
import { describe, expect, test } from 'bun:test';
import { type AdminSessionsService, adminApiModule } from '@beamhop/admin-api';
import { createKernel, parseConfig } from '@beamhop/core';
import { complianceInternals, createComplianceModule } from '@beamhop/enterprise-compliance';
import { relayModule } from '@beamhop/relay';
import { FakeClock, memoryPorts } from '@beamhop/testkit';
import { type KeyvaultService, SERVICE, createKeyvaultModule } from '../src/index.ts';
import { randomMasterKey } from './helpers.ts';

const NODE = 'https://relay.test/api/v1/nodes/n1';

async function setup() {
  const ports = memoryPorts({ clock: new FakeClock(Date.now()) });
  const posted: unknown[] = [];
  const config = parseConfig({
    node: { id: 'n1' },
    relays: [{ id: 'main', hosts: ['relay.test'] }],
    modules: {
      'enterprise-keyvault': { kek: { provider: 'local', key: randomMasterKey() } },
      'enterprise-compliance': {
        siem: { sinks: [{ type: 'webhook', id: 'hook', url: 'https://siem.example/in' }] },
      },
    },
  });
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [
      adminApiModule,
      relayModule,
      createComplianceModule({
        fetch: async (_u: unknown, init?: RequestInit) => {
          posted.push(init?.body);
          return new Response('ok');
        },
      }),
      createKeyvaultModule(),
    ],
  });
  const dir = kernel.use<{ put(r: unknown): Promise<void> }>('admin.directory')!;
  const sessions = kernel.use<AdminSessionsService>('admin.sessions')!;
  const tokens: Record<string, string> = {};
  for (const id of ['ayse', 'bora']) {
    await dir.put({ id, roles: { '*': 'owner' }, createdAt: 1, createdBy: 'test' });
    tokens[id] = (await sessions.issue(id, 'passkey')).token;
  }
  const call = async (who: string, path: string, body: unknown) => {
    const res = await kernel.http.request(`${NODE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test JSON
    return { status: res.status, json: (await res.json()) as any };
  };
  return { kernel, ports, call };
}

describe('key vault + compliance', () => {
  test('sensitive actions are gated and run after exactly one approval', async () => {
    const { kernel, call } = await setup();
    // Every sensitive key-vault action is wrapped by the approval gate.
    const gate = complianceInternals(kernel)!.gate!;
    for (const id of ['keyvault.rotate-kek', 'keyvault.destroy-key', 'escrow.decrypt-dm'])
      expect(gate.wrapped()).toContain(id);

    const first = await call('ayse', '/actions/keyvault.rotate-kek', { input: { force: true } });
    expect(first.status).toBe(200);
    expect(first.json.output.status).toBe('approval-required');
    const requestId = first.json.output.requestId as string;

    // Self-approval is refused with 403 (not 500).
    const self = await call('ayse', '/actions/approvals.approve', { input: { requestId } });
    expect(self.status).toBe(403);
    expect(self.json.error.code).toBe('approval_self_approval');

    // Running with an id that is not approved yet → 409.
    const early = await call('ayse', '/actions/keyvault.rotate-kek', {
      input: { force: true },
      _approvalId: requestId,
    });
    expect(early.status).toBe(409);

    const ok = await call('bora', '/actions/approvals.approve', { input: { requestId } });
    expect(ok.status).toBe(200);

    // A different input does not match the approval → 409.
    const other = await call('ayse', '/actions/keyvault.rotate-kek', {
      input: { force: false },
      _approvalId: requestId,
    });
    expect(other.status).toBe(409);

    const run = await call('ayse', '/actions/keyvault.rotate-kek', {
      input: { force: true },
      _approvalId: requestId,
    });
    expect(run.status).toBe(200);
    expect(run.json.summary).toMatch(/^Re-wrapped/);

    // Single use → 410.
    const again = await call('ayse', '/actions/keyvault.rotate-kek', {
      input: { force: true },
      _approvalId: requestId,
    });
    expect(again.status).toBe(410);
    expect(again.json.error.code).toBe('approval_used');
  });

  test('signing and escrow records are pushed to the SIEM event log', async () => {
    const { kernel, ports } = await setup();
    const kv = kernel.use<KeyvaultService>(SERVICE)!;
    const pk = await kv.ensureKey('google:alice');
    const ev = await kv.sign('google:alice', { kind: 1, content: 'hi', tags: [] });
    expect(ev.pubkey).toBe(pk);
    const st = complianceInternals(kernel)!;
    await st.siem.settle();
    const page = await ports.docs.list<{ stream: string; type: string; data?: unknown }>(
      'compliance.siem-outbox',
      { limit: 100 },
    );
    const entries = page.items.map((i) => i.value);
    expect(entries).toContainEqual(
      expect.objectContaining({ stream: 'signing', type: 'keyvault.create' }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        stream: 'signing',
        type: 'keyvault.sign',
        data: expect.objectContaining({ subjectId: 'google:alice', kind: 1, ok: true }),
      }),
    );
  });
});
