// SPDX-License-Identifier: AGPL-3.0-or-later
/** The five goal sliders (§6.7), shared by the Settings screen and the Goals screen. */
import type { Goals } from '$lib/api/types';
import { m } from '$lib/paraglide/messages.js';

export type GoalKey = keyof Goals;

export interface GoalDef {
  key: GoalKey;
  title: () => string;
  low: () => string;
  high: () => string;
  invert: boolean;
}

export const GOALS: GoalDef[] = [
  {
    key: 'openness',
    title: () => m.goal_openness(),
    low: () => m.goal_openness_low(),
    high: () => m.goal_openness_high(),
    invert: false,
  },
  {
    key: 'spamTolerance',
    title: () => m.goal_spam(),
    low: () => m.goal_spam_low(),
    high: () => m.goal_spam_high(),
    invert: false,
  },
  {
    key: 'storage',
    title: () => m.goal_storage(),
    low: () => m.goal_storage_low(),
    high: () => m.goal_storage_high(),
    invert: false,
  },
  {
    key: 'media',
    title: () => m.goal_media(),
    low: () => m.goal_media_low(),
    high: () => m.goal_media_high(),
    invert: false,
  },
  {
    key: 'speedVsCost',
    title: () => m.goal_speed(),
    low: () => m.goal_speed_low(),
    high: () => m.goal_speed_high(),
    invert: false,
  },
];

/** True when any goal differs between the two sets. */
export function goalsDiffer(a: Goals, b: Goals): boolean {
  return GOALS.some((g) => a[g.key] !== b[g.key]);
}
