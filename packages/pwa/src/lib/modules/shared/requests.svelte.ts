// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Approval requests seen by the enterprise screens (lazy chunk only): the
 * admin's own requests ("Waiting for a second admin") and the actions that
 * start them. Every change still goes through the shared action flow
 * (preview → confirm → undo).
 */
import type { RunResult } from '$lib/api/types';
import { flow, query, runNow } from '$lib/stores/actions.svelte';
import { app } from '$lib/stores/app.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import {
  type ApprovalRow,
  approvalFromError,
  approvalFromOutput,
  approvedInput,
  matches,
} from './approvals.ts';

class Requests {
  rows = $state<ApprovalRow[]>([]);
  loaded = $state(false);

  async load(): Promise<void> {
    if (!app.hasAction('approvals.list')) {
      this.loaded = true;
      return;
    }
    const r = await query<{ requests: ApprovalRow[] }>('approvals.list', { limit: 200 });
    if (r) this.rows = r.requests;
    this.loaded = true;
  }

  /** The admin's own open request (pending, or approved and not yet carried out) for an action. */
  waiting(actionId: string, input: Record<string, unknown> = {}): ApprovalRow | undefined {
    return this.rows.find(
      (r) =>
        r.mine &&
        (r.status === 'pending' || r.status === 'approved') &&
        matches(r, actionId, input),
    );
  }

  /** Remember a request filed just now (before the list reloads). */
  filed(requestId: string, actionId: string, input: Record<string, unknown>, notify = false): void {
    const now = Math.floor(Date.now() / 1000);
    const def = app.action(actionId);
    if (!this.rows.some((r) => r.id === requestId && requestId))
      this.rows = [
        {
          id: requestId,
          actionId,
          actionTitle: def?.title ?? actionId,
          relayId: null,
          input,
          requestedBy: app.me?.id ?? '',
          createdAt: now,
          expiresAt: now + 86400,
          status: 'pending',
          mine: true,
          canApprove: false,
        },
        ...this.rows,
      ];
    if (notify) toasts.show({ message: 'Waiting for a second admin to approve', kind: 'info' });
    void this.load();
  }

  /**
   * Called from a screen's `$effect`: a key-vault action that answered
   * "waiting for a second admin" becomes a waiting request instead of an error.
   */
  catchFlow(actionIds: readonly string[]): void {
    const c = flow.current;
    if (!c || c.phase !== 'error' || !actionIds.includes(c.action.id)) return;
    const id = approvalFromError(c.error?.message);
    if (id === null) return;
    const input = { ...c.input };
    flow.close();
    this.filed(id, c.action.id, input, true);
  }

  /** Run an approved request (preview shows "A second admin approved this change"). */
  carryOut(row: ApprovalRow, after?: () => void): void {
    const def = app.action(row.actionId);
    if (!def) return;
    void flow.start(def, approvedInput(row, def), {
      onDone: () => {
        void this.load();
        after?.();
      },
    });
  }

  /** Take back one's own pending request. */
  async withdraw(row: ApprovalRow): Promise<void> {
    await runNow('approvals.deny', { requestId: row.id, note: 'Withdrawn' });
    await this.load();
  }
}

export const requests = new Requests();

/**
 * Start an action through the shared flow; a result that needs a second
 * admin is remembered as a waiting request.
 */
export function startAction(
  actionId: string,
  input: Record<string, unknown> = {},
  opts: { form?: boolean; after?: () => void } = {},
): boolean {
  const def = app.action(actionId);
  if (!def) return false;
  void flow.start(def, input, {
    ...(opts.form ? { form: true } : {}),
    onDone: (r: RunResult) => {
      const req = approvalFromOutput(r.output);
      if (req) requests.filed(req, actionId, input);
      opts.after?.();
    },
    onUndo: () => opts.after?.(),
  });
  return true;
}
