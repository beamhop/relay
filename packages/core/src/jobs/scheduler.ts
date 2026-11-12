import { type Logger, whenAborted } from "@beamhop/sdk";
import { logUnlessSwitching } from "../util/db-switching";

type Timer = ReturnType<typeof setInterval>;
/** A job gets the scheduler's signal: it fires at shutdown, so long jobs stop at their next safe point. */
export type Job = (signal: AbortSignal) => Promise<unknown> | unknown;

/** Interval jobs with overlap protection; timers are unref'd so they never keep the process alive. */
export class Scheduler {
  private timers = new Map<string, Timer>();
  private running = new Map<string, Promise<void>>();
  private ac = new AbortController();
  private draining = false;
  constructor(private readonly logger: Logger) {}

  every(name: string, intervalMs: number, fn: Job): void {
    this.cancel(name);
    if (this.draining) return;
    const t = setInterval(() => void this.runNow(name, fn), intervalMs);
    (t as { unref?: () => void }).unref?.();
    this.timers.set(name, t);
  }

  runNow(name: string, fn: Job): Promise<void> {
    if (this.draining) return Promise.resolve();
    const current = this.running.get(name);
    if (current) return current.then(() => {});
    const signal = this.ac.signal;
    const run = (async () => {
      try {
        await fn(signal);
      } catch (err) {
        // writes refused during a database switch: the next run (interval) does it
        logUnlessSwitching(this.logger, "error", `job ${name} failed`, err);
      } finally {
        this.running.delete(name);
      }
    })();
    this.running.set(name, run);
    return run;
  }

  cancel(name: string) {
    const t = this.timers.get(name);
    if (t) clearInterval(t);
    this.timers.delete(name);
  }

  stopAll() {
    for (const name of [...this.timers.keys()]) this.cancel(name);
  }

  /**
   * Shutdown: no new runs, running jobs are signalled to stop and awaited until `signal` aborts (their names are
   * logged then). Never rejects. `resume()` undoes it (a relay started again).
   */
  async drain(signal?: AbortSignal): Promise<boolean> {
    this.draining = true;
    this.stopAll();
    this.ac.abort(new Error("shutting down"));
    if (!this.running.size) return true;
    const all = Promise.all(this.running.values()).then(() => true);
    const done = signal ? await Promise.race([all, whenAborted(signal).then(() => false)]) : await all;
    if (!done) this.logger.warn("jobs still running at the shutdown deadline", { jobs: [...this.running.keys()] });
    return done;
  }

  resume() {
    if (!this.draining) return;
    this.draining = false;
    this.ac = new AbortController();
  }
}
