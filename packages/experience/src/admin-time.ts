// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Weekly admin minutes (§7 success metric "healthy relay needs < 10 admin
 * minutes/week"). Measured locally from admin activity (`admin.action` on the
 * bus + `experience.ping` from the PWA) and shown only to that admin.
 * Never sent anywhere.
 *
 * Model: activity within `GAP_SECONDS` of the previous activity extends the
 * current session by the elapsed time; a new session is credited
 * `SESSION_CREDIT_SECONDS` for its first moment.
 */
import type { Kernel } from '@beamhop/core';
import { COL, SerialQueue, isHuman } from './util.ts';

export const GAP_SECONDS = 10 * 60;
export const SESSION_CREDIT_SECONDS = 60;
/** Target: under 10 minutes a week. */
export const WEEKLY_GOAL_SECONDS = 10 * 60;
/**
 * Rough minutes an approved suggestion saves compared with doing it by hand
 * (noticing the problem, finding the right screen, deciding, applying).
 */
export const MINUTES_SAVED_PER_SUGGESTION = 3;
export const APPROVE_ACTION = 'experience.approve-card';
const KEEP_WEEKS = 12;

export interface WeekRecord {
  weekStart: number;
  seconds: number;
  sessions: number;
  actions: number;
  /** Suggestions approved (Home cards). Absent in records written before it existed. */
  approvals?: number;
  lastAt: number;
}

export interface MyStats {
  thisWeek: {
    weekStart: number;
    minutes: number;
    sessions: number;
    actions: number;
    /** Changes made this week (same as `actions`; plain name for the app). */
    tasksDone: number;
    /** Suggestions approved this week. */
    suggestionsApproved: number;
    /** Estimated minutes saved by approving suggestions instead of doing it by hand. */
    minutesSaved: number;
  };
  previousWeeks: Array<{ weekStart: number; minutes: number }>;
  goalMinutes: number;
  onTrack: boolean;
  /** Plain one-liner. */
  message: string;
  privacy: string;
}

/** Monday 00:00 UTC of the week containing `t` (unix seconds). */
export function weekStartOf(t: number): number {
  const day = Math.floor(t / 86400);
  // 1970-01-01 was a Thursday: (day + 3) % 7 → 0 = Monday.
  const dow = (day + 3) % 7;
  return (day - dow) * 86400;
}

const keyOf = (principalId: string, weekStart: number) =>
  `${principalId}|${String(weekStart).padStart(12, '0')}`;

export class AdminTimeTracker {
  private readonly queue = new SerialQueue();
  constructor(private readonly kernel: Kernel) {}

  attach(): () => void {
    return this.kernel.bus.on('admin.action', (e) => {
      if (!isHuman(e.principalId)) return;
      void this.record(e.principalId, 'action', undefined, e.actionId).catch((err) =>
        this.kernel.bus.emit('error', { source: 'experience.admin-time', message: String(err) }),
      );
    });
  }

  record(
    principalId: string,
    kind: 'action' | 'ping',
    at = this.kernel.ports.clock.now(),
    actionId?: string,
  ) {
    return this.queue.run(async () => {
      if (!isHuman(principalId)) return;
      const docs = this.kernel.ports.docs;
      const ws = weekStartOf(at);
      const key = keyOf(principalId, ws);
      const rec = (await docs.get<WeekRecord>(COL.adminTime, key)) ?? {
        weekStart: ws,
        seconds: 0,
        sessions: 0,
        actions: 0,
        lastAt: 0,
      };
      // Continue a session that may have started last week.
      let lastAt = rec.lastAt;
      if (!lastAt) {
        const prev = await docs.get<WeekRecord>(COL.adminTime, keyOf(principalId, ws - 7 * 86400));
        lastAt = prev?.lastAt ?? 0;
      }
      const gap = at - lastAt;
      if (lastAt && gap >= 0 && gap <= GAP_SECONDS) rec.seconds += gap;
      else if (!(lastAt && gap < 0)) {
        rec.sessions++;
        rec.seconds += SESSION_CREDIT_SECONDS;
      }
      if (kind === 'action') rec.actions++;
      if (kind === 'action' && actionId === APPROVE_ACTION)
        rec.approvals = (rec.approvals ?? 0) + 1;
      rec.lastAt = Math.max(rec.lastAt, at);
      await docs.put(COL.adminTime, key, rec);
      // Forget old weeks.
      const old = await docs.list<WeekRecord>(COL.adminTime, {
        prefix: `${principalId}|`,
        limit: 100,
      });
      for (const it of old.items)
        if (it.value.weekStart < ws - KEEP_WEEKS * 7 * 86400)
          await docs.delete(COL.adminTime, it.key);
    });
  }

  idle(): Promise<unknown> {
    return this.queue.idle();
  }

  async stats(principalId: string): Promise<MyStats> {
    await this.idle();
    const now = this.kernel.ports.clock.now();
    const ws = weekStartOf(now);
    const page = await this.kernel.ports.docs.list<WeekRecord>(COL.adminTime, {
      prefix: `${principalId}|`,
      limit: 100,
    });
    const byWeek = new Map(page.items.map((i) => [i.value.weekStart, i.value]));
    const cur = byWeek.get(ws);
    const minutes = (s: number) => Math.round(s / 6) / 10;
    const thisMinutes = minutes(cur?.seconds ?? 0);
    const previousWeeks = [1, 2, 3, 4].map((n) => {
      const w = ws - n * 7 * 86400;
      return { weekStart: w, minutes: minutes(byWeek.get(w)?.seconds ?? 0) };
    });
    const goalMinutes = WEEKLY_GOAL_SECONDS / 60;
    const onTrack = (cur?.seconds ?? 0) <= WEEKLY_GOAL_SECONDS;
    const approvals = cur?.approvals ?? 0;
    return {
      thisWeek: {
        weekStart: ws,
        minutes: thisMinutes,
        sessions: cur?.sessions ?? 0,
        actions: cur?.actions ?? 0,
        tasksDone: cur?.actions ?? 0,
        suggestionsApproved: approvals,
        minutesSaved: approvals * MINUTES_SAVED_PER_SUGGESTION,
      },
      previousWeeks,
      goalMinutes,
      onTrack,
      message: onTrack
        ? `You spent about ${thisMinutes} minutes on your relay this week — under the ${goalMinutes}-minute goal.`
        : `You spent about ${thisMinutes} minutes on your relay this week. The goal is under ${goalMinutes}; the Home suggestions can help.`,
      privacy: 'Measured on this server only and shown only to you. Never sent anywhere.',
    };
  }
}
