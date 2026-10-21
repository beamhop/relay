// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Chat with the relay" (§6.5, §6.9): a bounded tool-calling loop over the
 * caller's permitted tools. Read tools run; propose tools only produce
 * previews → `proposals[]`. Nothing is ever applied here (§6.8).
 *
 * Safety: untrusted data (selection, tool output, event content) is fenced;
 * proposals unlock only when the admin's own words ask for a change; token
 * budget, round/tool-call caps and an overall timeout bound every request;
 * the session (question, tools called, proposals) is written to the audit log.
 */
import type { ChatMessage, Kernel, Principal, RelayId, ToolSpec } from '@beamhop/core';
import type { AiModuleConfig } from './config.ts';
import type { ErrorRing } from './errors.ts';
import { type AiLLM, type ChatUsage, parseArgs } from './llm.ts';
import {
  Budget,
  TimeoutError,
  UNTRUSTED_RULES,
  estimateTokens,
  hasChangeIntent,
  promptJson,
  scrubText,
  truncate,
  untrusted,
  withTimeout,
} from './safety.ts';
import { type AssistantTool, type Proposal, type ToolEnv, toolsFor } from './tools.ts';

export interface AssistantContext {
  /** PWA screen the admin is on, e.g. `home`, `activity/moderation`, `settings/access`. */
  screen?: string;
  relayId?: RelayId;
  /** What is selected on that screen (an event, a user, a card…). Treated as untrusted data. */
  selection?: unknown;
  /** `technical` asks for NIP numbers, kinds and config paths. */
  lens?: 'simple' | 'technical';
}

export interface AssistantRequest {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: AssistantContext;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  kind: AssistantTool['kind'] | 'unknown';
  args: unknown;
  ok: boolean;
  summary: string;
}

export type AssistantEvent =
  | { type: 'meta'; sessionId: string; tools: string[]; proposalsAllowed: boolean }
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; id: string; name: string; kind: ToolCallRecord['kind']; args: unknown }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; result: AssistantResult };

export interface AssistantResult {
  sessionId: string;
  text: string;
  proposals: Proposal[];
  toolCalls: ToolCallRecord[];
  usage: { tokens: number; limit: number; rounds: number };
  /** Why the loop ended early, if it did. */
  stopped?: 'budget' | 'timeout' | 'rounds' | 'error' | 'aborted';
}

export interface AssistantDeps {
  kernel: Kernel;
  llm: AiLLM;
  settings: AiModuleConfig;
  errors?: ErrorRing;
}

const NOT_APPLIED_NOTE =
  '\n\n(Nothing has been changed. Any suggestion above only takes effect after you approve it.)';
const CLAIMS_APPLIED =
  /\b(i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:now\s+|already\s+|just\s+)?(applied|changed|updated|banned|blocked|removed|deleted|enabled|disabled|set|installed|turned)\b/i;

function roleOf(p: Principal, relayId: RelayId | null): string {
  return (relayId && p.roles[relayId]) || p.roles['*'] || 'viewer';
}

export function systemPrompt(opts: {
  kernel: Kernel;
  principal: Principal;
  relayId: RelayId | null;
  proposalsAllowed: boolean;
  lens: 'simple' | 'technical';
}): string {
  const { kernel, principal, relayId, proposalsAllowed, lens } = opts;
  const relay = relayId ? kernel.relay(relayId) : undefined;
  const lines = [
    'You are the Beamhop assistant inside the admin app of a Nostr relay and media server.',
    `You talk with ${principal.displayName ? `the admin "${scrubText(principal.displayName).slice(0, 60)}"` : 'an admin'} (role: ${roleOf(principal, relayId)}).`,
    relay
      ? `They are looking at the relay "${relay.info.name}" (id ${relay.id}, kind: ${relay.persona}).`
      : `They are looking at the whole server (${kernel.config().relays.length} relays).`,
    '',
    'How to answer:',
    '- Use plain, friendly language and short answers. Lead with the answer, then 1-3 facts that support it.',
    lens === 'technical'
      ? '- The admin asked for technical details: include NIP numbers, event kinds, config paths and raw values.'
      : '- Avoid jargon (say "reports", not "kind 1984"). Give technical details (NIPs, kinds, config paths) only when asked.',
    '- Use the tools to look things up instead of guessing. If you could not find something, say so.',
    '- You can NEVER change anything yourself. You have no tool that applies changes.',
    proposalsAllowed
      ? '- When the admin asks for a change, call the matching propose_* tool. That only creates a suggestion card with a preview; the admin decides. Say "I prepared a suggestion — review it and tap Approve", never that it was applied, done or changed.'
      : '- The admin did not ask for a change, so do not suggest one with tools. If a change would help, describe it in words and ask whether they want you to prepare it.',
    '- Never claim a change was made. Never invent numbers.',
    '',
    `Safety: ${UNTRUSTED_RULES}`,
  ];
  return lines.join('\n');
}

