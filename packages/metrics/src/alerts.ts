import type { BusEvents, LiveSnapshot } from "@beamhop/sdk";

export type AlertType = "rejections" | "memory" | "loop_lag";
type Alert = BusEvents["alert"];

export interface AlertOptions {
  rejectionsPerSec: number;
  rejectionsSustainMs: number;
  memoryRatio: number;
  memoryLimitBytes: number;
  loopLagMs: number;
  loopLagSustainMs: number;
  cooldownMs: number;
}
export const defaultAlertOptions = {
  rejectionsPerSec: 50,
  rejectionsSustainMs: 30_000,
  memoryRatio: 0.9,
  loopLagMs: 500,
  loopLagSustainMs: 10_000,
  cooldownMs: 10 * 60_000,
};

const mb = (b: number) => `${Math.round(b / 1048576)} MB`;

/** Evaluated once per tick; emits at most one alert per type per cooldown period. */
export class AlertEvaluator {
  private since: Partial<Record<AlertType, number>> = {};
  private lastFired: Partial<Record<AlertType, number>> = {};
  constructor(private opts: AlertOptions, private emit: (a: Alert) => void) {}

  evaluate(nowMs: number, s: LiveSnapshot, rejectedLastSecPerSec: number) {
    this.check("rejections", nowMs, rejectedLastSecPerSec > this.opts.rejectionsPerSec, this.opts.rejectionsSustainMs, () => ({
      level: "warning",
      title: "Rejection spike",
      message: `Rejecting ${Math.round(s.rejectedPerSec)} events/s for over ${this.opts.rejectionsSustainMs / 1000}s (possible spam or misconfiguration).`,
    }));
    const limit = this.opts.memoryLimitBytes;
    this.check("memory", nowMs, limit > 0 && s.memoryRss > limit * this.opts.memoryRatio, 0, () => ({
      level: "critical",
      title: "High memory usage",
      message: `RSS ${mb(s.memoryRss)} exceeds ${Math.round(this.opts.memoryRatio * 100)}% of the ${mb(limit)} limit.`,
    }));
    this.check("loop_lag", nowMs, s.loopLagMs > this.opts.loopLagMs, this.opts.loopLagSustainMs, () => ({
      level: "warning",
      title: "Event loop lag",
      message: `Event loop lag ${Math.round(s.loopLagMs)}ms (> ${this.opts.loopLagMs}ms for ${this.opts.loopLagSustainMs / 1000}s); the relay is overloaded.`,
    }));
  }

  private check(type: AlertType, nowMs: number, cond: boolean, sustainMs: number, make: () => Alert) {
    if (!cond) {
      delete this.since[type];
      return;
    }
    const since = (this.since[type] ??= nowMs);
    if (nowMs - since < sustainMs) return;
    const last = this.lastFired[type];
    if (last !== undefined && nowMs - last < this.opts.cooldownMs) return;
    this.lastFired[type] = nowMs;
    this.emit(make());
  }
}
