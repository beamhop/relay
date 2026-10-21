// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Running actions from the catalog (§6.3): optional generated form →
 * plain-language preview diff → confirm → run → undo toast.
 * Swipe triage skips the confirm step: it runs at once with an undo toast.
 */
import { ApiError } from '../api/client.ts';
import type { CatalogAction, DiffLine, RunResult } from '../api/types.ts';
import { haptic } from '../haptics.ts';
import { m } from '../paraglide/messages.js';
import { app } from './app.svelte.ts';
import { toasts } from './toasts.svelte.ts';

export type FlowPhase = 'form' | 'preview' | 'running' | 'done' | 'error';

export interface FlowState {
  action: CatalogAction;
  input: Record<string, unknown>;
  phase: FlowPhase;
  diff: DiffLine[];
  error: ApiError | null;
  result: RunResult | null;
  /** Called after a successful run. */
  onDone?: (r: RunResult) => void;
  /** Called after the run was undone from its toast. */
  onUndo?: () => void;
}

export function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'error', m.error_generic(), String(err));
}

/** Toast + undo wiring for a finished run. */
export function announce(
  result: { summary: string; undo?: { token: string; expiresAt: number } },
  after?: () => void,
) {
  haptic('success');
  if (result.undo) {
    const token = result.undo.token;
    toasts.success(
      result.summary,
      async () => {
        try {
          const r = await app.api.undo(token);
          toasts.show({ message: m.toast_undone({ what: r.undone }), kind: 'info' });
          after?.();
        } catch (err) {
          const e = asApiError(err);
          toasts.error(e.message, e.technical);
        }
      },
      result.undo.expiresAt,
    );
  } else {
    toasts.success(result.summary);
  }
}

/** Run immediately (swipe triage, quick actions) and show an undo toast. */
export async function runNow<O = unknown>(
  actionId: string,
  input: unknown,
  opts: { afterUndo?: () => void; quiet?: boolean } = {},
): Promise<RunResult<O> | null> {
  const def = app.action(actionId);
  const scope = def?.scope ?? 'relay';
  try {
    const r = await app.api.run<O>(actionId, input, scope);
    if (!opts.quiet || r.undo) announce(r, opts.afterUndo);
    return r;
  } catch (err) {
    const e = asApiError(err);
    haptic('warning');
    toasts.error(e.message, e.technical);
    return null;
  }
}

/** Run a read-only action and return its output (null when missing or failing). */
export async function query<O>(actionId: string, input: unknown = {}): Promise<O | null> {
  const def = app.action(actionId);
  if (!def) return null;
  try {
    return (await app.api.run<O>(actionId, input, def.scope)).output;
  } catch {
    return null;
  }
}

const SHOW_KEYS = ['code', 'codes', 'token', 'secret'];

/** Results that must be shown to the admin (they cannot be fetched again). */
export function showsOutput(output: unknown): boolean {
  return !!output && typeof output === 'object' && SHOW_KEYS.some((k) => k in (output as object));
}

/** Actions that need the address this app is served from (relay tests, launch kit, company sign-in). */
const NEEDS_ORIGIN = new Set([
  'experience.test-relay',
  'experience.launch-kit',
  'enterprise.connect-idp',
]);

/** Add context the server cannot know by itself (the public origin the admin uses). */
export function withContext(
  actionId: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!NEEDS_ORIGIN.has(actionId) || input.baseUrl !== undefined || typeof location === 'undefined')
    return input;
  return { ...input, baseUrl: location.origin };
}

class ActionFlow {
  current = $state<FlowState | null>(null);

  /** Start a flow. `form`: show the generated input form first. */
  async start(
    action: CatalogAction,
    raw: Record<string, unknown> = {},
    opts: { form?: boolean; onDone?: (r: RunResult) => void; onUndo?: () => void } = {},
  ): Promise<void> {
    const input = withContext(action.id, raw);
    const st: FlowState = { action, input, phase: 'form', diff: [], error: null, result: null };
    if (opts.onDone) st.onDone = opts.onDone;
    if (opts.onUndo) st.onUndo = opts.onUndo;
    this.current = st;
    if (!opts.form) await this.preview(input);
  }

  async preview(input: Record<string, unknown>): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    cur.input = withContext(cur.action.id, input);
    cur.error = null;
    if (cur.action.readOnly) {
      await this.confirm();
      return;
    }
    cur.phase = 'running';
    try {
      const r = await app.api.preview(cur.action.id, input, cur.action.scope);
      if (this.current !== cur) return;
      cur.diff = r.diff;
      cur.phase = 'preview';
    } catch (err) {
      cur.error = asApiError(err);
      cur.phase =
        cur.action.inputSchema && Object.keys(cur.action.inputSchema.properties ?? {}).length
          ? 'form'
          : 'error';
    }
  }

  async confirm(): Promise<RunResult | null> {
    const cur = this.current;
    if (!cur) return null;
    cur.phase = 'running';
    try {
      const r = await app.api.run(cur.action.id, cur.input, cur.action.scope);
      cur.result = r;
      cur.phase = 'done';
      if (!cur.action.readOnly) {
        announce(r, cur.onUndo);
        // Keep the sheet open when the result must be seen once (invite codes, tokens, recovery codes).
        if (!showsOutput(r.output)) this.current = null;
      }
      cur.onDone?.(r);
      return r;
    } catch (err) {
      cur.error = asApiError(err);
      cur.phase = 'error';
      haptic('warning');
      return null;
    }
  }

  close(): void {
    this.current = null;
  }
}

export const flow = new ActionFlow();
