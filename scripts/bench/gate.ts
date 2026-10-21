// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Performance regression gate (GAPS D1, PLAN §3.5 / §15).
 *
 *   bun scripts/bench/gate.ts                       # CI profile, all benches
 *   bun scripts/bench/gate.ts --only load,verify    # a subset
 *   bun scripts/bench/gate.ts --out bench-results   # where results.json goes (default: $TMPDIR/beamhop-bench-results)
 *   BENCH_PROFILE=full bun scripts/bench/gate.ts    # 10k conns / 5k ev/s (local only)
 *
 * Runs, each in its own process:
 *  - load:    `scripts/bench/load.ts` with a CI-sized profile (real server, SQLite, sockets)
 *  - verify:  `packages/runtime-bun/bench/verify.ts` (signature checks inline + thread pool)
 *  - storage: `packages/storage-sql/bench/ingest.ts` (bun:sqlite ingest)
 *  - fanout:  `packages/relay/bench/fanout.ts` (subscription index broadcast + engine ingest)
 * and compares every metric with `scripts/bench/thresholds.json` (absolute floors/ceilings
 * for a 2-vCPU CI runner — see `_derivation` in that file). Exits 1 on any regression.
 *
 * Overrides for local runs (no file edit needed):
 *  - `BENCH_THRESHOLDS=<file>`               use another thresholds file
 *  - `BENCH_<BENCH>_<METRIC>_<MIN|MAX>=<n>`  one bound, e.g. BENCH_LOAD_ACCEPTED_EPS_MIN=900
 *  - `BENCH_SCALE=<f>`                       multiply every `min` by f and divide every `max`
 *                                            by f (e.g. 2 on a fast laptop to tighten)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lastJsonLine } from './lib.ts';

const ROOT = resolve(import.meta.dir, '../..');

export type Bound = { min?: number; max?: number };
export type Thresholds = Record<string, Record<string, Bound>>;
export type Metrics = Record<string, Record<string, number | null | undefined>>;

export interface Check {
  bench: string;
  metric: string;
  value: number | null;
  bound: 'min' | 'max';
  limit: number;
  ok: boolean;
}

/** Thresholds from the file, with env overrides and scale applied. Keys starting with `_` are comments. */
export function effectiveThresholds(file: Thresholds, env: Record<string, string | undefined>) {
  const scale = Number(env.BENCH_SCALE ?? 1) || 1;
  const out: Thresholds = {};
  for (const [bench, metrics] of Object.entries(file)) {
    if (bench.startsWith('_')) continue;
    out[bench] = {};
    for (const [metric, b] of Object.entries(metrics)) {
      if (metric.startsWith('_')) continue;
      const nb: Bound = {};
      for (const k of ['min', 'max'] as const) {
        const envKey = `BENCH_${bench}_${metric}_${k}`.toUpperCase();
        const fromEnv = env[envKey];
        if (fromEnv !== undefined && fromEnv !== '') nb[k] = Number(fromEnv);
        else if (b[k] !== undefined) nb[k] = k === 'min' ? b[k]! * scale : b[k]! / scale;
      }
      out[bench]![metric] = nb;
    }
  }
  return out;
}

/** Compare metrics with thresholds. A missing metric (null) fails its check. */
export function evaluate(th: Thresholds, metrics: Metrics): Check[] {
  const checks: Check[] = [];
  for (const [bench, bounds] of Object.entries(th)) {
    const m = metrics[bench];
    if (!m) continue; // bench not run (--only)
    for (const [metric, b] of Object.entries(bounds)) {
      const raw = m[metric];
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
      if (b.min !== undefined)
        checks.push({
          bench,
          metric,
          value,
          bound: 'min',
          limit: b.min,
          ok: value !== null && value >= b.min,
        });
      if (b.max !== undefined)
        checks.push({
          bench,
          metric,
          value,
          bound: 'max',
          limit: b.max,
          ok: value !== null && value <= b.max,
        });
    }
  }
  return checks;
}

/** Parse the text output of the storage ingest bench (it prints no JSON line). */
export function parseStorage(out: string): Metrics[string] {
  const num = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : null;
  };
  return {
    ingest_eps: num(/^ingest: .*= (\d+) events\/s/m),
    ingest_sequential_eps: num(/^ingest \(sequential awaits\): (\d+) events\/s/m),
    query_author_feed_ms: num(/^query author feed 50 authors\s+([\d.]+) ms/m),
    query_mentions_ms: num(/^query #p mentions \(limit 50\)\s+([\d.]+) ms/m),
  };
}

/** Parse the text output of the relay fan-out bench. */
export function parseFanout(out: string): Metrics[string] {
  const num = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]!.replace(/[,_\s]/g, '')) : null;
  };
  return {
    broadcast_eps: num(/^broadcast: ([\d,]+) events\/s/m),
    broadcast_frames_per_s: num(/^broadcast: [\d,]+ events\/s, ([\d,]+) frames\/s/m),
    ingest_eps: num(/^ingest \(verify\+store\+fan-out\): ([\d,]+) events\/s/m),
  };
}

interface Profile {
  load: string[];
  verifyEnv: Record<string, string>;
  storageArgs: string[];
  fanoutEnv: Record<string, string>;
}

