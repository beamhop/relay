// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Derived-vs-overridden view of the exact limits (§6.7): which goal produced
 * each value, which ones the admin changed in Advanced ("Changed by you"),
 * and what the goal would set without the override.
 */
import type { Goals, LimitExplanation, RelayConfig } from '$lib/api/types';

type GoalKey = keyof Goals;

/** `LimitExplanation` plus the additive `goalWouldSet` from @beamhop/policy. */
type Line = LimitExplanation & { goalWouldSet?: { goal: GoalKey; value: unknown } };

export interface GoalLine {
  field: string;
  /** Plain text without the "— from your … goal" suffix. */
  text: string;
  technical: string;
  source: string;
  /** Goal that produced the value (source = goal). */
  goal?: GoalKey;
  /** Goal the value would come from without the override (source ≠ goal). */
  fromGoal?: GoalKey;
  /** Plain text of the goal's own value (overrides only). */
  goalText?: string;
  /** The override sits in `relay.limits` and can be removed. */
  revertible: boolean;
}

const strip = (t: string) => t.split(' — ')[0] ?? t;

export function goalLines(
  relay: RelayConfig,
  explain: (r: RelayConfig) => LimitExplanation[],
): GoalLine[] {
  const lines = explain(relay) as Line[];
  const limits = (relay.limits ?? {}) as Record<string, unknown>;
  return lines.map((l) => {
    const out: GoalLine = {
      field: l.field,
      text: strip(l.text),
      technical: l.technical,
      source: l.source,
      revertible: l.source === 'override' && limits[l.field] !== undefined,
    };
    if (l.goal) out.goal = l.goal;
    if (l.goalWouldSet) out.fromGoal = l.goalWouldSet.goal;
    if (out.revertible) {
      const rest = { ...limits };
      delete rest[l.field];
      const without = (explain({ ...relay, limits: rest } as RelayConfig) as Line[]).find(
        (x) => x.field === l.field,
      );
      if (without) {
        out.goalText = strip(without.text);
        if (!out.fromGoal && without.goal) out.fromGoal = without.goal;
      }
    }
    return out;
  });
}

/** Overridden values per goal, for "N values changed by you" under each slider. */
export function overrideCounts(lines: GoalLine[]): Partial<Record<GoalKey, number>> {
  const out: Partial<Record<GoalKey, number>> = {};
  for (const l of lines)
    if (l.source === 'override' && l.fromGoal) out[l.fromGoal] = (out[l.fromGoal] ?? 0) + 1;
  return out;
}

/** Merge patch (RFC 7396) that removes one override, so the goal's value applies again. */
export function revertOverride(field: string): { limits: Record<string, null> } {
  return { limits: { [field]: null } };
}
