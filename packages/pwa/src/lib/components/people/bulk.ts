// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bulk actions on People (§6.13): the same single actions (ban, mute, plan,
 * remove from the allow list) run for many people at once, with one combined
 * plain-language diff first and one undo for all of them.
 */
import type { BulkResult, DiffLine, RunResult, UndoInfo } from '../../api/types.ts';

export type BulkKind = 'ban' | 'mute' | 'tier' | 'unallow';

export interface BulkDef {
  kind: BulkKind;
  actionId: string;
  /** Input for one person. */
  one: (pubkey: string, extra: { tier?: string | null }) => Record<string, unknown>;
  /** Input covering everyone at once (actions taking `pubkeys`), used for a single preview. */
  all?: (pubkeys: string[]) => Record<string, unknown>;
}

const many = (actionId: string, kind: BulkKind): BulkDef => ({
  kind,
  actionId,
  one: (pk) => ({ pubkeys: [pk] }),
  all: (pks) => ({ pubkeys: pks }),
});

export const BULK: Record<BulkKind, BulkDef> = {
  ban: many('moderation.ban-pubkey', 'ban'),
  mute: many('moderation.mute-pubkey', 'mute'),
  unallow: many('access.remove-allowlist', 'unallow'),
  tier: {
    kind: 'tier',
    actionId: 'users.set-tier',
    one: (pubkey, extra) => ({ pubkey, tier: extra.tier ?? null }),
  },
};

export function inputsFor(
  def: BulkDef,
  pubkeys: string[],
  extra: { tier?: string | null } = {},
): Record<string, unknown>[] {
  return pubkeys.map((pk) => def.one(pk, extra));
}

/**
 * Combine per-person diffs into one short list: identical lines collapse into
 * one with a count, so "Bob moves to Plus" ×12 stays readable.
 */
export function mergeDiffs(lists: DiffLine[][], max = 8): { lines: DiffLine[]; more: number } {
  const seen = new Map<string, { line: DiffLine; n: number }>();
  for (const list of lists)
    for (const line of list) {
      const k = `${line.kind}|${line.text}`;
      const cur = seen.get(k);
      if (cur) cur.n++;
      else seen.set(k, { line, n: 1 });
    }
  const all = [...seen.values()].map(({ line, n }) =>
    n > 1 ? { ...line, text: `${line.text} (×${n})` } : line,
  );
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** The parts of the admin API a bulk run needs (kept small for tests). */
export interface BulkApi {
  bulk(id: string, inputs: unknown[], scope?: 'node' | 'relay'): Promise<BulkResult>;
  run<O = unknown>(id: string, input: unknown, scope?: 'node' | 'relay'): Promise<RunResult<O>>;
}

export interface BulkOutcome {
  done: number;
  failed: Array<{ index: number; message: string }>;
  /** Undo tokens; one for a server-side bulk, one per item otherwise. Undo in reverse order. */
  undoTokens: string[];
  /** Earliest expiry of the undo tokens (unix seconds). */
  undoExpiresAt?: number;
}

/**
 * Run an action for many inputs. Uses `POST /actions/{id}/bulk` (one undo
 * for all) when the action supports it; otherwise runs them one by one and
 * keeps every per-item undo token so a single toast can undo them all.
 */
export async function runBulk(
  api: BulkApi,
  actionId: string,
  inputs: unknown[],
  opts: { bulk: boolean; scope?: 'node' | 'relay' },
): Promise<BulkOutcome> {
  const scope = opts.scope ?? 'relay';
  if (opts.bulk) {
    const r = await api.bulk(actionId, inputs, scope);
    const failed: BulkOutcome['failed'] = [];
    r.results.forEach((x, index) => {
      if (!x.ok) failed.push({ index, message: x.error?.message ?? '' });
    });
    return withUndo({ done: r.results.length - failed.length, failed, undoTokens: [] }, r.undo);
  }
  const out: BulkOutcome = { done: 0, failed: [], undoTokens: [] };
  for (const [index, input] of inputs.entries()) {
    try {
      const r = await api.run(actionId, input, scope);
      out.done++;
      if (r.undo) {
        out.undoTokens.push(r.undo.token);
        out.undoExpiresAt = Math.min(out.undoExpiresAt ?? r.undo.expiresAt, r.undo.expiresAt);
      }
    } catch (err) {
      out.failed.push({ index, message: (err as Error).message ?? String(err) });
    }
  }
  return out;
}

function withUndo(o: BulkOutcome, undo: UndoInfo | undefined): BulkOutcome {
  if (undo) {
    o.undoTokens = [undo.token];
    o.undoExpiresAt = undo.expiresAt;
  }
  return o;
}

/** Undo every token of a bulk run, newest first. Returns how many were undone. */
export async function undoAll(
  undo: (token: string) => Promise<unknown>,
  tokens: string[],
): Promise<number> {
  let n = 0;
  for (const t of [...tokens].reverse()) {
    await undo(t);
    n++;
  }
  return n;
}

/** Shift-click range selection: everything between the last clicked row and this one. */
export function rangeSelect(
  order: string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  target: string,
): Set<string> {
  const next = new Set(selected);
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(target);
  if (a < 0 || b < 0) {
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return next;
  }
  const [from, to] = a < b ? [a, b] : [b, a];
  for (let i = from; i <= to; i++) next.add(order[i] as string);
  return next;
}