export const PROFILES: Record<string, Profile> = {
  // Sized for a 2-vCPU GitHub runner: ~2-3 minutes in total.
  ci: {
    load: [
      '--conns',
      '1000',
      '--rate',
      '400',
      '--duration',
      '15',
      '--history',
      '2000',
      '--shards',
      '2',
      '--publishers',
      '20',
      '--authors',
      '2000',
    ],
    verifyEnv: { EVENTS: '6000', WORKERS: '1,2' },
    storageArgs: ['30000'],
    fanoutEnv: { SUBS: '10000', EVENTS: '20000', INGEST: '1000' },
  },
  // The §3.5 target; for a quiet developer machine, not CI.
  full: {
    load: ['--conns', '10000', '--rate', '5000', '--duration', '30'],
    verifyEnv: { EVENTS: '20000' },
    storageArgs: ['100000'],
    fanoutEnv: {},
  },
};

async function run(
  cmd: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; ms: number }> {
  const t0 = performance.now();
  const p = Bun.spawn(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  return { code, out, ms: performance.now() - t0 };
}

const NUMERIC = (o: Record<string, unknown> | null): Metrics[string] =>
  Object.fromEntries(
    Object.entries(o ?? {}).filter(([, v]) => typeof v === 'number' || v === null),
  ) as Metrics[string];

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = new Set((opt('only') ?? 'load,verify,storage,fanout').split(','));
  const outDir = resolve(opt('out') ?? join(tmpdir(), 'beamhop-bench-results'));
  const profileName = process.env.BENCH_PROFILE ?? 'ci';
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown BENCH_PROFILE ${profileName}`);
  const thresholdsPath = process.env.BENCH_THRESHOLDS ?? join(import.meta.dir, 'thresholds.json');
  const file = JSON.parse(readFileSync(thresholdsPath, 'utf8')) as Thresholds;
  const th = effectiveThresholds(file, process.env);

  const bun = process.execPath;
  const metrics: Metrics = {};
  const raw: Record<string, unknown> = {};
  const failures: string[] = [];

  console.log(
    `bench gate: profile ${profileName}, ${cpus().length} cores, load avg ${loadavg()
      .map((n) => n.toFixed(1))
      .join(' ')}, thresholds ${thresholdsPath}`,
  );
  if (only.has('load')) {
    console.log('\n── load (real server, sockets) ──');
    const r = await run([bun, 'scripts/bench/load.ts', ...profile.load]);
    const j = lastJsonLine(r.out, 'load');
    if (r.code !== 0 || !j) failures.push(`load bench failed (exit ${r.code})`);
    raw.load = j;
    metrics.load = NUMERIC(j);
  }
  if (only.has('verify')) {
    console.log('\n── verify (signature checks) ──');
    const r = await run([bun, 'packages/runtime-bun/bench/verify.ts'], profile.verifyEnv);
    const j = lastJsonLine(r.out, 'verify');
    if (r.code !== 0 || !j) failures.push(`verify bench failed (exit ${r.code})`);
    raw.verify = j;
    metrics.verify = NUMERIC(j);
  }
  if (only.has('storage')) {
    console.log('\n── storage (bun:sqlite ingest + queries) ──');
    const r = await run([bun, 'packages/storage-sql/bench/ingest.ts', ...profile.storageArgs]);
    if (r.code !== 0) failures.push(`storage bench failed (exit ${r.code})`);
    metrics.storage = parseStorage(r.out);
    raw.storage = { bench: 'storage', ...metrics.storage };
  }
  if (only.has('fanout')) {
    console.log('\n── fanout (subscription index + engine ingest) ──');
    const r = await run([bun, 'packages/relay/bench/fanout.ts'], profile.fanoutEnv);
    if (r.code !== 0) failures.push(`fanout bench failed (exit ${r.code})`);
    metrics.fanout = parseFanout(r.out);
    raw.fanout = { bench: 'fanout', ...metrics.fanout };
  }

  const checks = evaluate(th, metrics);
  console.log('\n── gate ──');
  const w = Math.max(...checks.map((c) => `${c.bench}.${c.metric}`.length), 10);
  for (const c of checks) {
    const name = `${c.bench}.${c.metric}`.padEnd(w);
    const cmp = c.bound === 'min' ? '>=' : '<=';
    console.log(
      `${c.ok ? 'ok  ' : 'FAIL'}  ${name}  ${String(c.value ?? 'missing').padStart(10)} ${cmp} ${c.limit}`,
    );
  }
  for (const c of checks)
    if (!c.ok) failures.push(`${c.bench}.${c.metric} = ${c.value} (${c.bound} ${c.limit})`);

  mkdirSync(outDir, { recursive: true });
  const summary = {
    bench: 'gate',
    profile: profileName,
    cores: cpus().length,
    loadavg_1m: loadavg()[0],
    bun: Bun.version,
    at: new Date().toISOString(),
    ok: failures.length === 0,
    failures,
    results: raw,
    checks,
  };
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ bench: 'gate', ok: summary.ok, failures }));
  if (failures.length) {
    console.error(`\nbench gate FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`\nbench gate passed (${checks.length} checks); results in ${outDir}/results.json`);
}

if (import.meta.main) await main();
