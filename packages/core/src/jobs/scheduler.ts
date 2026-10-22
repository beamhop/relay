import type { Logger } from "@beamhop/sdk";

type Timer = ReturnType<typeof setInterval>;

/** Interval jobs with overlap protection; timers are unref'd so they never keep the process alive. */
export class Scheduler {
  private timers = new Map<string, Timer>();
  private running = new Set<string>();
  constructor(private readonly logger: Logger) {}

  every(name: string, intervalMs: number, fn: () => Promise<unknown> | unknown): void {
    this.cancel(name);
    const t = setInterval(() => void this.runNow(name, fn), intervalMs);
    (t as { unref?: () => void }).unref?.();
    this.timers.set(name, t);
  }

  async runNow(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      this.logger.error(`job ${name} failed`, { err: String(err) });
    } finally {
      this.running.delete(name);
    }
  }

  cancel(name: string) {
    const t = this.timers.get(name);
    if (t) clearInterval(t);
    this.timers.delete(name);
  }

  stopAll() {
    for (const name of [...this.timers.keys()]) this.cancel(name);
  }
}
