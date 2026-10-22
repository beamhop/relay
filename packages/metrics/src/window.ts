/**
 * Sliding per-second rate window. The hot path only does `w.cur += n` (no allocation);
 * `roll()` is called once per tick to close the current second.
 */
export class RateWindow {
  /** counts accumulated since the last roll — increment directly on the hot path */
  cur = 0;
  /** count of the most recently closed slot */
  last = 0;
  /** duration (ms) of the most recently closed slot */
  lastMs = 0;
  private counts: Float64Array;
  private durations: Float64Array;
  private head = 0;
  private prevRollMs: number;

  constructor(startMs: number, readonly size = 10) {
    this.counts = new Float64Array(size);
    this.durations = new Float64Array(size);
    this.prevRollMs = startMs;
  }

  roll(nowMs: number): number {
    const n = this.cur;
    const dur = Math.max(0, nowMs - this.prevRollMs);
    this.counts[this.head] = n;
    this.durations[this.head] = dur;
    this.head = (this.head + 1) % this.size;
    this.prevRollMs = nowMs;
    this.last = n;
    this.lastMs = dur;
    this.cur = 0;
    return n;
  }

  /** events per second over the window (actual elapsed time, robust to timer jitter) */
  rate(): number {
    let sum = 0;
    let ms = 0;
    for (let i = 0; i < this.size; i++) {
      sum += this.counts[i];
      ms += this.durations[i];
    }
    return ms > 0 ? (sum * 1000) / ms : 0;
  }

  /** per-second rate of the last closed slot */
  lastRate(): number {
    return this.lastMs > 0 ? (this.last * 1000) / this.lastMs : 0;
  }
}

/**
 * Rolling sample buffer for latency percentiles over a time window.
 * Fixed capacity ring (most recent samples win when overloaded); O(1) insert, no allocation.
 */
export class LatencyWindow {
  private values: Float64Array;
  private times: Float64Array;
  private scratch: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity = 4096) {
    this.values = new Float64Array(capacity);
    this.times = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  add(value: number, atMs: number): void {
    this.values[this.head] = value;
    this.times[this.head] = atMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** nearest-rank percentiles of samples newer than `nowMs - windowMs` */
  percentiles(nowMs: number, windowMs: number, ps: readonly number[]): number[] {
    const cutoff = nowMs - windowMs;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.times[i] >= cutoff) this.scratch[n++] = this.values[i];
    }
    if (n === 0) return ps.map(() => 0);
    const sorted = this.scratch.subarray(0, n).sort();
    return ps.map((p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))]);
  }
}
