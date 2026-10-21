// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * End-to-end load test (PLAN §3.5: 10,000 connections and 5,000 incoming events/s per node).
 *
 *   bun scripts/bench/load.ts                                  # 10k conns, 5k ev/s, 30 s
 *   bun scripts/bench/load.ts --conns 2000 --rate 1000 --duration 10
 *   bun scripts/bench/load.ts --binary dist/beamhop-server     # the compiled single binary
 *   bun scripts/bench/load.ts --url ws://127.0.0.1:3334        # an already running server
 *
 * What it does:
 *  1. Signs all events up front on worker threads (signing must not limit the publish rate).
 *  2. Boots the real server (`packages/runtime-bun/src/main.ts`, or `--binary`) in its own
 *     process on a free local port with a temp data dir (default storage: SQLite) and
 *     generous rate limits; publishes `--history` events so first REQs hit real storage.
 *  3. Opens `--conns` reader connections spread over `--shards` client processes. Each reader
 *     subscribes a realistic mix: a follow feed (`authors` = `--follows` people, kind 1,
 *     limit 10 → a history query), its mentions (`#p`, kinds 1/7) and, for
 *     `--hashtag-share` of readers, one hashtag (`#t`). Waits for every EOSE.
 *  4. Publishes `--rate` pre-signed events/s from `--publishers` connections for
 *     `--duration` s (80% notes, 20% reactions; every event mentions one reader, 20% of
 *     notes carry a hashtag), on a fixed schedule (late sends catch up, so latency includes
 *     any queueing — no coordinated omission).
 *  5. Reports accepted events/s, OK latency p50/p95/p99, live delivery latency p50/p95/p99
 *     (publisher send → reader receive), delivered/expected ratio (expected is computed
 *     exactly from the subscriptions), errors, server RSS and server event-loop lag.
 *
 * Output: a human table, then one JSON line `{"bench":"load",...}` (also `--json-out <file>`).
 * Exit code 0 unless the run could not be carried out; pass/fail is the gate's job
 * (`scripts/bench/gate.ts`), or use `--assert-target` to exit 1 when the §3.5 target is not met.
 *
 * Many sockets need many file descriptors: Bun raises the soft limit to the hard limit at
 * start-up; if connections fail, raise it (`ulimit -n 65536`) and, on Linux, widen
 * `net.ipv4.ip_local_port_range`. Every connection comes from 127.0.0.1, so per-address
 * limits are lifted in the generated settings file (they are tested elsewhere).
 */
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent } from '../../packages/core/src/index.ts';
import { generateSecretKey } from '../../packages/core/src/index.ts';
import { fmt, freePort, lagMeter, nowAbs, pct, rng, round, rssOfPid, waitHealthy } from './lib.ts';
import type { SignJob } from './sign-worker.ts';

export interface LoadOptions {
  conns: number;
  rate: number;
  duration: number;
  publishers: number;
  authors: number;
  follows: number;
  hashtags: number;
  hashtagShare: number;
  history: number;
  shards: number;
  connectConcurrency: number;
  verifyWorkers: number | null;
  binary: string | null;
  url: string | null;
  jsonOut: string | null;
  assertTarget: boolean;
  quiet: boolean;
}

const CORES = cpus().length;

export const DEFAULTS: LoadOptions = {
  conns: 10_000,
  rate: 5_000,
  duration: 30,
  publishers: 50,
  authors: 10_000,
  follows: 5,
  hashtags: 200,
  hashtagShare: 0.2,
  history: 10_000,
  shards: Math.max(1, Math.min(8, CORES - 2)),
  connectConcurrency: 64,
  verifyWorkers: null,
  binary: null,
  url: null,
  jsonOut: null,
  assertTarget: false,
  quiet: false,
};

const FLAG: Record<string, keyof LoadOptions> = {
  conns: 'conns',
  rate: 'rate',
  duration: 'duration',
  publishers: 'publishers',
  authors: 'authors',
  follows: 'follows',
  hashtags: 'hashtags',
  'hashtag-share': 'hashtagShare',
  history: 'history',
  shards: 'shards',
  'connect-concurrency': 'connectConcurrency',
  'verify-workers': 'verifyWorkers',
  binary: 'binary',
  url: 'url',
  'json-out': 'jsonOut',
  'assert-target': 'assertTarget',
  quiet: 'quiet',
};

