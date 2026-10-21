// SPDX-License-Identifier: AGPL-3.0-or-later
/** `ai-setup.list-models`: model ids from an OpenAI-compatible `/models`, with the assistant off. */
import { describe, expect, test } from 'bun:test';
import { createKernel, parseConfig } from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { Hono } from 'hono';
import { type ListModelsOutput, createAiSetupModule } from '../src/setup.ts';
import { P } from './helpers.ts';

/** Fake provider: OpenAI shape on /v1, Ollama shape on /ollama, key-checked on /private. */
function provider() {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    seen.push({ url: c.req.url, auth: c.req.header('authorization') ?? null });
    await next();
  });
  app.get('/v1/models', (c) =>
    c.json({ data: [{ id: 'qwen3' }, { id: 'llama3.1' }, { id: 'qwen3' }] }),
  );
  app.get('/ollama/models', (c) => c.json({ models: [{ name: 'mistral' }] }));
  app.get('/private/models', (c) =>
    c.req.header('authorization') === 'Bearer sk-saved'
      ? c.json({ data: [{ id: 'gpt-x' }] })
      : c.json({ error: 'no' }, 401),
  );
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(new Request(input, init))) as typeof fetch;
  return { fetchFn, seen };
}

async function setup(ai: Record<string, unknown> = {}) {
  const p = provider();
  const kernel = await createKernel({
    runtime: 'bun',
    ports: memoryPorts(),
    config: parseConfig({ relays: [{ id: 'main', hosts: ['main.test'] }], ai }),
    modules: [createAiSetupModule({ fetch: p.fetchFn })],
  });
  const def = kernel.actions.get('ai-setup.list-models')!;
  const run = (input: Record<string, unknown>) =>
    def
      .run(def.input.parse(input), { principal: P.owner, relayId: null, ports: kernel.ports })
      .then((r) => r.output as ListModelsOutput);
  return { kernel, def, run, ...p };
}

describe('ai-setup.list-models', () => {
  test('works while AI is off, sorted and de-duplicated', async () => {
    const { kernel, def, run } = await setup();
    expect(kernel.config().ai.enabled).toBe(false);
    expect(def.readOnly).toBe(true);
    expect(def.permission).toBe('config.write');
    const out = await run({ baseUrl: 'http://llm.test/v1/' });
    expect(out.models).toEqual(['llama3.1', 'qwen3']);
    expect((await run({ baseUrl: 'http://llm.test/ollama' })).models).toEqual(['mistral']);
  });

  test('the saved key is used only for the saved address', async () => {
    const { run, seen } = await setup({ baseUrl: 'http://llm.test/private', apiKey: 'sk-saved' });
    // Masked key from the form = the saved key, same address → allowed.
    expect((await run({ baseUrl: 'http://llm.test/private', apiKey: '•••' })).models).toEqual([
      'gpt-x',
    ]);
    // Another address never receives the saved key.
    await run({ baseUrl: 'http://llm.test/v1', apiKey: '•••' });
    expect(seen.at(-1)).toEqual({ url: 'http://llm.test/v1/models', auth: null });
  });

  test('plain errors for a refused key and an unreachable or wrong address', async () => {
    const { run } = await setup();
    await expect(run({ baseUrl: 'http://llm.test/private', apiKey: 'bad' })).rejects.toThrow(
      'refused the key',
    );
    await expect(run({ baseUrl: 'http://llm.test/nothing' })).rejects.toThrow('error (404)');
  });
});
