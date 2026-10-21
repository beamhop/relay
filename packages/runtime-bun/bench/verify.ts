// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signature verification benchmark (PLAN §3.5):
 *
 *   bun packages/runtime-bun/bench/verify.ts            # 20k events
 *   EVENTS=50000 WORKERS=1,2,4,8 bun packages/runtime-bun/bench/verify.ts
 *
 * Verifies pre-signed events inline (main thread) and through the worker pool
 * with 1, 2, 4 and N (= cores − 1) threads. Events arrive in bursts of 64 per
 * event-loop turn, like frames off many sockets. While each run is going, a 1 ms
 * timer measures event-loop lag (how late it fires): high lag means WebSocket
 * I/O, REQs and pings stall.
 *
 * Prints a table, then one JSON line for CI:
 *   {"bench":"verify","events":…,"inline_eps":…,"pool_eps":…,"loop_lag_p99_ms":…,…}
 * `pool_eps` / `loop_lag_p99_ms` are for the default pool size (N);
 * `inline_loop_lag_p99_ms` is the same lag measure for inline checks.
 */
import { type NostrEvent, finalizeEvent, generateSecretKey, verifyEventSig } from '@beamhop/core';
import { VerifyPool, defaultVerifyWorkers } from '../src/verify-pool.ts';

const EVENTS = Number(process.env.EVENTS ?? 20_000);
const BURST = Number(process.env.BURST ?? 64);
const N = defaultVerifyWorkers();
const SIZES = (process.env.WORKERS ?? `1,2,4,${N}`)
  .split(',')
  .map(Number)
  .filter((n, i, a) => n > 0 && a.indexOf(n) === i);

function sign(n: number): NostrEvent[] {
  const keys = Array.from({ length: 50 }, () => generateSecretKey());
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: n }, (_, i) =>
    finalizeEvent(
      { kind: 1, created_at: now - i, tags: [['t', 'bench']], content: `bench ${i}` },
      keys[i % keys.length] as string,
    ),
  );
}

/** Timer drift sampler: fires every 1 ms, records how late each tick was. */
function lagMeter() {
  const lags: number[] = [];
  let expected = performance.now() + 1;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + 1;
    setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  return {
    stop(): { p50: number; p99: number; max: number } {
      stopped = true;
      const s = [...lags].sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
      return { p50: q(0.5), p99: q(0.99), max: s[s.length - 1] ?? 0 };
    },
  };
}

const nextTurn = () => new Promise<void>((r) => setImmediate(r));

interface Result {
  mode: string;
  eps: number;
  ms: number;
  valid: number;
  lag: { p50: number; p99: number; max: number };
}

async function runInline(events: NostrEvent[]): Promise<Result> {
  const meter = lagMeter();
  await nextTurn();
  const t0 = performance.now();
  let valid = 0;
  for (let i = 0; i < events.length; i += BURST) {
    for (const e of events.slice(i, i + BURST)) if (verifyEventSig(e)) valid++;
    await nextTurn();
  }
  const ms = performance.now() - t0;
  return { mode: 'inline', eps: (events.length / ms) * 1000, ms, valid, lag: meter.stop() };
}

async function runPool(events: NostrEvent[], workers: number): Promise<Result> {
  const pool = new VerifyPool({ workers, maxQueue: events.length + BURST });
  // Warm up: start every thread (and noble's precomputation) outside the timing.
  await Promise.all(
    Array.from({ length: workers * 2 }, (_, i) => pool.verify(events.slice(i * 64, i * 64 + 64))),
  );
  const meter = lagMeter();
  await nextTurn();
  const t0 = performance.now();
  const pending: Promise<boolean[]>[] = [];
  for (let i = 0; i < events.length; i += BURST) {
    pending.push(pool.verify(events.slice(i, i + BURST)));
    await nextTurn();
  }
  const valid = (await Promise.all(pending)).flat().filter(Boolean).length;
  const ms = performance.now() - t0;
  const lag = meter.stop();
  const fellBack = pool.stats().inline;
  await pool.close();
  if (fellBack > 0) console.warn(`  (pool ${workers}: ${fellBack} events were checked inline)`);
  return { mode: `pool ×${workers}`, eps: (events.length / ms) * 1000, ms, valid, lag };
}

const fmt = (n: number, d = 0) => n.toFixed(d).padStart(9);

console.log(`signing ${EVENTS} events…`);
const events = sign(EVENTS);
// Warm noble on the main thread too.
for (const e of events.slice(0, 200)) verifyEventSig(e);

const results: Result[] = [await runInline(events)];
for (const n of SIZES) results.push(await runPool(events, n));

console.log(
  `\ncores: ${navigator.hardwareConcurrency}, default pool: ${N}, burst: ${BURST}, bun ${Bun.version}`,
);
console.log('mode         events/s    total ms   lag p50   lag p99   lag max   valid');
for (const r of results) {
  console.log(
    `${r.mode.padEnd(10)} ${fmt(r.eps)} ${fmt(r.ms, 0)}   ${fmt(r.lag.p50, 2)} ${fmt(r.lag.p99, 2)} ${fmt(r.lag.max, 2)}   ${r.valid}`,
  );
}
const inline = results[0] as Result;
const def = results.find((r) => r.mode === `pool ×${N}`) ?? (results[results.length - 1] as Result);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
console.log(
  JSON.stringify({
    bench: 'verify',
    events: EVENTS,
    cores: navigator.hardwareConcurrency,
    workers: N,
    inline_eps: Math.round(inline.eps),
    pool_eps: Math.round(def.eps),
    loop_lag_p99_ms: round(def.lag.p99),
    inline_loop_lag_p99_ms: round(inline.lag.p99),
    pool: Object.fromEntries(
      results
        .slice(1)
        .map((r) => [
          r.mode.replace('pool ×', ''),
          { eps: Math.round(r.eps), loop_lag_p99_ms: round(r.lag.p99) },
        ]),
    ),
  }),
);
if (results.some((r) => r.valid !== EVENTS)) {
  console.error('some valid events were not verified as valid');
  process.exit(1);
}
