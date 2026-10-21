// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `POST /api/v1/nodes/{node}/assistant` — admin auth required. Streams
 * Server-Sent Events by default (`meta`, `text`, `tool-call`, `tool-result`,
 * `proposal`, `error`, `done`); `?stream=0` returns one JSON result.
 *
 * The caller's permissions decide which tools and proposals exist. Proposals
 * are applied only through the standard action / config endpoints.
 */
import { type Kernel, type KernelEnv, type Principal, can } from '@beamhop/core';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { type AssistantEvent, type AssistantRequest, runAssistant } from './assistant.ts';
import type { AiModuleConfig } from './config.ts';
import type { ErrorRing } from './errors.ts';
import type { AiLLM } from './llm.ts';

export const AssistantBody = z.object({
  message: z.string().trim().min(1).max(4000).describe('The question, in your own words'),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(40)
    .optional()
    .describe('Earlier turns of this conversation'),
  context: z
    .object({
      screen: z.string().max(200).optional().describe('Screen the admin is on, e.g. "home"'),
      relayId: z.string().max(100).optional(),
      selection: z.unknown().optional().describe('What is selected on that screen'),
      lens: z.enum(['simple', 'technical']).optional(),
    })
    .optional(),
});

type Ctx = Context<KernelEnv>;

function err(
  c: Ctx,
  status: 400 | 401 | 403 | 404 | 422 | 429 | 503,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

/** Use the principal set by admin-api middleware, else authenticate with the registered providers. */
async function principalFor(c: Ctx, kernel: Kernel): Promise<Principal | undefined> {
  const existing = c.get('principal');
  if (existing) return existing;
  for (const provider of kernel.authProviders) {
    try {
      const p = await provider.authenticate(c.req.raw);
      if (p) return p;
    } catch {
      // try the next provider
    }
  }
  return undefined;
}

export interface AssistantRouteDeps {
  kernel: Kernel;
  llm: () => AiLLM | undefined;
  settings: () => AiModuleConfig;
  errors: ErrorRing;
  /** Max assistant requests per principal per minute. */
  perMinute?: number;
}

export function assistantRoutes(deps: AssistantRouteDeps): void {
  const { kernel } = deps;
  const hits = new Map<string, number[]>();
  const limit = deps.perMinute ?? 20;

  kernel.http.post('/api/v1/nodes/:node/assistant', async (c) => {
    const node = c.req.param('node');
    if (node !== kernel.config().node.id && node !== 'self')
      return err(c, 404, 'unknown_node', 'That server is not part of this setup');
    const principal = await principalFor(c, kernel);
    if (!principal) return err(c, 401, 'unauthenticated', 'Please sign in');

    let raw: unknown;
    try {
      const t = await c.req.text();
      raw = t.trim() ? JSON.parse(t) : {};
    } catch {
      return err(c, 400, 'bad_json', 'The request body is not valid JSON');
    }
    const parsed = AssistantBody.safeParse(raw);
    if (!parsed.success) return err(c, 422, 'invalid_input', 'Please type a question');
    const body = parsed.data;

    const relayId = body.context?.relayId ?? null;
    if (relayId && !kernel.relay(relayId))
      return err(c, 404, 'unknown_relay', `There is no relay called “${relayId}”`);
    if (!can(principal, 'relay.read', relayId))
      return err(c, 403, 'forbidden', "You don't have permission to use the assistant here");

    const llm = deps.llm();
    if (!kernel.config().ai.enabled || !llm)
      return err(
        c,
        503,
        'ai_disabled',
        'The assistant is turned off. Turn it on in Settings → AI.',
      );

    // Simple per-admin rate limit (in-process).
    const now = kernel.ports.clock.nowMs();
    const recent = (hits.get(principal.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit)
      return err(
        c,
        429,
        'rate_limited',
        'Too many questions in a short time. Try again in a minute.',
      );
    recent.push(now);
    hits.set(principal.id, recent);

    const req: AssistantRequest = { message: body.message };
    if (body.history) req.history = body.history;
    if (body.context) {
      req.context = {};
      if (body.context.screen) req.context.screen = body.context.screen;
      if (relayId) req.context.relayId = relayId;
      if (body.context.selection !== undefined) req.context.selection = body.context.selection;
      if (body.context.lens) req.context.lens = body.context.lens;
    }
    const run = (emit: (e: AssistantEvent) => void, signal?: AbortSignal) =>
      runAssistant(
        { kernel, llm, settings: deps.settings(), errors: deps.errors },
        principal,
        req,
        emit,
        signal,
      );

    const wantsJson =
      c.req.query('stream') === '0' ||
      (!!c.req.header('accept')?.includes('application/json') &&
        !c.req.header('accept')?.includes('text/event-stream'));
    if (wantsJson) return c.json(await run(() => {}, c.req.raw.signal));

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      let chain: Promise<unknown> = Promise.resolve();
      let n = 0;
      const emit = (e: AssistantEvent) => {
        const id = String(n++);
        chain = chain.then(() =>
          stream.writeSSE({ event: e.type, data: JSON.stringify(e), id }).catch(() => {}),
        );
      };
      await run(emit, controller.signal);
      await chain;
    });
  });
}
