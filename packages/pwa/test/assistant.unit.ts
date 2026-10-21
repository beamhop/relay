// SPDX-License-Identifier: AGPL-3.0-or-later
/** AI assistant chat: SSE streaming, event folding, context, proposal safety. */
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, type StoredSession } from '../src/lib/api/client.ts';
import type { LiveMessage } from '../src/lib/api/types.ts';
import {
  type AssistantProposal,
  type ChatTurn,
  applyEvent,
  assistantInCatalog,
  historyOf,
  isAiOff,
  parseEvent,
  safeApprovePath,
  screenName,
} from '../src/lib/assistant.ts';

const tokens = (s: StoredSession | null = { token: 't', expiresAt: 4_000_000_000 }) => ({
  get: () => s,
  set: () => {},
});

const proposal: AssistantProposal = {
  id: 'p1',
  kind: 'action',
  actionId: 'moderation.ban-pubkey',
  title: 'Block account',
  input: { pubkeys: ['b'.repeat(64)] },
  diffLines: [{ kind: 'add', text: '1 account will be blocked' }],
  relayId: 'main',
  sensitive: false,
  undoable: true,
  requiresApproval: true,
  approve: {
    method: 'POST',
    path: '/api/v1/nodes/local/relays/main/actions/moderation.ban-pubkey',
    body: { input: { pubkeys: ['b'.repeat(64)] }, reason: 'Suggested by the assistant' },
  },
};

function sse(events: Array<{ type: string; [k: string]: unknown }>): string {
  return events
    .map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\nid: ${i}\n\n`)
    .join('');
}

const turn = (): ChatTurn => ({
  id: 2,
  role: 'assistant',
  text: '',
  tools: [],
  proposals: [],
  pending: true,
});

describe('assistant', () => {
  it('is available when the catalog has ai.* actions', () => {
    expect(assistantInCatalog([{ id: 'moderation.keep' }])).toBe(false);
    expect(assistantInCatalog([{ id: 'ai.moderation-labels' }])).toBe(true);
  });

  it('names the current screen for the context', () => {
    expect(screenName('/')).toBe('home');
    expect(screenName('/activity', '?tab=queue')).toBe('activity/queue');
    expect(screenName('/settings/access')).toBe('settings/access');
    expect(screenName('/people', '?tab=team')).toBe('people/team');
    expect(screenName('/settings/goals', '?tab=x')).toBe('settings/goals');
  });

  it('streams the SSE answer from POST /assistant with the context', async () => {
    const body = sse([
      { type: 'meta', sessionId: 's', tools: ['read_health'], proposalsAllowed: true },
      { type: 'tool-call', id: 'c1', name: 'read_health', kind: 'read', args: {} },
      { type: 'tool-result', id: 'c1', name: 'read_health', ok: true, summary: 'Checked health' },
      { type: 'text', delta: 'All good. ' },
      { type: 'text', delta: 'One spammer.' },
      { type: 'proposal', proposal },
      { type: 'done', result: { sessionId: 's', text: 'All good. One spammer.', proposals: [] } },
    ]);
    const fetch = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const api = new ApiClient({ origin: 'http://x', fetch, tokens: tokens() });
    const t = turn();
    const msgs: LiveMessage[] = [];
    await api.assistant(
      {
        message: 'How are we doing?',
        context: { screen: 'home', relayId: 'main', lens: 'simple' },
      },
      (m) => {
        msgs.push(m);
        const e = parseEvent(m.event, m.data);
        if (e) applyEvent(t, e);
      },
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://x/api/v1/nodes/self/assistant');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
    expect(JSON.parse(String(init.body)).context).toEqual({
      screen: 'home',
      relayId: 'main',
      lens: 'simple',
    });
    expect(msgs).toHaveLength(7);
    expect(t.text).toBe('All good. One spammer.');
    expect(t.tools).toEqual([
      {
        id: 'c1',
        name: 'read_health',
        kind: 'read',
        args: {},
        ok: true,
        summary: 'Checked health',
      },
    ]);
    expect(t.proposals).toEqual([{ proposal, state: 'pending' }]);
    expect(t.pending).toBe(false);
  });

  it('reports the assistant as off (503 ai_disabled)', async () => {
    const api = new ApiClient({
      origin: 'http://x',
      fetch: async () =>
        Response.json(
          { error: { code: 'ai_disabled', message: 'The assistant is turned off.' } },
          { status: 503 },
        ),
      tokens: tokens(),
    });
    const err = await api.assistant({ message: 'hi' }, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isAiOff(err)).toBe(true);
    expect(isAiOff(new ApiError(500, 'boom', 'x'))).toBe(false);
  });

  it('folds errors and keeps the final text when nothing streamed', () => {
    const t = turn();
    applyEvent(t, { type: 'error', code: 'timeout', message: 'The assistant took too long.' });
    applyEvent(t, {
      type: 'done',
      result: { sessionId: 's', text: 'Partial', stopped: 'timeout' },
    });
    expect(t.error?.code).toBe('timeout');
    expect(t.text).toBe('Partial');
    expect(t.stopped).toBe('timeout');
    // a duplicate proposal is ignored
    applyEvent(t, { type: 'proposal', proposal });
    applyEvent(t, { type: 'proposal', proposal });
    expect(t.proposals).toHaveLength(1);
  });

  it('sends only finished turns as history', () => {
    const turns: ChatTurn[] = [
      { id: 1, role: 'user', text: 'Q', tools: [], proposals: [], pending: false },
      { id: 2, role: 'assistant', text: 'A', tools: [], proposals: [], pending: false },
      { id: 3, role: 'assistant', text: '', tools: [], proposals: [], pending: true },
    ];
    expect(historyOf(turns)).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: 'A' },
    ]);
  });

  it('approves only standard admin-API endpoints', () => {
    expect(safeApprovePath(proposal.approve.path)).toBe(proposal.approve.path);
    expect(safeApprovePath('/api/v1/nodes/local/config/commit')).toBe(
      '/api/v1/nodes/local/config/commit',
    );
    expect(safeApprovePath('/api/v1/nodes/local/relays/main/config/commit')).not.toBeNull();
    expect(safeApprovePath('https://evil.example/api/v1/nodes/local/config/commit')).toBeNull();
    expect(safeApprovePath('/api/v1/nodes/local/auth/logout')).toBeNull();
    expect(safeApprovePath('/api/v1/nodes/local/actions/../undo/x')).toBeNull();
    expect(safeApprovePath(42)).toBeNull();
  });

  it('runs the approve call on the absolute path', async () => {
    const fetch = vi.fn(async () => Response.json({ output: {}, summary: 'Blocked 1 account' }));
    const api = new ApiClient({ origin: 'http://x', fetch, tokens: tokens() });
    const r = await api.approveProposal<{ summary: string }>(
      proposal.approve.path,
      proposal.approve.body,
    );
    expect(r.summary).toBe('Blocked 1 account');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://x${proposal.approve.path}`);
    expect(JSON.parse(String(init.body))).toEqual(proposal.approve.body);
  });
});