function contextMessage(req: AssistantRequest, relayId: RelayId | null, maxChars: number): string {
  const ctx = req.context ?? {};
  const parts: string[] = [];
  const screen = ctx.screen ? scrubText(String(ctx.screen)).slice(0, 120) : 'unknown';
  parts.push(`Current screen: ${screen}${relayId ? ` (relay ${relayId})` : ''}`);
  if (ctx.selection !== undefined)
    parts.push(
      `Selected on screen:\n${untrusted('screen-selection', promptJson(ctx.selection, maxChars))}`,
    );
  parts.push(`Admin's question: ${truncate(req.message, 4000)}`);
  return parts.join('\n\n');
}

function newIdFactory(kernel: Kernel): () => string {
  return () => kernel.ports.crypto.randomHex(8);
}

function usageTokens(u: ChatUsage | undefined, fallbackIn: number, fallbackOut: number): number {
  if (u?.totalTokens !== undefined) return u.totalTokens;
  if (u?.inputTokens !== undefined || u?.outputTokens !== undefined)
    return (u.inputTokens ?? fallbackIn) + (u.outputTokens ?? fallbackOut);
  return fallbackIn + fallbackOut;
}

function promptSize(messages: ChatMessage[], tools: ToolSpec[]): number {
  let n = 0;
  for (const m of messages)
    n += m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0);
  return Math.ceil((n + JSON.stringify(tools).length) / 4);
}

/**
 * Run one assistant turn. `emit` receives stream events in order; the final
 * result is also returned. Never throws for model/tool failures — they become
 * `error` events and a graceful answer.
 */
