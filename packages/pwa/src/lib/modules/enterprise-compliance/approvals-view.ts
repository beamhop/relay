// SPDX-License-Identifier: AGPL-3.0-or-later
/** Approvals inbox: ordering and plain wording (lazy chunk). */
import type { ApprovalRow } from '../shared/approvals.ts';

type NameLookup = { label(pubkey: string | null | undefined): string };

/** Who asked, by name — never a bare key. */
export function requesterName(r: ApprovalRow, names: NameLookup): string {
  if (r.requestedByName) return r.requestedByName;
  if (r.requestedByPubkey) return names.label(r.requestedByPubkey);
  return 'Another admin';
}

/**
 * Cards this admin can decide: pending, not their own (the server marks
 * `canApprove`), oldest first so nothing runs out unseen; `focus` (a request id
 * from a notification link) goes on top.
 */
export function stackOrder(rows: readonly ApprovalRow[], focus = ''): ApprovalRow[] {
  const list = rows
    .filter((r) => r.status === 'pending' && r.canApprove !== false && !r.mine)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  const i = focus ? list.findIndex((r) => r.id === focus) : -1;
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list;
}

/** "Approved by Bob" / "Denied by Carol — “not now”" / "Ran out". */
export function decidedText(r: ApprovalRow, names: NameLookup): string {
  const by =
    r.decidedByName ??
    (r.decidedBy && /^[0-9a-f]{64}$/.test(r.decidedBy) ? names.label(r.decidedBy) : 'an admin');
  const note = r.note ? ` — “${r.note}”` : '';
  switch (r.status) {
    case 'approved':
      return `Approved by ${by}${note}`;
    case 'used':
      return `Approved by ${by} and carried out`;
    case 'denied':
      return r.mine && r.decidedBy === r.requestedBy ? 'Withdrawn' : `Denied by ${by}${note}`;
    case 'expired':
      return 'Ran out before anyone decided';
    default:
      return 'Waiting for a second admin';
  }
}
