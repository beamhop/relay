// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Assistant chat state (§6.5). Streams answers from the server, keeps the
 * conversation for this tab, and applies a proposal only when the admin taps
 * Approve (through the standard endpoint it names, with an undo toast).
 */
import { ApiError } from '../api/client.ts';
import type { CommitResult, RunResult } from '../api/types.ts';
import {
  type AssistantBody,
  type AssistantContext,
  type ChatTurn,
  applyEvent,
  assistantInCatalog,
  historyOf,
  isAiOff,
  parseEvent,
  safeApprovePath,
} from '../assistant.ts';
import { haptic } from '../haptics.ts';
import { m } from '../paraglide/messages.js';
import { announce, asApiError } from './actions.svelte.ts';
import { app } from './app.svelte.ts';
import { toasts } from './toasts.svelte.ts';

class AssistantState {
  open = $state(false);
  turns = $state<ChatTurn[]>([]);
  busy = $state(false);
  /** Set when the server said the assistant is off (`ai_disabled`). */
  offMessage = $state<string | null>(null);
  /** What the current screen has selected (a card, a queue item…); sent as context. */
  selection = $state<unknown>(undefined);
  private ctrl: AbortController | null = null;
  private seq = 0;

  /** The `ai` module is registered (its actions are in the catalog). */
  get installed(): boolean {
    return assistantInCatalog(app.catalog);
  }

  /** The chat can be used: installed and not reported off. */
  get usable(): boolean {
    return this.installed && !this.offMessage;
  }

  show(): void {
    this.open = true;
  }

  setSelection(v: unknown): void {
    this.selection = v;
  }

  clear(): void {
    this.stop();
    this.turns = [];
  }

  stop(): void {
    this.ctrl?.abort();
    this.ctrl = null;
  }

  async ask(message: string, context: AssistantContext): Promise<void> {
    const text = message.trim();
    if (!text || this.busy) return;
    const history = historyOf(this.turns);
    this.turns.push({
      id: ++this.seq,
      role: 'user',
      text,
      tools: [],
      proposals: [],
      pending: false,
    });
    this.turns.push({
      id: ++this.seq,
      role: 'assistant',
      text: '',
      tools: [],
      proposals: [],
      pending: true,
    });
    // The proxied turn (mutations re-render).
    const turn = this.turns[this.turns.length - 1] as ChatTurn;
    const body: AssistantBody = { message: text, context };
    if (history?.length) body.history = history;
    this.busy = true;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    try {
      await app.api.assistant(
        body,
        (msg) => {
          const e = parseEvent(msg.event, msg.data);
          if (!e) return;
          applyEvent(turn, e);
          if (e.type === 'error' && e.code === 'ai_disabled') this.offMessage = e.message;
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        turn.stopped = 'aborted';
      } else {
        const e = asApiError(err);
        if (err instanceof ApiError && isAiOff(err)) {
          this.offMessage = e.message;
          // Drop the unanswered exchange: the panel shows the "AI is off" state instead.
          this.turns = this.turns.filter((t) => t.id !== turn.id && t.id !== turn.id - 1);
        } else turn.error = { code: e.code, message: e.message };
      }
    } finally {
      turn.pending = false;
      this.busy = false;
      if (this.ctrl === ctrl) this.ctrl = null;
    }
  }

  private card(turnId: number, proposalId: string) {
    return this.turns
      .find((t) => t.id === turnId)
      ?.proposals.find((p) => p.proposal.id === proposalId);
  }

  /** Approve a suggestion: call its standard endpoint, then offer undo. */
  async approve(turnId: number, proposalId: string): Promise<void> {
    const card = this.card(turnId, proposalId);
    if (!card || card.state === 'applying' || card.state === 'applied') return;
    const p = card.proposal;
    const path = safeApprovePath(p.approve?.path);
    if (!path || p.approve.method !== 'POST') {
      card.state = 'failed';
      card.note = m.assistant_bad_proposal();
      return;
    }
    card.state = 'applying';
    card.note = undefined;
    try {
      const r = await app.api.approveProposal<RunResult | CommitResult>(path, p.approve.body);
      const summary =
        ('summary' in r && typeof r.summary === 'string' && r.summary) ||
        ('revision' in r && r.revision?.summary) ||
        p.title;
      card.state = 'applied';
      card.note = summary;
      announce({ summary, ...(r.undo ? { undo: r.undo } : {}) }, () => {
        const c = this.card(turnId, proposalId);
        if (c) {
          c.state = 'dismissed';
          c.note = m.assistant_undone();
        }
      });
    } catch (err) {
      const e = asApiError(err);
      card.state = 'failed';
      card.note = e.message;
      haptic('warning');
      toasts.error(e.message, e.technical);
    }
  }

  dismiss(turnId: number, proposalId: string): void {
    const card = this.card(turnId, proposalId);
    if (card && card.state !== 'applied') card.state = 'dismissed';
  }
}

export const assistant = new AssistantState();
