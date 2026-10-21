// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bulk actions in Activity (§6.13): what to run for a multi-selection of
 * queue items / stream rows. Pure helpers, unit-tested.
 */

/** One selected thing: a queue item, a stream row or a refused post. */
export interface Pick {
  /** Moderation queue item id (keep needs it). */
  itemId?: string;
  /** Event id (remove needs it). */
  eventId?: string;
  /** Author (block needs it). */
  pubkey?: string;
}

export type BulkKind = 'keep' | 'remove' | 'ban';

/** `moderation.bulk-delete` accepts at most this many ids per run. */
export const BULK_MAX = 500;

const HEX64 = /^[0-9a-f]{64}$/;

export interface BulkPlan {
  kind: BulkKind;
  actionId: string;
  /** Combined input used for the preview diff (and for single-run actions). */
  previewInput: Record<string, unknown>;
  /** Per-item inputs for `POST /actions/{id}/bulk`; absent → one run with `previewInput`. */
  inputs?: Array<Record<string, unknown>>;
  /** How many picks the action applies to. */
  count: number;
  /** Picks this action cannot apply to (no event id, no author…), or over the limit. */
  skipped: number;
}

const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

export function planBulk(kind: BulkKind, picks: Pick[]): BulkPlan {
  if (kind === 'keep') {
    const ids = uniq(picks.map((p) => p.itemId));
    return {
      kind,
      actionId: 'moderation.keep',
      previewInput: { itemIds: ids },
      inputs: ids.map((id) => ({ itemIds: [id] })),
      count: ids.length,
      skipped: picks.length - ids.length,
    };
  }
  if (kind === 'ban') {
    const pks = uniq(picks.map((p) => p.pubkey)).filter((p) => HEX64.test(p));
    const covered = picks.filter((p) => p.pubkey && HEX64.test(p.pubkey)).length;
    return {
      kind,
      actionId: 'moderation.ban-pubkey',
      previewInput: { pubkeys: pks },
      inputs: pks.map((p) => ({ pubkeys: [p] })),
      count: pks.length,
      skipped: picks.length - covered,
    };
  }
  const all = uniq(picks.map((p) => p.eventId)).filter((id) => HEX64.test(id));
  const ids = all.slice(0, BULK_MAX);
  const usable = picks.filter((p) => p.eventId && HEX64.test(p.eventId)).length;
  return {
    kind,
    actionId: 'moderation.bulk-delete',
    previewInput: { eventIds: ids },
    count: ids.length,
    skipped: picks.length - usable + (all.length - ids.length),
  };
}

/** What a live-stream row can be selected as (posts only; null for everything else). */
export function pickFromLive(name: string, data: Record<string, unknown>): Pick | null {
  if (name === 'event.accepted' || name === 'event.held') {
    const ev = (data.event ?? {}) as { id?: unknown; pubkey?: unknown };
    if (typeof ev.id !== 'string') return null;
    const p: Pick = { eventId: ev.id };
    if (typeof ev.pubkey === 'string') p.pubkey = ev.pubkey;
    return p;
  }
  if (name === 'event.rejected' && typeof data.eventId === 'string') {
    const p: Pick = { eventId: data.eventId };
    if (typeof data.pubkey === 'string') p.pubkey = data.pubkey;
    return p;
  }
  return null;
}

/** A gated action answered "another admin must approve this" (two-person rule, §12.9). */
export function isApprovalPending(
  output: unknown,
): output is { status: 'approval-required'; requestId: string } {
  return (
    !!output &&
    typeof output === 'object' &&
    (output as { status?: unknown }).status === 'approval-required'
  );
}

/**
 * Shift-click range selection: everything between the anchor and `id` in
 * `order` (inclusive) is added. Without an anchor (or when it is gone) only `id` toggles.
 */
export function selectRange(
  current: ReadonlySet<string>,
  order: readonly string[],
  anchor: string | null,
  id: string,
  range: boolean,
): Set<string> {
  const next = new Set(current);
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(id);
  if (range && a >= 0 && b >= 0) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) next.add(order[i] as string);
    return next;
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
