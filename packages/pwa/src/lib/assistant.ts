// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AI assistant (§6.5, §6.9 "chat with the relay"): pure helpers for the chat
 * panel. The server streams Server-Sent Events from
 * `POST /api/v1/nodes/self/assistant` (`meta`, `text`, `tool-call`,
 * `tool-result`, `proposal`, `error`, `done`; each `data` is the JSON event
 * with its `type`). Proposals are never applied by the assistant: the admin
 * approves each one, which calls the standard action / config endpoint.
 */
import type { CatalogAction, DiffLine } from './api/types.ts';

/** A suggestion the admin can approve (mirror of the ai package's `Proposal`). */
export interface AssistantProposal {
  id: string;
  kind: 'action' | 'settings';
  actionId: string;
  title: string;
  input: unknown;
  diffLines: DiffLine[];
  relayId: string | null;
  sensitive: boolean;
  undoable: boolean;
  requiresApproval: true;
  approve: { method: 'POST'; path: string; body: unknown };
}

export type AssistantEvent =
  | { type: 'meta'; sessionId: string; tools: string[]; proposalsAllowed: boolean }
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; id: string; name: string; kind: string; args: unknown }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'proposal'; proposal: AssistantProposal }
  | { type: 'error'; code: string; message: string }
  | {
      type: 'done';
      result: { sessionId: string; text: string; stopped?: string; proposals?: unknown[] };
    };

export interface AssistantContext {
  screen?: string;
  relayId?: string;
  selection?: unknown;
  lens?: 'simple' | 'technical';
}

export interface AssistantBody {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: AssistantContext;
}

export interface ToolStep {
  id: string;
  name: string;
  kind: string;
  args: unknown;
  /** Undefined while the tool runs. */
  ok?: boolean;
  summary?: string;
}

export type ProposalState = 'pending' | 'applying' | 'applied' | 'dismissed' | 'failed';

export interface ProposalCard {
  proposal: AssistantProposal;
  state: ProposalState;
  /** Plain result once applied (or the error message). */
  note?: string;
}

export interface ChatTurn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  tools: ToolStep[];
  proposals: ProposalCard[];
  error?: { code: string; message: string };
  /** Still streaming. */
  pending: boolean;
  stopped?: string;
}

/** Ids of actions the `ai` module registers; their presence means the assistant route exists. */
export function assistantInCatalog(catalog: readonly Pick<CatalogAction, 'id'>[]): boolean {
  return catalog.some((a) => a.id.startsWith('ai.'));
}

/**
 * The screen the admin is on, as the assistant context names it
 * (`home`, `activity/queue`, `settings/access`, `people/team`, …).
 */
export function screenName(pathname: string, search = ''): string {
  const path = pathname.replace(/^\/+|\/+$/g, '');
  if (!path) return 'home';
  const tab = new URLSearchParams(search).get('tab');
  const parts = path.split('/').filter(Boolean);
  const top = parts[0] ?? 'home';
  if (tab && parts.length === 1 && ['activity', 'people', 'media'].includes(top))
    return `${top}/${tab}`;
  return parts.slice(0, 3).join('/').slice(0, 200);
}

/** Earlier turns, as the API wants them (bounded like the server's schema). */
export function historyOf(turns: readonly ChatTurn[]): AssistantBody['history'] {
  return turns
    .filter((t) => !t.pending && t.text.trim())
    .slice(-40)
    .map((t) => ({ role: t.role, content: t.text.slice(0, 8000) }));
}

function isEvent(v: unknown): v is AssistantEvent {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

/** Turn one SSE message (`event` name + JSON `data`) into an assistant event. */
export function parseEvent(event: string, data: unknown): AssistantEvent | null {
  if (isEvent(data)) return data;
  if (event === 'text' && typeof data === 'string') return { type: 'text', delta: data };
  return null;
}

/** Apply one streamed event to the assistant turn being built (mutates and returns it). */
export function applyEvent(turn: ChatTurn, e: AssistantEvent): ChatTurn {
  switch (e.type) {
    case 'text':
      turn.text += e.delta;
      break;
    case 'tool-call':
      turn.tools.push({ id: e.id, name: e.name, kind: e.kind, args: e.args });
      break;
    case 'tool-result': {
      const step = turn.tools.find((t) => t.id === e.id);
      if (step) {
        step.ok = e.ok;
        step.summary = e.summary;
      } else
        turn.tools.push({
          id: e.id,
          name: e.name,
          kind: 'unknown',
          args: null,
          ok: e.ok,
          summary: e.summary,
        });
      break;
    }
    case 'proposal':
      if (!turn.proposals.some((p) => p.proposal.id === e.proposal.id))
        turn.proposals.push({ proposal: e.proposal, state: 'pending' });
      break;
    case 'error':
      turn.error = { code: e.code, message: e.message };
      break;
    case 'done':
      turn.pending = false;
      if (e.result.stopped) turn.stopped = e.result.stopped;
      if (!turn.text && e.result.text) turn.text = e.result.text;
      break;
    case 'meta':
      break;
  }
  return turn;
}

/** True for API errors that mean "the assistant is off / not installed". */
export function isAiOff(err: { status?: number; code?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === 'ai_disabled' || err.status === 503 || err.status === 404;
}

/**
 * Proposal `approve.path` values are absolute API paths. Only accept the
 * admin API (`/api/v1/nodes/...`), never another origin or a path outside it.
 */
export function safeApprovePath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  if (
    !/^\/api\/v1\/nodes\/[A-Za-z0-9_.-]+\/(relays\/[A-Za-z0-9_.-]+\/)?(actions\/[a-z0-9.-]+|config\/commit)$/.test(
      path,
    )
  )
    return null;
  return path;
}
