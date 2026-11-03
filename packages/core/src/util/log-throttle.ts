/**
 * Coalesces floods of identical error lines: while the database is down or its disk full, every EVENT failed and
 * logged one line (25k lines in 8 s, possibly written to the very disk that is full). The first occurrence of a
 * message is logged; repeats within `windowMs` are only counted, and the count goes with the next line logged.
 */
export class LogThrottle {
  private seen = new Map<string, { until: number; suppressed: number }>();
  constructor(
    private readonly windowMs = 10_000,
    private readonly maxKeys = 200,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether to log `key` now, and how many repeats were left out since it was last logged. */
  take(key: string): { log: boolean; suppressed: number } {
    const t = this.now();
    const s = this.seen.get(key);
    if (s && t < s.until) {
      s.suppressed++;
      return { log: false, suppressed: 0 };
    }
    // many distinct messages (they carry ids or addresses): forget them all rather than grow
    if (!s && this.seen.size >= this.maxKeys) this.seen.clear();
    this.seen.set(key, { until: t + this.windowMs, suppressed: 0 });
    return { log: true, suppressed: s?.suppressed ?? 0 };
  }
}
