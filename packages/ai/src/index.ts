// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/ai — optional AI assistant (§6.5), off by default.
 *
 * - LLM adapter over any OpenAI-compatible endpoint (Ollama by default);
 * - "chat with the relay": `POST /api/v1/nodes/{node}/assistant` (SSE), tools
 *   generated from the action registry per caller permissions, proposals only;
 * - moderation pre-labels (`ai.labels`) as hints on swipe cards;
 * - `ai.generate-plugin`: plugin + tests → sandbox → installed disabled.
 *
 * The assistant never applies changes on its own (§6.8).
 */
import {
  type BeamhopModule,
  type Kernel,
  type LLM,
  type Principal,
  defineAction,
  defineModule,
} from '@beamhop/core';
import { z } from 'zod';
import {
  type AssistantEvent,
  type AssistantRequest,
  type AssistantResult,
  runAssistant,
} from './assistant.ts';
import { type AiModuleConfig, AiModuleConfigSchema, MODULE_ID } from './config.ts';
import { ErrorRing } from './errors.ts';
import { ModerationLabeler } from './labels.ts';
import { type AiLLM, asAiLLM, createOpenAiCompatibleLLM } from './llm.ts';
import {
  type PluginHostLoader,
  defaultPluginHostLoader,
  generatePluginAction,
} from './plugin-gen.ts';
import { assistantRoutes } from './routes.ts';

export * from './assistant.ts';
export * from './config.ts';
export * from './errors.ts';
export * from './labels.ts';
export * from './llm.ts';
export * from './plugin-gen.ts';
export { AssistantBody } from './routes.ts';
export * from './safety.ts';
export * from './settings.ts';
export * from './tools.ts';

export interface AiModuleOptions {
  /** Use this model instead of `ports.llm` / `config.ai` (tests: `FakeLLM`). */
  llm?: AiLLM | LLM;
  /** fetch for the OpenAI-compatible adapter (proxies, tests). */
  fetch?: typeof fetch;
  /** How to find the plugin host for `ai.generate-plugin`. */
  loadPluginHost?: PluginHostLoader;
  /** Assistant requests per admin per minute (default 20). */
  requestsPerMinute?: number;
}

/** Service exposed as `kernel.use<AiService>('ai')`. */
export interface AiService {
  llm(): AiLLM | undefined;
  ask(
    principal: Principal,
    req: AssistantRequest,
    emit?: (e: AssistantEvent) => void,
    signal?: AbortSignal,
  ): Promise<AssistantResult>;
  readonly labels: ModerationLabeler;
  readonly errors: ErrorRing;
  settings(): AiModuleConfig;
}

interface State {
  labeler: ModerationLabeler;
  cleanup: Array<() => void>;
}

const states = new WeakMap<Kernel, State>();
const LABEL_JOB = 'ai.label-queue';

export function createAiModule(opts: AiModuleOptions = {}): BeamhopModule {
  return defineModule({
    id: MODULE_ID,
    configSchema: AiModuleConfigSchema,
    register(kernel) {
      // Isolation (§12.0): with AI off the module contributes nothing.
      if (!kernel.config().ai.enabled) return;

      let memo: { raw: unknown; parsed: AiModuleConfig } | null = null;
      const settings = (): AiModuleConfig => {
        const raw = kernel.moduleConfig<unknown>(MODULE_ID);
        if (!memo || memo.raw !== raw)
          memo = { raw, parsed: AiModuleConfigSchema.parse(raw ?? {}) };
        return memo.parsed;
      };

      let llmMemo: { key: string; llm: AiLLM } | null = null;
      const llm = (): AiLLM | undefined => {
        const ai = kernel.config().ai;
        if (!ai.enabled) return undefined;
        if (opts.llm) return asAiLLM(opts.llm, ai.model);
        if (kernel.ports.llm) return asAiLLM(kernel.ports.llm, ai.model);
        const key = JSON.stringify([ai.baseUrl, ai.model, ai.apiKey]);
        if (!llmMemo || llmMemo.key !== key) {
          const o: Parameters<typeof createOpenAiCompatibleLLM>[0] = {};
          if (ai.baseUrl) o.baseUrl = ai.baseUrl;
          if (ai.model) o.model = ai.model;
          if (ai.apiKey) o.apiKey = ai.apiKey;
          if (opts.fetch) o.fetch = opts.fetch;
          llmMemo = { key, llm: createOpenAiCompatibleLLM(o) };
        }
        return llmMemo.llm;
      };

      const errors = new ErrorRing(100, () => kernel.ports.clock.now());
      const cleanup = [errors.attach(kernel.bus)];
      const labeler = new ModerationLabeler(kernel, llm, settings);
      states.set(kernel, { labeler, cleanup });

      kernel.actions.register(
        generatePluginAction({
          kernel,
          llm,
          settings,
          loadHost: opts.loadPluginHost ?? defaultPluginHostLoader,
        }),
      );
      kernel.actions.register(
        defineAction({
          id: 'ai.moderation-labels',
          title: 'AI hints for items waiting for review',
          description:
            'The label (spam, abusive, fine) and one-line reason the assistant suggested for each item. Hints only.',
          technical:
            'DocStore ai.labels keyed `${relayId}:${queueItemId}`; produced by the ai.label-queue job.',
          scope: 'relay',
          permission: 'relay.read',
          readOnly: true,
          keywords: ['ai', 'labels', 'moderation', 'queue'],
          input: z.object({ ids: z.array(z.string()).max(500).optional() }),
          async run(input, ctx) {
            const items = await labeler.list(ctx.relayId!, input.ids);
            return { output: { labels: items }, summary: `${items.length} AI hints` };
          },
        }),
      );

      assistantRoutes({ kernel, llm, settings, errors, perMinute: opts.requestsPerMinute });

      const service: AiService = {
        llm,
        settings,
        labels: labeler,
        errors,
        async ask(principal, req, emit, signal) {
          const model = llm();
          if (!model) throw new Error('The assistant is turned off');
          return runAssistant(
            { kernel, llm: model, settings: settings(), errors },
            principal,
            req,
            emit ?? (() => {}),
            signal,
          );
        },
      };
      kernel.provide(MODULE_ID, service);
    },
    start(kernel) {
      const st = states.get(kernel);
      if (!st) return;
      const svc = kernel.use<AiService>(MODULE_ID);
      const interval = svc?.settings().labeling.intervalSeconds ?? 60;
      kernel.ports.scheduler.every(LABEL_JOB, interval, async () => {
        try {
          await st.labeler.runOnce();
        } catch (err) {
          kernel.ports.logger.log('warn', 'ai labeling failed', { error: String(err) });
        }
      });
    },
    stop(kernel) {
      const st = states.get(kernel);
      if (!st) return;
      kernel.ports.scheduler.cancel(LABEL_JOB);
      for (const f of st.cleanup) f();
      states.delete(kernel);
    },
  });
}

export const aiModule = createAiModule();