export function parseLoadArgs(argv: string[]): LoadOptions {
  const o: LoadOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (!raw.startsWith('--')) throw new Error(`unexpected argument ${raw}`);
    const key = FLAG[raw.slice(2)];
    if (!key) throw new Error(`unknown option ${raw}`);
    if (key === 'assertTarget' || key === 'quiet') {
      (o as unknown as Record<string, unknown>)[key] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${raw} needs a value`);
    if (key === 'binary' || key === 'url' || key === 'jsonOut')
      (o as unknown as Record<string, unknown>)[key] = v;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${raw}: not a number: ${v}`);
      (o as unknown as Record<string, unknown>)[key] = n;
    }
  }
  if (o.conns < 1 || o.rate <= 0 || o.duration <= 0 || o.publishers < 1 || o.shards < 1)
    throw new Error('conns, rate, duration, publishers and shards must be positive');
  return o;
}

export interface LoadResult {
  bench: 'load';
  mode: 'source' | 'binary' | 'external';
  conns: number;
  opened: number;
  connect_failures: number;
  connect_retries: number;
  subscriptions: number;
  publishers: number;
  rate_target: number;
  duration_s: number;
  sent: number;
  accepted: number;
  rejected: number;
  accepted_eps: number;
  ok_p50_ms: number | null;
  ok_p95_ms: number | null;
  ok_p99_ms: number | null;
  delivered: number;
  expected: number;
  delivered_ratio: number | null;
  deliveries_per_s: number;
  delivery_p50_ms: number | null;
  delivery_p95_ms: number | null;
  delivery_p99_ms: number | null;
  errors: number;
  error_detail: Record<string, number>;
  connect_s: number;
  server_rss_mb: number | null;
  server_rss_peak_mb: number | null;
  loop_lag_p50_ms: number | null;
  loop_lag_p99_ms: number | null;
  loop_lag_max_ms: number | null;
  client_lag_p99_ms: number | null;
  cores: number;
  loadavg_1m: number;
  bun: string;
  target_met: boolean;
}

const log = (o: LoadOptions, ...a: unknown[]) => {
  if (!o.quiet) console.error(...a);
};

// ── Workload ──────────────────────────────────────────────────────────────────

interface Template {
  key: number;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}

/** Synthetic 64-hex "user" id for reader `i` (what its mentions sub listens for). */
const userTag = (i: number) => `be${i.toString(16).padStart(62, '0')}`;

interface Workload {
  subs: Array<Array<[string, Record<string, unknown>]>>;
  /** Per reader: followed author indexes, and its hashtag (-1 = none). */
  follows: number[][];
  tagOf: Int32Array;
  templates: Template[];
  /** Per live event: author index, kind, hashtag (-1 = none), mentioned reader. */
  meta: Array<{ author: number; kind: number; tag: number; mention: number }>;
}

/** Live deliveries expected per accepted event, counting only readers that connected. */
function expectedFor(o: LoadOptions, w: Workload, connected: Uint8Array) {
  const followers = new Uint32Array(o.authors);
  const hashtagSubs = new Uint32Array(o.hashtags);
  for (let i = 0; i < o.conns; i++) {
    if (!connected[i]) continue;
    for (const a of w.follows[i]!) followers[a]!++;
    if (w.tagOf[i]! >= 0) hashtagSubs[w.tagOf[i]!]!++;
  }
  return (m: Workload['meta'][number]) =>
    (connected[m.mention] ? 1 : 0) +
    (m.kind === 1 ? followers[m.author]! + (m.tag >= 0 ? hashtagSubs[m.tag]! : 0) : 0);
}

