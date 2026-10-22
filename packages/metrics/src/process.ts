import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { performance } from "node:perf_hooks";

export interface ProcessSampler {
  /** cumulative CPU time in microseconds */
  cpuUsage(): { user: number; system: number };
  memoryUsage(): { rss: number; heapUsed: number };
}

export const realProcess: ProcessSampler = {
  cpuUsage: () => process.cpuUsage(),
  memoryUsage: () => {
    const m = process.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed };
  },
};

/**
 * Event-loop lag via timer drift (works identically on Bun and Node; Bun's `monitorEventLoopDelay`
 * is not functional). `take()` returns the max drift observed since the previous call.
 */
export class LoopLagMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private expected = 0;
  private max = 0;
  constructor(private intervalMs = 100) {}
  start() {
    if (this.timer) return;
    this.expected = performance.now() + this.intervalMs;
    this.timer = setInterval(() => {
      const now = performance.now();
      const drift = now - this.expected;
      if (drift > this.max) this.max = drift;
      this.expected = now + this.intervalMs;
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  take(): number {
    // a fully blocked loop hasn't fired yet: account for the pending overdue time too
    const overdue = this.timer ? performance.now() - this.expected : 0;
    const v = Math.max(this.max, overdue, 0);
    this.max = 0;
    return Math.round(v * 10) / 10;
  }
}

/** Memory limit heuristic: explicit > BEAMHOP_MEMORY_LIMIT (bytes) > cgroup v2/v1 limit > total system memory. */
export function detectMemoryLimit(explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  const env = Number(process.env.BEAMHOP_MEMORY_LIMIT);
  if (env > 0) return env;
  const total = totalmem();
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = Number(readFileSync(f, "utf8").trim());
      if (v > 0 && v < total) return v;
    } catch {
      // not in a cgroup / not linux
    }
  }
  return total;
}
