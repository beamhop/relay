// SPDX-License-Identifier: AGPL-3.0-or-later
/** Alerts tab helpers (§6.9, §8): mute/snooze state per alert row. Pure, unit-tested. */

export interface MuteRecord {
  rule: string;
  /** '*all' = every relay; null = server-wide alerts. */
  relayId: string | null | '*all';
  /** Unix seconds; null = muted until turned back on. */
  until: number | null;
  by?: string;
  at?: number;
}

/** Snooze choices (minutes). */
export const SNOOZES = [
  { id: '1h', minutes: 60 },
  { id: '8h', minutes: 8 * 60 },
  { id: '1d', minutes: 24 * 60 },
  { id: '1w', minutes: 7 * 24 * 60 },
] as const;

export type SnoozeId = (typeof SNOOZES)[number]['id'];

/** The mute that silences alerts of `rule` on `relayId` right now, if any. */
export function muteFor(
  mutes: readonly MuteRecord[],
  rule: string,
  relayId: string | null,
  now: number,
): MuteRecord | undefined {
  return mutes.find(
    (m) =>
      m.rule === rule &&
      (m.relayId === '*all' || m.relayId === relayId) &&
      (m.until === null || m.until > now),
  );
}

/** Input for `alerts.unmute` that removes exactly this mute. */
export function unmuteInput(m: MuteRecord): Record<string, unknown> {
  return m.relayId === '*all'
    ? { rule: m.rule, allRelays: true }
    : { rule: m.rule, relayId: m.relayId };
}

/** Log viewer time ranges (milliseconds back from now; null = everything kept). */
export const LOG_RANGES = [
  { id: '15m', ms: 15 * 60_000 },
  { id: '1h', ms: 3_600_000 },
  { id: '24h', ms: 86_400_000 },
  { id: 'all', ms: null },
] as const;

export type LogRangeId = (typeof LOG_RANGES)[number]['id'];

export function sinceFor(range: LogRangeId, nowMs: number): number | undefined {
  const r = LOG_RANGES.find((x) => x.id === range);
  return r?.ms ? nowMs - r.ms : undefined;
}

/** Structured log fields as `key: value` lens lines (nested values as compact JSON). */
export function fieldLines(fields: Record<string, unknown>): string[] {
  return Object.entries(fields).map(([k, v]) => {
    let s: string;
    if (typeof v === 'string') s = v;
    else {
      try {
        s = JSON.stringify(v);
      } catch {
        s = String(v);
      }
    }
    return `${k}: ${s}`;
  });
}

/** Merge newly polled log lines (newest first) into the current list without duplicates. */
export function mergeLogs<T extends { at: number; message: string; source: string }>(
  current: readonly T[],
  fresh: readonly T[],
  max = 1000,
): T[] {
  const key = (r: T) => `${r.at}|${r.source}|${r.message}`;
  const seen = new Set(current.map(key));
  const add = fresh.filter((r) => !seen.has(key(r)));
  return [...add, ...current].sort((a, b) => b.at - a.at).slice(0, max);
}