function buildWorkload(o: LoadOptions, runTag: string): Workload {
  const r = rng(42);
  const subs: Workload['subs'] = [];
  const follows: number[][] = [];
  const tagOf = new Int32Array(o.conns).fill(-1);
  for (let i = 0; i < o.conns; i++) {
    const follow = new Set<number>();
    while (follow.size < Math.min(o.follows, o.authors)) follow.add(Math.floor(r() * o.authors));
    follows.push([...follow]);
    const reqs: Array<[string, Record<string, unknown>]> = [];
    if (follow.size > 0)
      reqs.push(['feed', { kinds: [1], authors: [...follow].map((a) => `@${a}`), limit: 10 }]);
    reqs.push(['mentions', { kinds: [1, 7], '#p': [userTag(i)], limit: 0 }]);
    if (r() < o.hashtagShare) {
      const t = Math.floor(r() * o.hashtags);
      tagOf[i] = t;
      reqs.push(['tag', { kinds: [1], '#t': [`${runTag}-t${t}`], limit: 0 }]);
    }
    subs.push(reqs);
  }
  const total = o.history + Math.ceil(o.rate * o.duration);
  const now = Math.floor(Date.now() / 1000);
  const templates: Template[] = [];
  const meta: Workload['meta'] = [];
  for (let i = 0; i < total; i++) {
    const author = Math.floor(r() * o.authors);
    const kind = r() < 0.8 ? 1 : 7;
    const mention = Math.floor(r() * o.conns);
    const tags: string[][] = [['p', userTag(mention)]];
    let tag = -1;
    if (kind === 1 && r() < 0.2) {
      tag = Math.floor(r() * o.hashtags);
      tags.push(['t', `${runTag}-t${tag}`]);
    }
    if (kind === 7) tags.push(['e', (i * 2654435761).toString(16).padStart(64, '0').slice(-64)]);
    const historic = i < o.history;
    templates.push({
      key: author,
      kind,
      created_at: historic ? now - 3600 + Math.floor(i / 100) : now,
      content: kind === 7 ? `+ ${runTag} #${i}` : `${runTag} note #${i}`,
      tags,
    });
    if (!historic) meta.push({ author, kind, tag, mention });
  }
  return { subs, follows, tagOf, templates, meta };
}

async function signAll(templates: Template[], keys: string[]): Promise<NostrEvent[]> {
  const n = Math.max(1, Math.min(CORES - 1, 12));
  const chunk = Math.ceil(templates.length / n);
  const parts = await Promise.all(
    Array.from({ length: n }, (_, w) => {
      const slice = templates.slice(w * chunk, (w + 1) * chunk);
      if (slice.length === 0) return Promise.resolve([] as NostrEvent[]);
      return new Promise<NostrEvent[]>((resolve, reject) => {
        const worker = new Worker(new URL('./sign-worker.ts', import.meta.url).href);
        worker.onmessage = (e: MessageEvent<NostrEvent[]>) => {
          resolve(e.data);
          worker.terminate();
        };
        worker.onerror = (e) => reject(e);
        worker.postMessage({ templates: slice, keys } satisfies SignJob);
      });
    }),
  );
  return parts.flat();
}

// ── Server ────────────────────────────────────────────────────────────────────

