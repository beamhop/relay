// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Scheduler ports for Cloudflare.
 *
 * - `CronScheduler` (Worker): a Cron Trigger (`* * * * *`) calls `runDue()`. Last-run
 *   times live in the DocStore (D1) and are claimed with compare-and-set, so a job runs
 *   once per interval across all isolates even if two cron invocations overlap.
 *   Granularity is one minute; shorter intervals run at most once per minute.
 * - `AlarmScheduler` (RelayRoom Durable Object): Durable Object alarms. Only jobs
 *   accepted by `filter` run here (default: sub-minute housekeeping), and alarms are only
 *   re-armed while the room has open sockets, so idle rooms can hibernate/evict.
 */
import type { Clock, DocStore, Logger, Scheduler } from '@beamhop/core';
import type { DurableObjectStorageLike } from '../cf-types.ts';

interface Job {
  intervalSeconds: number;
  fn: () => Promise<void>;
}

export const SCHEDULER_COLLECTION = 'runtime.scheduler';
/** Cron invocations are not perfectly aligned; allow this much early firing. */
const CRON_TOLERANCE_MS = 5_000;

export class CronScheduler implements Scheduler {
  readonly jobs = new Map<string, Job>();

  constructor(
    private readonly docs: DocStore,
    private readonly logger: Logger,
  ) {}

  every(name: string, intervalSeconds: number, fn: () => Promise<void>): void {
    this.jobs.set(name, { intervalSeconds, fn });
  }

  cancel(name: string): void {
    this.jobs.delete(name);
  }

  /** Run every job whose interval elapsed. Returns names of jobs that ran. */
  async runDue(nowMs: number): Promise<string[]> {
    const ran: string[] = [];
    await Promise.allSettled(
      [...this.jobs].map(async ([name, job]) => {
        const last = await this.docs.get<{ lastRunMs: number }>(SCHEDULER_COLLECTION, name);
        const intervalMs = Math.max(job.intervalSeconds, 60) * 1000;
        if (last && nowMs - last.lastRunMs < intervalMs - CRON_TOLERANCE_MS) return;
        const claimed = await this.docs.cas(SCHEDULER_COLLECTION, name, last, {
          lastRunMs: nowMs,
        });
        if (!claimed) return;
        ran.push(name);
        try {
          await job.fn();
        } catch (err) {
          this.logger.log('error', 'Scheduled job failed', { job: name, error: String(err) });
        }
      }),
    );
    return ran.sort();
  }
}

export type RoomJobFilter = (name: string, intervalSeconds: number) => boolean;

/** Default: only sub-minute jobs run inside rooms; everything else runs via cron. */
export const defaultRoomJobFilter: RoomJobFilter = (_name, intervalSeconds) => intervalSeconds < 60;

const ALARM_STATE_KEY = 'beamhop:scheduler';

export class AlarmScheduler implements Scheduler {
  readonly jobs = new Map<string, Job & { next: number }>();
  /** Jobs refused by the filter (they run in the Worker via cron). */
  readonly skipped = new Set<string>();

  constructor(
    private readonly storage: DurableObjectStorageLike,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly isActive: () => boolean,
    private readonly filter: RoomJobFilter = defaultRoomJobFilter,
  ) {}

  every(name: string, intervalSeconds: number, fn: () => Promise<void>): void {
    if (!this.filter(name, intervalSeconds)) {
      this.skipped.add(name);
      this.jobs.delete(name);
      return;
    }
    this.skipped.delete(name);
    const next = this.clock.nowMs() + intervalSeconds * 1000;
    this.jobs.set(name, { intervalSeconds, fn, next });
  }

  cancel(name: string): void {
    this.jobs.delete(name);
    this.skipped.delete(name);
  }

  /** Restore next-run times persisted before hibernation, then arm. */
  async restore(): Promise<void> {
    const saved = await this.storage.get<Record<string, number>>(ALARM_STATE_KEY);
    if (saved) {
      for (const [name, next] of Object.entries(saved)) {
        const job = this.jobs.get(name);
        if (job) job.next = next;
      }
    }
    await this.arm();
  }

  /** Set the DO alarm to the earliest due job (only while sockets are open). */
  async arm(): Promise<void> {
    if (this.jobs.size === 0 || !this.isActive()) return;
    const earliest = Math.min(...[...this.jobs.values()].map((j) => j.next));
    const current = await this.storage.getAlarm();
    if (current === null || current > earliest) await this.storage.setAlarm(earliest);
    await this.persist();
  }

  /** DO `alarm()` handler. Returns names of jobs that ran. */
  async onAlarm(): Promise<string[]> {
    const now = this.clock.nowMs();
    const ran: string[] = [];
    for (const [name, job] of this.jobs) {
      if (job.next > now) continue;
      job.next = now + job.intervalSeconds * 1000;
      ran.push(name);
      try {
        await job.fn();
      } catch (err) {
        this.logger.log('error', 'Room job failed', { job: name, error: String(err) });
      }
    }
    await this.arm();
    return ran;
  }

  private async persist(): Promise<void> {
    const state: Record<string, number> = {};
    for (const [name, job] of this.jobs) state[name] = job.next;
    await this.storage.put(ALARM_STATE_KEY, state);
  }
}
