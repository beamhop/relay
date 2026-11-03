/** Latency samples → percentiles; small formatting helpers for the report tables. */
export class Samples {
  private xs: number[] = [];
  add(ms: number) {
    this.xs.push(ms);
  }
  get count() {
    return this.xs.length;
  }
  pct(p: number): number {
    if (!this.xs.length) return NaN;
    const s = [...this.xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  }
  summary() {
    return { n: this.count, p50: round(this.pct(50)), p95: round(this.pct(95)), p99: round(this.pct(99)), max: round(this.pct(100)) };
  }
}

export const round = (x: number, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
export const mb = (bytes: number) => round(bytes / 1024 / 1024, 1);

/** Prints rows as a markdown table. */
export function table(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const line = (xs: unknown[]) => `| ${xs.map((x) => (x === undefined ? "" : String(x))).join(" | ")} |`;
  return [line(cols), line(cols.map(() => "---")), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
}

/** Runs `fn` for every item with at most `parallel` in flight. */
export async function pool<T>(items: T[], parallel: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}
