// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Setup helper for the AI settings screen, loaded even while the assistant is off:
 * `ai-setup.list-models` asks an OpenAI-compatible endpoint which models it offers
 * (`GET {baseUrl}/models`), so the admin can pick one instead of typing its name.
 *
 * Kept apart from the `ai` module (isolation, §12.0): no LLM, no routes, no jobs —
 * one read-only action that only returns model ids.
 */
import { type BeamhopModule, defineAction, defineModule } from '@beamhop/core';
import { z } from 'zod';
import { DEFAULT_OLLAMA_URL } from './config.ts';

export const SETUP_MODULE_ID = 'ai-setup';
const MASK = '•••';
const TIMEOUT_MS = 8000;
const MAX_MODELS = 500;

export interface ListModelsOutput {
  baseUrl: string;
  models: string[];
}

/** `GET {baseUrl}/models` → sorted model ids (OpenAI `{data:[{id}]}`, also Ollama's `{models:[{name}]}`). */
export async function listModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Error(
      `Could not reach ${baseUrl}. Check the address and that the service is running.`,
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new Error('The AI service refused the key. Check the API key.');
  if (!res.ok) throw new Error(`The AI service answered with an error (${res.status}).`);
  const body = (await res.json().catch(() => null)) as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ name?: unknown; id?: unknown }>;
  } | null;
  const raw = body?.data ?? body?.models;
  if (!Array.isArray(raw)) throw new Error('That address does not look like an AI service.');
  const ids = new Set<string>();
  for (const m of raw) {
    const id = (m as { id?: unknown }).id ?? (m as { name?: unknown }).name;
    if (typeof id === 'string' && id) ids.add(id);
    if (ids.size >= MAX_MODELS) break;
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function createAiSetupModule(opts: { fetch?: typeof fetch } = {}): BeamhopModule {
  return defineModule({
    id: SETUP_MODULE_ID,
    register(kernel) {
      kernel.actions.register(
        defineAction({
          id: 'ai-setup.list-models',
          title: 'Find AI models',
          description: 'Ask your AI service which models it offers.',
          technical:
            'GET {baseUrl}/models (OpenAI-compatible); returns model ids only. The saved key is sent only to the saved address.',
          scope: 'node',
          permission: 'config.write',
          readOnly: true,
          outbound: true,
          keywords: ['ai', 'models', 'assistant', 'ollama', 'openai'],
          input: z.object({
            baseUrl: z.string().url().optional(),
            apiKey: z.string().optional(),
          }),
          async run(input) {
            const saved = kernel.config().ai;
            const baseUrl = input.baseUrl ?? saved.baseUrl ?? DEFAULT_OLLAMA_URL;
            // A masked or missing key means "the saved one" — but never send it to another address.
            const typed = input.apiKey && input.apiKey !== MASK ? input.apiKey : undefined;
            const apiKey = typed ?? (baseUrl === saved.baseUrl ? saved.apiKey : undefined);
            const models = await listModels(baseUrl, apiKey, opts.fetch);
            return {
              output: { baseUrl, models } satisfies ListModelsOutput,
              summary: `${models.length} models found`,
            };
          },
        }),
      );
    },
  });
}

export const aiSetupModule = createAiSetupModule();