interface ServerHandle {
  url: string;
  mode: LoadResult['mode'];
  stats(): Promise<{
    rssMb: number | null;
    rssPeakMb: number | null;
    lag: { p50: number | null; p99: number | null; max: number | null } | null;
  }>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

const SETTINGS = (port: number) => `# generated by scripts/bench/load.ts
node:
  tls: { mode: 'off' }
relays:
  - id: main
    hosts: ['127.0.0.1', 'localhost', '127.0.0.1:${port}', 'localhost:${port}']
    limits:
      eventsPerMinute: 100000000
      reqPerMinute: 100000000
      maxSubscriptions: 50
`;
// The per-address post limit is eventsPerMinute × policy.ipMultiplier, so it is lifted too
// (no `modules.policy` section needed).

async function bootServer(o: LoadOptions): Promise<ServerHandle> {
  if (o.url) {
    const url = o.url;
    return {
      url,
      mode: 'external',
      stats: async () => ({ rssMb: null, rssPeakMb: null, lag: null }),
      reset: async () => {},
      stop: async () => {},
    };
  }
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'beamhop-load-'));
  const port = freePort();
  writeFileSync(join(dir, 'beamhop.yaml'), SETTINGS(port));
  const args = [
    '--config',
    join(dir, 'beamhop.yaml'),
    '--data-dir',
    join(dir, 'data'),
    '--listen',
    `127.0.0.1:${port}`,
    '--no-config-writeback',
  ];
  if (o.verifyWorkers !== null) args.push('--verify-workers', String(o.verifyWorkers));
  const env = { ...process.env, BEAMHOP_LOG_LEVEL: 'warn' };
  const pending = new Map<string, (m: Record<string, unknown>) => void>();
  const cmd = o.binary
    ? [o.binary, ...args]
    : [
        process.execPath,
        // BENCH_SERVER_PROFILE=<dir>: write a CPU profile (markdown) of the server on exit.
        ...(process.env.BENCH_SERVER_PROFILE
          ? ['--cpu-prof-md', `--cpu-prof-dir=${process.env.BENCH_SERVER_PROFILE}`]
          : []),
        join(import.meta.dir, 'server.ts'),
        ...args,
      ];
  const proc = Bun.spawn(cmd, {
    env,
    stdout: 'ignore',
    stderr: 'inherit',
    ...(o.binary
      ? {}
      : {
          ipc(m: Record<string, unknown>) {
            const key = String(m.type).replace(/-ok$/, '');
            pending.get(key)?.(m);
            pending.delete(key);
          },
        }),
  });
  const ask = (type: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(type, resolve);
      proc.send({ type });
      setTimeout(() => reject(new Error(`server did not answer ${type}`)), 10_000);
    });
  let rssPeak = 0;
  const sampler = o.binary
    ? setInterval(() => {
        const r = rssOfPid(proc.pid);
        if (r !== null && r > rssPeak) rssPeak = r;
      }, 500)
    : null;
  try {
    await waitHealthy(`http://127.0.0.1:${port}/healthz`, 60_000);
  } catch (err) {
    proc.kill();
    throw err;
  }
  return {
    url: `ws://127.0.0.1:${port}`,
    mode: o.binary ? 'binary' : 'source',
    async stats() {
      if (o.binary) {
        const rss = rssOfPid(proc.pid);
        return { rssMb: rss, rssPeakMb: Math.max(rssPeak, rss ?? 0) || null, lag: null };
      }
      const s = (await ask('stats')) as {
        rssMb: number;
        rssPeakMb: number;
        lag: { p50: number | null; p99: number | null; max: number | null };
      };
      return { rssMb: s.rssMb, rssPeakMb: s.rssPeakMb, lag: s.lag };
    },
    async reset() {
      rssPeak = 0;
      if (!o.binary) await ask('reset');
    },
    async stop() {
      if (sampler) clearInterval(sampler);
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      await proc.exited;
      clearTimeout(t);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── Clients ───────────────────────────────────────────────────────────────────

function openWs(url: string, timeoutMs = 15_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('connect error'));
    };
  });
}

interface ShardStats {
  deliveries: number;
  notices: number;
  closedSubs: number;
  disconnects: number;
  sampleIdx: number[];
  sampleAt: number[];
  lag: { p99: number | null };
}

function spawnShard() {
  let onMsg: ((m: Record<string, unknown>) => void) | null = null;
  const waiters = new Map<string, (m: Record<string, unknown>) => void>();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'client.ts')], {
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(m: Record<string, unknown>) {
      onMsg?.(m);
      const w = waiters.get(String(m.type));
      if (w) {
        waiters.delete(String(m.type));
        w(m);
      }
    },
  });
  onMsg = null;
  const wait = (type: string, timeoutMs: number) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.set(type, resolve);
      setTimeout(() => reject(new Error(`client shard: no ${type}`)), timeoutMs);
    });
  return { proc, wait, send: (m: unknown) => proc.send(m) };
}

// ── Run ───────────────────────────────────────────────────────────────────────

