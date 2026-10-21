// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { createOpenAiCompatibleLLM } from '../src/index.ts';

/** fetch stub that records requests and answers like an OpenAI-compatible server. */
function stub(respond: (body: Record<string, unknown>) => Response) {
  const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = (await req.json()) as Record<string, unknown>;
    seen.push({ url: req.url, headers: req.headers, body });
    return respond(body);
  }) as typeof fetch;
  return { fetchFn, seen };
}

const completion = (message: Record<string, unknown>, finish = 'stop') =>
  Response.json({
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });

describe('OpenAI-compatible adapter (stubbed fetch, no network)', () => {
  test('defaults to Ollama and maps tool calls + usage', async () => {
    const { fetchFn, seen } = stub(() =>
      completion(
        {
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_health', arguments: '{"x":1}' },
            },
          ],
        },
        'tool_calls',
      ),
    );
    const llm = createOpenAiCompatibleLLM({ fetch: fetchFn });
    const r = await llm.chat(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'how are we doing?' },
      ],
      {
        tools: [
          {
            name: 'get_health',
            description: 'Health',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    );
    expect(seen[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect((seen[0]!.body.tools as Array<{ function: { name: string } }>)[0]!.function.name).toBe(
      'get_health',
    );
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'get_health', arguments: '{"x":1}' }]);
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  });

  test('custom URL, key and model; tool results are sent back with their call id', async () => {
    const { fetchFn, seen } = stub(() => completion({ content: 'All good.' }));
    const llm = createOpenAiCompatibleLLM({
      baseUrl: 'https://llm.example/v1/',
      apiKey: 'sk-test',
      model: 'qwen2.5',
      fetch: fetchFn,
    });
    const r = await llm.chat([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c9', name: 'get_cards', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c9', content: '[]' },
    ]);
    expect(r.content).toBe('All good.');
    expect(seen[0]!.url).toBe('https://llm.example/v1/chat/completions');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer sk-test');
    expect(seen[0]!.body.model).toBe('qwen2.5');
    const msgs = seen[0]!.body.messages as Array<Record<string, unknown>>;
    expect(msgs[1]!.tool_calls).toBeDefined();
    expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: 'c9', content: '[]' });
  });

  test('streams text deltas', async () => {
    const chunks = ['Hel', 'lo ', 'there'];
    const { fetchFn, seen } = stub(() => {
      const lines = chunks.map(
        (c) =>
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })}\n\n`,
      );
      lines.push(
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } })}\n\n`,
        'data: [DONE]\n\n',
      );
      return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
    });
    const llm = createOpenAiCompatibleLLM({ fetch: fetchFn });
    const deltas: string[] = [];
    const r = await llm.chat([{ role: 'user', content: 'hi' }], { onText: (d) => deltas.push(d) });
    expect(seen[0]!.body.stream).toBe(true);
    expect(deltas).toEqual(chunks);
    expect(r.content).toBe('Hello there');
    expect(r.usage?.totalTokens).toBe(6);
  });

  test('server errors surface as exceptions', async () => {
    const { fetchFn } = stub(() =>
      Response.json({ error: { message: 'model not found' } }, { status: 404 }),
    );
    const llm = createOpenAiCompatibleLLM({ fetch: fetchFn });
    await expect(llm.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });
});
