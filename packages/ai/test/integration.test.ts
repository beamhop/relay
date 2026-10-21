// SPDX-License-Identifier: AGPL-3.0-or-later
/** With the real admin-api: auth middleware, audit log, and approving a proposal through the run endpoint. */
import { describe, expect, test } from 'bun:test';
import { type AuditEntry, adminApiModule } from '@beamhop/admin-api';
import { type AssistantResult, FakeLLM } from '../src/index.ts';
import { boot } from './helpers.ts';

interface AuditSvc {
  list(o: { limit?: number }): Promise<{ items: AuditEntry[] }>;
}

describe('with admin-api', () => {
  test('assistant session is audited; its proposal is applied only via the standard endpoint', async () => {
    const llm = new FakeLLM([
      { toolCalls: [{ name: 'propose_sample_set-limit', args: { perMinute: 15 } }] },
      'I prepared a suggestion. Review it and tap Approve.',
      { toolCalls: [{ name: 'search_audit', args: { query: 'assistant' } }] },
      'You asked me one question before.',
    ]);
    const { kernel, state } = await boot({ llm, extra: [adminApiModule] });
    const headers = { 'content-type': 'application/json', 'x-test-principal': 'owner' };

    const res = await kernel.http.fetch(
      new Request('http://localhost/api/v1/nodes/self/assistant?stream=0', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: 'Please lower the post limit to 15',
          context: { relayId: 'main' },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const r = (await res.json()) as AssistantResult;
    expect(r.proposals).toHaveLength(1);
    expect(state.limit).toBe(120);

    const audit = kernel.use<AuditSvc>('admin.audit')!;
    const entries = (await audit.list({ limit: 10 })).items;
    const session = entries.find((e) => e.actionId === 'ai.assistant')!;
    expect(session.summary).toContain('nothing applied');
    expect(JSON.stringify(session.input)).toContain('sample.set-limit');

    // The admin approves → normal admin-api action route runs it (audited, undoable).
    const p = r.proposals[0]!;
    const approved = await kernel.http.fetch(
      new Request(`http://localhost${p.approve.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(p.approve.body),
      }),
    );
    expect(approved.status).toBe(200);
    expect(state.limit).toBe(15);

    // search_audit sees the earlier session.
    const res2 = await kernel.http.fetch(
      new Request('http://localhost/api/v1/nodes/n1/assistant?stream=0', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: 'What did I ask you before?',
          context: { relayId: 'main' },
        }),
      }),
    );
    const r2 = (await res2.json()) as AssistantResult;
    expect(r2.toolCalls[0]).toMatchObject({ name: 'search_audit', ok: true });
    const toolMsg = llm.calls[3]!.messages.find((m) => m.role === 'tool')!.content;
    expect(toolMsg).toContain('Asked the assistant');
  });
});
