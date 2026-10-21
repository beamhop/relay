// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared helpers for the load test and the regression gate (Bun-only bench scripts). */

/** Absolute wall-clock time in ms with sub-ms resolution, comparable across processes. */
export const nowAbs = (): number => performance.timeOrigin + performance.now();

export function pct(sorted: ArrayLike<number>, p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export function round(n: number | null, d = 1): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function fmt(n: number | null | undefined, d = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '-' : n.toFixed(d);
}

/** Deterministic PRNG (LCG) so subscriptions and events are the same for every run. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Event-loop lag meter: a timer that should fire every `everyMs`; records how late
 * each tick was. High lag means sockets, REQs and pings stall.
 */
export function lagMeter(everyMs = 10) {
  let lags: number[] = [];
  let expected = performance.now() + everyMs;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + everyMs;
    setTimeout(tick, everyMs);
  };
  setTimeout(tick, everyMs);
  return {
    reset() {
      lags = [];
    },
    stats(): { p50: number | null; p99: number | null; max: number | null } {
      const s = Float64Array.from(lags).sort();
      return { p50: pct(s, 50), p99: pct(s, 99), max: s.length ? s[s.length - 1]! : null };
    },
    stop() {
      stopped = true;
    },
  };
}

/** Wait until `url` answers 2xx, or throw after `timeoutMs`. */
export async function waitHealthy(url: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
      last = r.status;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(200);
  }
  throw new Error(`server did not become healthy at ${url}: ${String(last)}`);
}

/** Resident set size of another process in MB (via `ps`), or null. */
export function rssOfPid(pid: number): number | null {
  const r = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)]);
  const kb = Number(r.stdout.toString().trim());
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
}

/** Pick a free TCP port on 127.0.0.1. */
export function freePort(): number {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = s.port as number;
  s.stop(true);
  return port;
}

/** Last line of `text` that parses as JSON with `bench === name`. */
export function lastJsonLine<T = Record<string, unknown>>(text: string, name: string): T | null {
  const lines = text.split('\n').reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as { bench?: string };
      if (o.bench === name) return o as T;
    } catch {
      // not JSON
    }
  }
  return null;
}
