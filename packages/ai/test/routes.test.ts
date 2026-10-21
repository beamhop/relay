// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type AiService, FakeLLM } from '../src/index.ts';
import { boot, parseSse } from './helpers.ts';

const URL_ = 'http://localhost/api/v1/nodes/n1/assistant';

function post(body: unknown, who?: string, extra: Record<string, string> = {}, url = URL_) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (who) headers['x-test-principal'] = who;
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('POST /api/v1/nodes/:node/assistant', () => {
  test('streams SSE: meta, text, tool calls, proposals, done', async () => {
    const llm = new FakeLLM([
      {
        toolCalls: [
          { name: 'get_health' },
          { name: 'propose_sample_set-limit', args: { perMinute: 60 } },
        ],
      },
      'Health is fine. I prepared a suggestion to halve the limit.',
    ]);
    const { kernel, state } = await boot({ llm });
    const res = await kernel.http.fetch(
      post(
        { message: 'Should I halve the limit?', context: { screen: 'home', relayId: 'main' } },
        'owner',
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('meta');
    expect(names).toContain('tool-call');
    expect(names).toContain('tool-result');
    expect(names).toContain('proposal');
    expect(names.filter((n) => n === 'text').length).toBeGreaterThan(1);
    expect(names.at(-1)).toBe('done');
    const done = events.at(-1)!.data as {
      type: string;
      result: { proposals: Array<{ actionId: string; diffLines: unknown[] }>; text: string };
    };
    expect(done.type).toBe('done');
    expect(done.result.proposals[0]!.actionId).toBe('sample.set-limit');
    expect(done.result.proposals[0]!.diffLines).toHaveLength(1);
    expect(state.limit).toBe(120);
    // Context of the screen reached the model.
    expect(llm.calls[0]!.messages.at(-1)!.content).toContain('Current screen: home (relay main)');
  });

  test('?stream=0 returns one JSON result', async () => {
    const { kernel } = await boot({ llm: new FakeLLM(['Fine.']) });
    const res = await kernel.http.fetch(
      post({ message: 'How are we doing?' }, 'owner', {}, `${URL_}?stream=0`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; proposals: unknown[] };
    expect(body.text).toBe('Fine.');
    expect(body.proposals).toEqual([]);
  });

  test('requires sign-in and relay access', async () => {
    const { kernel } = await boot();
    expect((await kernel.http.fetch(post({ message: 'hi' }))).status).toBe(401);
    expect(
      (await kernel.http.fetch(post({ message: 'hi', context: { relayId: 'team' } }, 'mainMod')))
        .status,
    ).toBe(403);
    expect((await kernel.http.fetch(post({ message: 'hi' }, 'mainMod'))).status).toBe(403);
    expect(
      (await kernel.http.fetch(post({ message: 'hi', context: { relayId: 'nope' } }, 'owner')))
        .status,
    ).toBe(404);
    expect((await kernel.http.fetch(post({ message: '' }, 'owner'))).status).toBe(422);
    expect(
      (
        await kernel.http.fetch(
          post({ message: 'hi' }, 'owner', {}, 'http://localhost/api/v1/nodes/other/assistant'),
        )
      ).status,
    ).toBe(404);
  });

  test('a relay moderator only gets the tools they may use', async () => {
    const llm = new FakeLLM(['ok']);
    const { kernel } = await boot({ llm });
    const res = await kernel.http.fetch(
      post(
        { message: 'Can you ban spammers?', context: { relayId: 'main' } },
        'mainMod',
        {},
        `${URL_}?stream=0`,
      ),
    );
    expect(res.status).toBe(200);
    const offered = llm.calls[0]!.tools.map((t) => t.name);
    expect(offered).toContain('propose_sample_ban-user');
    expect(offered).not.toContain('propose_sample_set-limit');
    expect(offered).not.toContain('propose_node_restart');
  });

  test('rate-limits each admin', async () => {
    const { kernel } = await boot({ llm: new FakeLLM([], 'ok'), ai: { requestsPerMinute: 2 } });
    for (let i = 0; i < 2; i++)
      expect(
        (await kernel.http.fetch(post({ message: 'hi' }, 'owner', {}, `${URL_}?stream=0`))).status,
      ).toBe(200);
    expect(
      (await kernel.http.fetch(post({ message: 'hi' }, 'owner', {}, `${URL_}?stream=0`))).status,
    ).toBe(429);
  });

  test('module contributes nothing when AI is disabled', async () => {
    const { kernel } = await boot({ enabled: false });
    expect(kernel.use<AiService>('ai')).toBeUndefined();
    expect(kernel.actions.get('ai.generate-plugin')).toBeUndefined();
    expect((await kernel.http.fetch(post({ message: 'hi' }, 'owner'))).status).toBe(404);
  });
});