export async function runAssistant(
  deps: AssistantDeps,
  principal: Principal,
  req: AssistantRequest,
  emit: (e: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<AssistantResult> {
  const { kernel, llm, settings } = deps;
  const relayId = req.context?.relayId ?? null;
  const sessionId = kernel.ports.crypto.randomHex(8);
  const history = (req.history ?? []).slice(-12);
  const adminWords = [
    req.message,
    ...history
      .filter((h) => h.role === 'user')
      .slice(-2)
      .map((h) => h.content),
  ];
  const proposalsAllowed = settings.maxProposals > 0 && hasChangeIntent(adminWords);
  const tools = toolsFor(kernel, principal, relayId, { proposals: proposalsAllowed });
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const env: ToolEnv = {
    kernel,
    principal,
    relayId,
    errors: deps.errors,
    newId: newIdFactory(kernel),
  };
  const budget = new Budget(settings.maxTokensPerRequest);
  const lens = req.context?.lens ?? 'simple';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt({ kernel, principal, relayId, proposalsAllowed, lens }),
    },
    ...history.map((h) => ({ role: h.role, content: truncate(h.content, 4000) }) as ChatMessage),
    { role: 'user', content: contextMessage(req, relayId, settings.maxToolResultChars) },
  ];

  emit({ type: 'meta', sessionId, tools: tools.map((t) => t.spec.name), proposalsAllowed });

  const proposals: Proposal[] = [];
  const calls: ToolCallRecord[] = [];
  let text = '';
  let rounds = 0;
  let stopped: AssistantResult['stopped'];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const deadline = kernel.ports.clock.nowMs() + settings.timeoutSeconds * 1000;

  try {
    while (true) {
      if (controller.signal.aborted) {
        stopped = 'aborted';
        break;
      }
      const lastRound = rounds >= settings.maxRounds - 1 || calls.length >= settings.maxToolCalls;
      const offered = lastRound ? [] : tools.map((t) => t.spec);
      const promptTokens = promptSize(messages, offered);
      if (budget.used + promptTokens + settings.maxOutputTokens > budget.limit) {
        stopped = 'budget';
        emit({
          type: 'error',
          code: 'budget',
          message:
            'This question needed more work than the usage limit allows, so I stopped early.',
        });
        break;
      }
      const remainingMs = deadline - kernel.ports.clock.nowMs();
      if (remainingMs <= 0) throw new TimeoutError(settings.timeoutSeconds * 1000);
      rounds++;
      let streamed = '';
      const reply = await withTimeout(
        llm.chat(messages, {
          tools: offered,
          signal: controller.signal,
          maxOutputTokens: settings.maxOutputTokens,
          temperature: 0.2,
          onText: (d) => {
            streamed += d;
            emit({ type: 'text', delta: d });
          },
        }),
        remainingMs,
        () => controller.abort(),
      );
      const outTokens = estimateTokens(reply.content + JSON.stringify(reply.toolCalls ?? []));
      budget.add(usageTokens(reply.usage, promptTokens, outTokens));

      const toolCalls = lastRound ? [] : (reply.toolCalls ?? []);
      if (!toolCalls.length) {
        text = text ? `${text}\n\n${reply.content}`.trim() : reply.content;
        // Adapters without streaming support: emit the whole answer once.
        if (!streamed && text) emit({ type: 'text', delta: text });
        if (rounds >= settings.maxRounds && reply.toolCalls?.length) stopped = 'rounds';
        break;
      }

      messages.push({ role: 'assistant', content: reply.content, toolCalls });
      if (reply.content && !streamed) emit({ type: 'text', delta: reply.content });
      if (reply.content) text = text ? `${text}\n\n${reply.content}` : reply.content;
      for (const call of toolCalls) {
        const tool = byName.get(call.name);
        const args = parseArgs(call.arguments);
        const record: ToolCallRecord = {
          id: call.id,
          name: call.name,
          kind: tool?.kind ?? 'unknown',
          args,
          ok: false,
          summary: '',
        };
        emit({ type: 'tool-call', id: call.id, name: call.name, kind: record.kind, args });
        let resultForModel: unknown;
        if (calls.length >= settings.maxToolCalls) {
          record.summary = 'Skipped: lookup limit reached';
          resultForModel = { error: 'Lookup limit reached. Answer with what you have.' };
        } else if (!tool) {
          record.summary = call.name.startsWith('propose')
            ? 'Refused: suggestions are off for this question'
            : 'Unknown tool';
          resultForModel = {
            error: call.name.startsWith('propose')
              ? 'Suggestions are not available for this question. The admin did not ask for a change.'
              : `There is no tool called ${call.name}.`,
          };
        } else if (tool.kind === 'propose' && proposals.length >= settings.maxProposals) {
          record.summary = 'Skipped: too many suggestions';
          resultForModel = { error: 'Suggestion limit reached.' };
        } else {
          try {
            const outcome = await withTimeout(
              tool.run(args, env),
              Math.max(1000, Math.min(30_000, deadline - kernel.ports.clock.nowMs())),
            );
            if (outcome.ok) {
              record.ok = true;
              record.summary = outcome.summary;
              resultForModel = outcome.result;
              if (outcome.proposal) {
                proposals.push(outcome.proposal);
                emit({ type: 'proposal', proposal: outcome.proposal });
              }
            } else {
              record.summary = outcome.error;
              resultForModel = { error: outcome.error };
            }
          } catch (err) {
            record.summary = `Failed: ${truncate(scrubText(String((err as Error)?.message ?? err)), 200)}`;
            resultForModel = { error: record.summary };
          }
        }
        calls.push(record);
        emit({
          type: 'tool-result',
          id: call.id,
          name: call.name,
          ok: record.ok,
          summary: record.summary,
        });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: untrusted(
            `tool:${call.name}`,
            promptJson(resultForModel, settings.maxToolResultChars),
          ),
        });
      }
    }
  } catch (err) {
    if (err instanceof TimeoutError) {
      stopped = 'timeout';
      emit({ type: 'error', code: 'timeout', message: 'The assistant took too long to answer.' });
    } else if (controller.signal.aborted && signal?.aborted) {
      stopped = 'aborted';
    } else {
      stopped = 'error';
      kernel.ports.logger.log('warn', 'assistant failed', { error: scrubText(String(err)) });
      emit({
        type: 'error',
        code: 'llm_failed',
        message: 'The assistant could not be reached. Check the AI connection in Settings.',
      });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (CLAIMS_APPLIED.test(text) || (proposals.length && !text)) {
    text += NOT_APPLIED_NOTE;
    emit({ type: 'text', delta: NOT_APPLIED_NOTE });
  }

  const result: AssistantResult = {
    sessionId,
    text,
    proposals,
    toolCalls: calls,
    usage: { tokens: budget.used, limit: budget.limit, rounds },
  };
  if (stopped) result.stopped = stopped;

  await auditSession(kernel, principal, relayId, req, result);
  emit({ type: 'done', result });
  return result;
}

interface AuditFlush {
  flush?(): Promise<void>;
}

/** One audit entry per assistant session: question, tools called, proposals (never applied). */
async function auditSession(
  kernel: Kernel,
  principal: Principal,
  relayId: RelayId | null,
  req: AssistantRequest,
  r: AssistantResult,
): Promise<void> {
  const q = truncate(scrubText(req.message), 500);
  const tail = r.proposals.length
    ? ` — ${r.proposals.length} suggestion${r.proposals.length > 1 ? 's' : ''} prepared, nothing applied`
    : '';
  kernel.bus.emit('admin.action', {
    relayId,
    actionId: 'ai.assistant',
    principalId: principal.id,
    input: {
      sessionId: r.sessionId,
      question: q,
      screen: req.context?.screen ? truncate(String(req.context.screen), 120) : undefined,
      tools: r.toolCalls.map((c) => ({ name: c.name, kind: c.kind, args: c.args, ok: c.ok })),
      proposals: r.proposals.map((p) => ({ actionId: p.actionId, input: p.input, title: p.title })),
      tokens: r.usage.tokens,
      stopped: r.stopped,
    },
    summary: `Asked the assistant: “${truncate(q, 80)}”${tail}`,
    ok: !r.stopped || r.stopped === 'rounds',
  });
  try {
    await kernel.use<AuditFlush>('admin.audit')?.flush?.();
  } catch {
    // audit failures are logged by the audit module
  }
}
