// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two-person rule helpers for the enterprise screens (§12.9). Lives inside the
 * lazy module chunks only (§12.0): nothing here is part of the main bundle.
 *
 * A risky action answers in one of two ways when a second admin must approve:
 * - wrapped by the approval gate: a normal result whose output is
 *   `{ status: 'approval-required', requestId }`;
 * - gating itself (key vault): an error "Waiting for a second admin to approve (request apr_…)".
 * Once approved, the requester runs it again with the request id
 * (`_approvalId` for gated actions, `approvalId` for the key vault ones).
 */
import type { CatalogAction } from '$lib/api/types';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'used';

/** One row of `approvals.list`. */
export interface ApprovalRow {
  id: string;
  actionId: string;
  actionTitle: string;
  relayId: string | null;
  input: unknown;
  reason?: string;
  requestedBy: string;
  requestedByName?: string;
  requestedByPubkey?: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: number;
  note?: string;
  approvalExpiresAt?: number;
  mine?: boolean;
  canApprove?: boolean;
}

/** Request id when a run result says a second admin must approve first. */
export function approvalFromOutput(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as { status?: unknown; requestId?: unknown };
  return o.status === 'approval-required' && typeof o.requestId === 'string' ? o.requestId : null;
}

/** Request id ('' when unknown) when an error means "waiting for a second admin". */
export function approvalFromError(message: string | null | undefined): string | null {
  if (!message || !/second admin/i.test(message) || /denied|not approved in time/i.test(message))
    return null;
  return message.match(/\b(apr_[0-9a-z]+)\b/i)?.[1] ?? '';
}

/** Which input field carries the approved request id for this action. */
export function approvalField(def: CatalogAction | undefined): '_approvalId' | 'approvalId' {
  const props = def?.inputSchema?.properties ?? {};
  if ('_approvalId' in props) return '_approvalId';
  if ('approvalId' in props) return 'approvalId';
  return '_approvalId';
}

/** The input to run an approved request with. */
export function approvedInput(
  row: ApprovalRow,
  def: CatalogAction | undefined,
): Record<string, unknown> {
  const base =
    row.input && typeof row.input === 'object' ? (row.input as Record<string, unknown>) : {};
  return { ...base, [approvalField(def)]: row.id };
}

/** Does a request match this action (and these input values)? */
export function matches(
  row: ApprovalRow,
  actionId: string,
  input: Record<string, unknown> = {},
): boolean {
  if (row.actionId !== actionId) return false;
  const got = (row.input ?? {}) as Record<string, unknown>;
  return Object.entries(input).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));
}

/** Diff lines of a gated action without the gate's own "needs approval" line. */
export function withoutGateLine<T extends { technical?: string; text: string }>(lines: T[]): T[] {
  return lines.filter(
    (l) => !/two-person rule/i.test(l.technical ?? '') && !/must approve this before/i.test(l.text),
  );
}

/** "in 3 h" / "in 20 min" until a unix time (plain, coarse). */
export function timeLeft(at: number, now = Math.floor(Date.now() / 1000)): string {
  const s = at - now;
  if (s <= 0) return 'now';
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400 * 2) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}

/** "5 min ago" style age of a unix time. */
export function ago(at: number, now = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, now - at);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
