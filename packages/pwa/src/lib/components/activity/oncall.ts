// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * On-call rotation (§6.12) as the admin sees it: a list of turns starting
 * with the current one ("This week: Ayşe, Next week: Bob, then it repeats").
 * The server stores `{ startAt, periodDays, rotation }` where slot 0 starts at
 * `startAt`; these helpers convert between the two. Pure, unit-tested.
 */

export interface Turn {
  principalId: string;
  channels: string[];
}

export interface OnCallSchedule {
  /** Unix seconds when rotation slot 0 starts. */
  startAt: number;
  periodDays: number;
  rotation: Turn[];
}

export interface Slot {
  /** Position in the displayed list (0 = now). */
  offset: number;
  /** Unix seconds. */
  start: number;
  end: number;
  turn: Turn;
}

const DAY = 86400;

/** Index of the slot running at `now` (may exceed rotation length; take it modulo n). */
export function currentPeriod(s: OnCallSchedule, now: number): number {
  const period = Math.max(1, s.periodDays) * DAY;
  return Math.floor((now - s.startAt) / period);
}

/** The rotation re-ordered so the turn on duty now comes first, with its dates. */
export function upcoming(s: OnCallSchedule | null, now: number): Slot[] {
  if (!s || s.rotation.length === 0) return [];
  const n = s.rotation.length;
  const period = Math.max(1, s.periodDays) * DAY;
  const p = currentPeriod(s, now);
  const first = s.startAt + p * period;
  return Array.from({ length: n }, (_, k) => ({
    offset: k,
    start: first + k * period,
    end: first + (k + 1) * period,
    turn: s.rotation[(((p + k) % n) + n) % n] as Turn,
  }));
}

/** Local midnight of the Monday of the week containing `now` (Unix seconds). */
export function weekStart(now: number): number {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return Math.floor(d.getTime() / 1000);
}

/** Local midnight of the day containing `now` (Unix seconds). */
export function dayStart(now: number): number {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * The schedule to save for a displayed list of turns (first = on duty now).
 * When the period is unchanged the current turn keeps its start; otherwise
 * turns start today (daily) or this Monday (weekly and longer).
 */
export function toSchedule(
  turns: Turn[],
  periodDays: number,
  now: number,
  prev: OnCallSchedule | null,
): OnCallSchedule {
  let startAt: number;
  if (prev?.rotation.length && prev.periodDays === periodDays) {
    startAt = prev.startAt + currentPeriod(prev, now) * Math.max(1, periodDays) * DAY;
  } else {
    startAt = periodDays < 7 ? dayStart(now) : weekStart(now);
  }
  return { startAt, periodDays, rotation: turns.map((t) => ({ ...t, channels: [...t.channels] })) };
}

/** Replace the person of one turn (keeps their channels when they already had a turn). */
export function assign(
  turns: Turn[],
  offset: number,
  principalId: string,
  defaultChannels: string[],
): Turn[] {
  const known = turns.find((t) => t.principalId === principalId)?.channels;
  return turns.map((t, i) =>
    i === offset ? { principalId, channels: known?.length ? [...known] : [...defaultChannels] } : t,
  );
}
