// SPDX-License-Identifier: AGPL-3.0-or-later

export interface PluginStatsSnapshot {
  calls: number;
  rejections: number;
  errors: number;
  timeouts: number;
  /** 95th percentile hook time over the last {@link WINDOW} calls (ms). */
  p95Ms: number;
  avgMs: number;
  lastError?: string;
}

const WINDOW = 512;

export class PluginStats {
  calls = 0;
  rejections = 0;
  errors = 0;
  timeouts = 0;
  lastError?: string;
  private readonly times = new Float64Array(WINDOW);
  private n = 0;

  record(ms: number): void {
    this.times[this.n % WINDOW] = ms;
    this.n++;
  }

  snapshot(): PluginStatsSnapshot {
    const len = Math.min(this.n, WINDOW);
    const arr = Array.from(this.times.subarray(0, len)).sort((a, b) => a - b);
    const p95 = len ? arr[Math.min(len - 1, Math.ceil(len * 0.95) - 1)]! : 0;
    const avg = len ? arr.reduce((s, x) => s + x, 0) / len : 0;
    const round = (x: number) => Math.round(x * 1000) / 1000;
    return {
      calls: this.calls,
      rejections: this.rejections,
      errors: this.errors,
      timeouts: this.timeouts,
      p95Ms: round(p95),
      avgMs: round(avg),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}
