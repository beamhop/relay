// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Uptime bars for the status page: from the insights module when present
 * (`kernel.use('insights').uptime`), else a simple in-process estimate since
 * boot, reduced by outage incidents.
 */
import type { Kernel, RelayId } from '@beamhop/core';
import type { Incident } from './incidents.ts';

export const DAY = 86400;

export interface UptimeDay {
  /** Unix seconds, UTC midnight. */
  day: number;
  /** 0..1, or null when there is no data for that day. */
  ratio: number | null;
}

/**
 * Optional contract of the insights module (duck-typed; insights may not be
 * enabled). Returns one entry per UTC day in [from, to).
 */
export interface InsightsUptime {
  uptime?(relayId: RelayId, opts: { from: number; to: number }): Promise<UptimeDay[]>;
}

export async function uptimeDays(
  kernel: Kernel,
  relayId: RelayId,
  days: number,
  bootedAt: number,
  incidents: Incident[],
): Promise<UptimeDay[]> {
  const now = kernel.ports.clock.now();
  const today = Math.floor(now / DAY) * DAY;
  const from = today - (days - 1) * DAY;
  const insights = kernel.use<InsightsUptime>('insights');
  if (insights?.uptime) {
    try {
      const got = await insights.uptime(relayId, { from, to: today + DAY });
      const byDay = new Map(got.map((d) => [d.day, d.ratio]));
      return Array.from({ length: days }, (_, i) => {
        const day = from + i * DAY;
        return { day, ratio: byDay.get(day) ?? null };
      });
    } catch {
      // fall through to the local estimate
    }
  }
  const outages = incidents.filter((i) => i.impact === 'outage');
  return Array.from({ length: days }, (_, i) => {
    const day = from + i * DAY;
    const start = Math.max(day, bootedAt);
    const end = Math.min(day + DAY, now);
    if (end <= start) return { day, ratio: null };
    let down = 0;
    for (const inc of outages) {
      const a = Math.max(start, inc.openedAt);
      const b = Math.min(end, inc.resolvedAt ?? now);
      if (b > a) down += b - a;
    }
    return { day, ratio: Math.max(0, 1 - down / (end - start)) };
  });
}

export function overallRatio(days: UptimeDay[]): number | null {
  const known = days.filter((d) => d.ratio !== null) as Array<{ day: number; ratio: number }>;
  if (known.length === 0) return null;
  return known.reduce((s, d) => s + d.ratio, 0) / known.length;
}
