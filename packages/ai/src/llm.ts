// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * LLM adapters implementing the core `LLM` port:
 * - `createOpenAiCompatibleLLM`: Vercel AI SDK + `@ai-sdk/openai-compatible`
 *   (Ollama by default, any OpenAI-compatible URL). fetch only → runs on Bun and Workers.
 * - `FakeLLM`: deterministic scripted model for tests (never touches the network).
 *
 * `AiLLM` is a superset of the core port: optional streaming callback, output
 * cap and reported usage. A plain core `LLM` is adapted with `asAiLLM`.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ChatMessage, LLM, ToolSpec } from '@beamhop/core';
import {
  type ModelMessage,
  type Tool,
  type ToolSet,
  generateText,
  jsonSchema,
  streamText,
} from 'ai';
import { DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from './config.ts';

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type AiChatResult = ChatMessage & { usage?: ChatUsage };

export interface AiChatOptions {
  tools?: ToolSpec[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  /** Stream text deltas as they arrive (tool calls are still returned at the end). */
  onText?: (delta: string) => void;
}

export interface AiLLM extends LLM {
  /** Model id for audit / labels. */
  readonly model?: string;
  chat(messages: ChatMessage[], opts?: AiChatOptions): Promise<AiChatResult>;
}

/** Adapt a plain core LLM port (e.g. `ports.llm` from a runtime). */
export function asAiLLM(llm: LLM, model?: string): AiLLM {
  const maybe = llm as Partial<AiLLM>;
  if (typeof maybe.chat === 'function' && 'model' in llm) return llm as AiLLM;
  return {
    model,
    chat: (messages, opts) => llm.chat(messages, { tools: opts?.tools, signal: opts?.signal }),
  };
}

export interface OpenAiCompatibleOptions {
  /** Default: Ollama at http://localhost:11434/v1 */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const names = new Map<string, string>();
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content });
    else if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (!m.toolCalls?.length) {
        out.push({ role: 'assistant', content: m.content });
        continue;
      }
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        names.set(c.id, c.name);
        parts.push({
          type: 'tool-call',
          toolCallId: c.id,
          toolName: c.name,
          input: parseArgs(c.arguments),
        });
      }
      out.push({ role: 'assistant', content: parts });
    } else {
      const id = m.toolCallId ?? 'call';
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: id,
            toolName: names.get(id) ?? 'tool',
            output: { type: 'text', value: m.content },
          },
        ],
      });
    }
  }
  return out;
}

export function parseArgs(s: string): unknown {
  if (!s?.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function toToolSet(tools: ToolSpec[] | undefined): ToolSet | undefined {
  if (!tools?.length) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
    } as Tool;
  }
  return set;
}

function usageOf(
  u: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
) {
  if (!u) return undefined;
  const usage: ChatUsage = {};
  if (typeof u.inputTokens === 'number') usage.inputTokens = u.inputTokens;
  if (typeof u.outputTokens === 'number') usage.outputTokens = u.outputTokens;
  if (typeof u.totalTokens === 'number') usage.totalTokens = u.totalTokens;
  return usage;
}

/** OpenAI-compatible chat model (Ollama, LM Studio, vLLM, OpenAI, OpenRouter, …). */
export function createOpenAiCompatibleLLM(opts: OpenAiCompatibleOptions = {}): AiLLM {
  const modelId = opts.model ?? DEFAULT_MODEL;
  const settings: Parameters<typeof createOpenAICompatible>[0] = {
    name: 'beamhop',
    baseURL: (opts.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, ''),
    includeUsage: true,
  };
  if (opts.apiKey) settings.apiKey = opts.apiKey;
  if (opts.fetch) settings.fetch = opts.fetch;
  if (opts.headers) settings.headers = opts.headers;
  const model = createOpenAICompatible(settings).chatModel(modelId);

  return {
    model: modelId,
    async chat(messages, o = {}) {
      // System prompts go through `system` (not the message list).
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const common = {
        model,
        system: system || undefined,
        messages: toModelMessages(messages.filter((m) => m.role !== 'system')),
        tools: toToolSet(o.tools),
        abortSignal: o.signal,
        maxOutputTokens: o.maxOutputTokens,
        temperature: o.temperature ?? opts.temperature,
        maxRetries: 1,
      };
      if (!o.onText) {
        const r = await generateText(common);
        const out: AiChatResult = { role: 'assistant', content: r.text ?? '' };
        if (r.toolCalls.length)
          out.toolCalls = r.toolCalls.map((c) => ({
            id: c.toolCallId,
            name: c.toolName,
            arguments: JSON.stringify(c.input ?? {}),
          }));
        const usage = usageOf(r.usage);
        if (usage) out.usage = usage;
        return out;
      }
      const r = streamText(common);
      let text = '';
      const calls: NonNullable<ChatMessage['toolCalls']> = [];
      let usage: ChatUsage | undefined;
      for await (const part of r.fullStream) {
        if (part.type === 'text-delta') {
          text += part.text;
          o.onText(part.text);
        } else if (part.type === 'tool-call') {
          calls.push({
            id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          });
        } else if (part.type === 'finish') {
          usage = usageOf(part.totalUsage);
        } else if (part.type === 'error') {
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }
      const out: AiChatResult = { role: 'assistant', content: text };
      if (calls.length) out.toolCalls = calls;
      if (usage) out.usage = usage;
      return out;
    },
  };
}

// ───────────────────────────── FakeLLM ─────────────────────────────

export interface FakeToolCall {
  name: string;
  args?: unknown;
  id?: string;
}

/** One scripted reply: text, tool calls, or a function of the conversation. */
export type FakeReply =
  | string
  | { text?: string; toolCalls?: FakeToolCall[]; usage?: ChatUsage }
  | ((messages: ChatMessage[], opts: AiChatOptions) => FakeReply | Promise<FakeReply>);

/**
 * Deterministic LLM for tests. Replies are consumed in order; when the script
 * runs out, `fallback` is used. Every call is recorded in `calls`.
 */
export class FakeLLM implements AiLLM {
  readonly model = 'fake';
  readonly calls: Array<{ messages: ChatMessage[]; tools: ToolSpec[] }> = [];
  private seq = 0;

  constructor(
    private readonly script: FakeReply[] = [],
    private readonly fallback: FakeReply = 'OK.',
  ) {}

  push(...replies: FakeReply[]): this {
    this.script.push(...replies);
    return this;
  }

  async chat(messages: ChatMessage[], opts: AiChatOptions = {}): Promise<AiChatResult> {
    if (opts.signal?.aborted) throw new Error('aborted');
    this.calls.push({ messages: structuredClone(messages), tools: opts.tools ?? [] });
    let reply: FakeReply = this.script.length ? this.script.shift()! : this.fallback;
    while (typeof reply === 'function') reply = await reply(messages, opts);
    const r = typeof reply === 'string' ? { text: reply } : reply;
    const text = r.text ?? '';
    if (opts.onText && text)
      for (const piece of text.match(/\S+\s*|\s+/g) ?? []) opts.onText(piece);
    const out: AiChatResult = { role: 'assistant', content: text };
    if (r.toolCalls?.length)
      out.toolCalls = r.toolCalls.map((c) => ({
        id: c.id ?? `call_${++this.seq}`,
        name: c.name,
        arguments: JSON.stringify(c.args ?? {}),
      }));
    out.usage = r.usage ?? {
      inputTokens: Math.ceil(JSON.stringify(messages).length / 4),
      outputTokens: Math.ceil(
        (text.length + (out.toolCalls ? JSON.stringify(out.toolCalls).length : 0)) / 4,
      ),
    };
    return out;
  }
}
