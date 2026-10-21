// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Incident } from './incidents.ts';

export type StatusLevel = 'ok' | 'minor' | 'major' | 'outage';

const RANK: Record<StatusLevel, number> = { ok: 0, minor: 1, major: 2, outage: 3 };

/** Worst impact among open incidents. */
export function levelOf(open: Incident[]): StatusLevel {
  let level: StatusLevel = 'ok';
  for (const i of open) if (RANK[i.impact] > RANK[level]) level = i.impact;
  return level;
}