export async function runLoad(o: LoadOptions): Promise<LoadResult> {
  const runTag = `lt${Date.now().toString(36)}`;
  const live = Math.ceil(o.rate * o.duration);
  log(
    o,
    `load: ${o.conns} readers over ${o.shards} client processes, ${o.publishers} publishers, ` +
      `${o.rate} ev/s for ${o.duration}s (${live} events, ${o.history} history), ${CORES} cores, ` +
      `load avg ${loadavg()
        .map((n) => n.toFixed(1))
        .join(' ')}`,
  );

  // 1. Workload + signatures.
  let t = performance.now();
  const keys = Array.from({ length: o.authors }, () => generateSecretKey());
  const w = buildWorkload(o, runTag);
  const events = await signAll(w.templates, keys);
  const authorPk = new Map<number, string>();
  for (let i = 0; i < events.length; i++) authorPk.set(w.templates[i]!.key, events[i]!.pubkey);
  // Readers' follow lists name authors by index until the pubkeys are known.
  for (const reqs of w.subs)
    for (const [, f] of reqs)
      if (Array.isArray(f.authors))
        f.authors = (f.authors as string[]).map((a) => {
          const pk = authorPk.get(Number(a.slice(1)));
          // An author that never posts still needs a well-formed key.
          return pk ?? `${Number(a.slice(1)).toString(16).padStart(64, 'a')}`;
        });
  log(o, `signed ${events.length} events in ${fmt((performance.now() - t) / 1000)} s`);

  // 2. Server.
  const server = await bootServer(o);
  const errors: Record<string, number> = {};
  const addErr = (k: string, n = 1) => {
    if (n > 0) errors[k] = (errors[k] ?? 0) + n;
  };
  const shards: ReturnType<typeof spawnShard>[] = [];
  try {
    log(o, `server: ${server.url} (${server.mode})`);
    const pubs: WebSocket[] = [];
    for (let i = 0; i < o.publishers; i++) pubs.push(await openWs(server.url));

    // History so the readers' first REQs query real storage.
    const indexOf = new Map<string, number>();
    for (let i = 0; i < events.length; i++) indexOf.set(events[i]!.id, i);
    if (o.history > 0) {
      t = performance.now();
      let acked = 0;
      let next = 0;
      await new Promise<void>((resolve) => {
        const inflight = 2_000;
        const pump = () => {
          while (next < o.history && next - acked < inflight) {
            pubs[next % pubs.length]!.send(JSON.stringify(['EVENT', events[next]]));
            next++;
          }
        };
        for (const ws of pubs)
          ws.onmessage = () => {
            acked++;
            if (acked >= o.history) resolve();
            else pump();
          };
        pump();
      });
      log(o, `history: ${o.history} events stored in ${fmt((performance.now() - t) / 1000)} s`);
    }

    // 3. Readers.
    t = performance.now();
    const per = Math.ceil(o.conns / o.shards);
    const maxSamples = Math.ceil(400_000 / o.shards);
    for (let s = 0; s < o.shards; s++) shards.push(spawnShard());
    await Promise.all(shards.map((sh) => sh.wait('hello', 15_000)));
    const ready = await Promise.all(
      shards.map((sh, s) => {
        sh.send({
          type: 'init',
          url: server.url,
          conns: w.subs.slice(s * per, (s + 1) * per),
          connectConcurrency: Math.max(1, Math.floor(o.connectConcurrency / o.shards)),
          maxSamples,
        });
        return sh.wait('ready', 600_000) as Promise<{
          opened: number;
          failed: number;
          failedIdx: number[];
          retries: number;
          failReasons: Record<string, number>;
          eose: number;
          reqs: number;
        }>;
      }),
    );
    const opened = ready.reduce((n, r) => n + r.opened, 0);
    const connectFailures = ready.reduce((n, r) => n + r.failed, 0);
    const missingEose = ready.reduce((n, r) => n + Math.max(0, r.reqs - r.eose), 0);
    addErr('no_eose', missingEose);
    for (const r of ready)
      for (const [why, n] of Object.entries(r.failReasons)) addErr(`connect_failed:${why}`, n);
    const connectRetries = ready.reduce((n, r) => n + r.retries, 0);
    const connectS = (performance.now() - t) / 1000;
    const connected = new Uint8Array(o.conns).fill(1);
    ready.forEach((r, s) => {
      for (const k of r.failedIdx) connected[s * per + k] = 0;
    });
    const subscriptions = ready.reduce((n, r) => n + r.reqs, 0);
    log(
      o,
      `readers: ${opened}/${o.conns} connected, ${subscriptions} subscriptions in ${fmt(connectS)} s`,
    );

    // 4. Publish on a fixed schedule.
    await server.reset();
    for (const sh of shards) sh.send({ type: 'start' });
    const lag = lagMeter(10);
    const okLat: number[] = [];
    const sendAt = new Float64Array(events.length);
    const accepted = new Uint8Array(events.length);
    let acceptedN = 0;
    let rejectedN = 0;
    let lastOkAt = 0;
    for (const ws of pubs) {
      ws.onmessage = (e) => {
        const s = String(e.data);
        if (!s.startsWith('["OK"')) {
          if (s.startsWith('["NOTICE"')) addErr('publisher_notice');
          return;
        }
        const f = JSON.parse(s) as [string, string, boolean, string];
        const i = indexOf.get(f[1]);
        if (i === undefined || i < o.history) return;
        lastOkAt = nowAbs();
        okLat.push(lastOkAt - sendAt[i]!);
        if (f[2]) {
          accepted[i] = 1;
          acceptedN++;
        } else {
          rejectedN++;
          addErr(`refused:${String(f[3]).split(':')[0]}`);
        }
      };
      ws.onclose = () => addErr('publisher_disconnected');
    }
    const first = o.history;
    let next = first;
    const startAbs = nowAbs();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const due = Math.min(
          events.length,
          first + Math.floor(((nowAbs() - startAbs) * o.rate) / 1000) + 1,
        );
        while (next < due) {
          const ws = pubs[next % pubs.length]!;
          sendAt[next] = nowAbs();
          ws.send(JSON.stringify(['EVENT', events[next]]));
          next++;
        }
        if (next >= events.length) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    const sendSeconds = (nowAbs() - startAbs) / 1000;
    // Drain: wait for every OK, then for deliveries to settle (max 15 s).
    const drainUntil = performance.now() + 15_000;
    while (acceptedN + rejectedN < live && performance.now() < drainUntil) await Bun.sleep(100);
    await Bun.sleep(1_000);
    const clientLag = lag.stats();
    lag.stop();
    const srv = await server.stats();

    const st = (await Promise.all(
      shards.map((sh) => {
        sh.send({ type: 'stats' });
        return sh.wait('stats', 60_000);
      }),
    )) as unknown as ShardStats[];
    addErr('missing_ok', live - acceptedN - rejectedN);

    // 5. Results.
    // Exact: every subscription of every connected reader that matches an accepted event.
    const deliveriesOf = expectedFor(o, w, connected);
    let expected = 0;
    for (let i = first; i < events.length; i++)
      if (accepted[i]) expected += deliveriesOf(w.meta[i - first]!);
    const delivered = st.reduce((n, s) => n + s.deliveries, 0);
    const lat: number[] = [];
    for (const s of st)
      for (let k = 0; k < s.sampleIdx.length; k++) {
        const i = s.sampleIdx[k]!;
        if (i >= first && sendAt[i]! > 0) lat.push(s.sampleAt[k]! - sendAt[i]!);
      }
    const dl = Float64Array.from(lat).sort();
    const ok = Float64Array.from(okLat).sort();
    addErr(
      'reader_notice',
      st.reduce((n, s) => n + s.notices, 0),
    );
    addErr(
      'reader_closed_sub',
      st.reduce((n, s) => n + s.closedSubs, 0),
    );
    addErr(
      'reader_disconnected',
      st.reduce((n, s) => n + s.disconnects, 0),
    );
    const wall = Math.max(sendSeconds, (lastOkAt - startAbs) / 1000);
    const acceptedEps = acceptedN / wall;
    const errorsTotal = Object.entries(errors).reduce(
      (n, [k, v]) => n + (k.startsWith('refused:duplicate') ? 0 : v),
      0,
    );
    const clientLagP99 = Math.max(clientLag.p99 ?? 0, ...st.map((s) => s.lag.p99 ?? 0));
    const result: LoadResult = {
      bench: 'load',
      mode: server.mode,
      conns: o.conns,
      opened,
      connect_failures: connectFailures,
      connect_retries: connectRetries,
      subscriptions,
      publishers: o.publishers,
      rate_target: o.rate,
      duration_s: o.duration,
      sent: next - first,
      accepted: acceptedN,
      rejected: rejectedN,
      accepted_eps: Math.round(acceptedEps),
      ok_p50_ms: round(pct(ok, 50)),
      ok_p95_ms: round(pct(ok, 95)),
      ok_p99_ms: round(pct(ok, 99)),
      delivered,
      expected,
      delivered_ratio: expected > 0 ? round(delivered / expected, 4) : null,
      deliveries_per_s: Math.round(delivered / wall),
      delivery_p50_ms: round(pct(dl, 50)),
      delivery_p95_ms: round(pct(dl, 95)),
      delivery_p99_ms: round(pct(dl, 99)),
      errors: errorsTotal,
      error_detail: errors,
      connect_s: round(connectS) ?? 0,
      server_rss_mb: round(srv.rssMb),
      server_rss_peak_mb: round(srv.rssPeakMb),
      loop_lag_p50_ms: round(srv.lag?.p50 ?? null, 2),
      loop_lag_p99_ms: round(srv.lag?.p99 ?? null, 2),
      loop_lag_max_ms: round(srv.lag?.max ?? null, 2),
      client_lag_p99_ms: round(clientLagP99, 2),
      cores: CORES,
      loadavg_1m: round(loadavg()[0] ?? 0, 2) ?? 0,
      bun: Bun.version,
      target_met: false,
    };
    result.target_met =
      opened >= 10_000 &&
      acceptedEps >= 5_000 * 0.98 &&
      (result.ok_p95_ms ?? Number.POSITIVE_INFINITY) < 1_000 &&
      (result.delivered_ratio ?? 0) >= 0.99;
    for (const ws of pubs) {
      ws.onclose = null;
      ws.close();
    }
    result.error_detail = { ...errors };
    return result;
  } finally {
    for (const sh of shards) sh.proc.kill();
    await server.stop();
  }
}

