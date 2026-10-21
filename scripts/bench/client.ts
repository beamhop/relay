// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Subscriber shard for `load.ts`: holds a slice of the reader connections in its own
 * process (so one client event loop does not limit the test), opens them, sends each
 * connection's REQs, waits for EOSE, then counts live EVENT deliveries and keeps a
 * sample of (event index, receive time) pairs for latency.
 *
 * Driven over IPC by `load.ts`: `init` → `ready`, `stats` → `stats`.
 */
import { lagMeter, nowAbs } from './lib.ts';

interface Init {
  type: 'init';
  url: string;
  conns: Array<Array<[string, Record<string, unknown>]>>;
  connectConcurrency: number;
  maxSamples: number;
}

let deliveries = 0;
let notices = 0;
let closedSubs = 0;
let disconnects = 0;
let eoseCount = 0;
let seen = 0;
const sampleIdx: number[] = [];
const sampleAt: number[] = [];
let maxSamples = 100_000;
let collecting = false;
const lag = lagMeter(10);
const sockets: WebSocket[] = [];
const INDEX = /"content":"[^"]*#(\d+)"/;

function onFrame(s: string) {
  if (s.startsWith('["EVENT"')) {
    if (!collecting) return;
    deliveries++;
    const at = nowAbs();
    const m = INDEX.exec(s);
    if (!m) return;
    const i = Number(m[1]);
    // Reservoir sample so memory stays bounded at any delivery rate.
    seen++;
    if (sampleIdx.length < maxSamples) {
      sampleIdx.push(i);
      sampleAt.push(at);
    } else {
      const j = Math.floor(Math.random() * seen);
      if (j < maxSamples) {
        sampleIdx[j] = i;
        sampleAt[j] = at;
      }
    }
  } else if (s.startsWith('["EOSE"')) eoseCount++;
  else if (s.startsWith('["NOTICE"')) notices++;
  else if (s.startsWith('["CLOSED"')) closedSubs++;
}

let retries = 0;
const failReasons: Record<string, number> = {};

/**
 * Open one reader like a real app would: retry a failed connect (up to 3 times, with
 * back-off). On macOS the default listen backlog (kern.ipc.somaxconn = 128) resets some
 * connects during a burst; those retries are reported, final failures count as errors.
 */
async function open(url: string, reqs: Init['conns'][number]): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      retries++;
      await Bun.sleep(100 * attempt + Math.random() * 200);
    }
    const r = await openOnce(url, reqs);
    if (r === true) return true;
    if (attempt === 3) failReasons[r] = (failReasons[r] ?? 0) + 1;
  }
  return false;
}

function openOnce(url: string, reqs: Init['conns'][number]): Promise<true | string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let opened = false;
    const t = setTimeout(() => {
      ws.close();
      resolve('timeout');
    }, 30_000);
    ws.onopen = () => {
      opened = true;
      clearTimeout(t);
      for (const [id, filter] of reqs) ws.send(JSON.stringify(['REQ', id, filter]));
      sockets.push(ws);
      resolve(true);
    };
    ws.onmessage = (e) => onFrame(typeof e.data === 'string' ? e.data : String(e.data));
    ws.onerror = () => {
      if (!opened) {
        clearTimeout(t);
        resolve('error');
      }
    };
    ws.onclose = (e) => {
      if (opened) disconnects++;
      else {
        clearTimeout(t);
        resolve(`close ${e.code}`);
      }
    };
  });
}

process.on('message', async (msg: Init | { type: 'stats' } | { type: 'start' }) => {
  if (msg.type === 'init') {
    maxSamples = msg.maxSamples;
    const t0 = performance.now();
    let opened = 0;
    let failed = 0;
    let totalReqs = 0;
    const failedIdx: number[] = [];
    for (let i = 0; i < msg.conns.length; i += msg.connectConcurrency) {
      const batch = msg.conns.slice(i, i + msg.connectConcurrency);
      const ok = await Promise.all(batch.map((reqs) => open(msg.url, reqs)));
      for (let k = 0; k < ok.length; k++) {
        if (ok[k]) {
          opened++;
          totalReqs += batch[k]!.length;
        } else {
          failed++;
          failedIdx.push(i + k);
        }
      }
    }
    // Wait for every subscription's EOSE (or CLOSED), at most 60 s.
    const until = performance.now() + 60_000;
    while (eoseCount + closedSubs < totalReqs && performance.now() < until) await Bun.sleep(50);
    process.send?.({
      type: 'ready',
      opened,
      failed,
      failedIdx,
      retries,
      failReasons,
      eose: eoseCount,
      reqs: totalReqs,
      ms: performance.now() - t0,
    });
  } else if (msg.type === 'start') {
    collecting = true;
    lag.reset();
  } else if (msg.type === 'stats') {
    process.send?.({
      type: 'stats',
      deliveries,
      notices,
      closedSubs,
      disconnects,
      sampleIdx,
      sampleAt,
      lag: lag.stats(),
    });
    for (const ws of sockets) ws.close();
    setTimeout(() => process.exit(0), 200);
  }
});
process.send?.({ type: 'hello' });