export function printTable(r: LoadResult): void {
  const rows: Array<[string, string]> = [
    ['server', `${r.mode}, ${r.cores} cores, bun ${r.bun}, load avg ${r.loadavg_1m}`],
    [
      'connections',
      `${r.opened}/${r.conns} open (${r.connect_failures} failed, ${r.connect_retries} retried), ${r.subscriptions} subscriptions, opened in ${fmt(r.connect_s)} s`,
    ],
    ['publish', `${r.sent} events at ${r.rate_target} ev/s target from ${r.publishers} conns`],
    ['accepted', `${r.accepted} (${r.accepted_eps} ev/s), refused ${r.rejected}`],
    [
      'OK latency',
      `p50 ${fmt(r.ok_p50_ms)} ms, p95 ${fmt(r.ok_p95_ms)} ms, p99 ${fmt(r.ok_p99_ms)} ms`,
    ],
    [
      'delivered',
      `${r.delivered} of ${r.expected} expected (ratio ${fmt(r.delivered_ratio, 4)}), ${r.deliveries_per_s} msg/s`,
    ],
    [
      'delivery latency',
      `p50 ${fmt(r.delivery_p50_ms)} ms, p95 ${fmt(r.delivery_p95_ms)} ms, p99 ${fmt(r.delivery_p99_ms)} ms`,
    ],
    ['errors', `${r.errors} ${JSON.stringify(r.error_detail)}`],
    [
      'server memory',
      `RSS ${fmt(r.server_rss_mb, 0)} MB (peak ${fmt(r.server_rss_peak_mb, 0)} MB)`,
    ],
    [
      'server event loop',
      `lag p50 ${fmt(r.loop_lag_p50_ms, 2)} ms, p99 ${fmt(r.loop_lag_p99_ms, 2)} ms, max ${fmt(r.loop_lag_max_ms, 2)} ms`,
    ],
    ['client event loops', `lag p99 ${fmt(r.client_lag_p99_ms, 2)} ms (high = client-bound)`],
    ['§3.5 target', r.target_met ? 'MET (10k conns, 5k ev/s)' : 'not demonstrated by this run'],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
}

if (import.meta.main) {
  const o = parseLoadArgs(process.argv.slice(2));
  const r = await runLoad(o);
  printTable(r);
  const line = JSON.stringify(r);
  console.log(line);
  if (o.jsonOut) await Bun.write(o.jsonOut, `${line}\n`);
  process.exit(o.assertTarget && !r.target_met ? 1 : 0);
}
