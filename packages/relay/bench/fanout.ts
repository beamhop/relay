// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fan-out benchmark (not part of CI): `bun run packages/relay/bench/fanout.ts`.
 *
 * 1. broadcast: events/sec through the inverted index + frame delivery with
 *    10k live subscriptions (no signature verification).
 * 2. ingest: end-to-end EVENT handling (dedupe, verify, policy, store, fan-out).
 * 3. naive: brute-force matching over all subscriptions for comparison.
 */
import {
  type Connection,
  type Filter,
  type NostrEvent,
  createKernel,
  finalizeEvent,
  matchFilter,
  parseConfig,
} from '@beamhop/core';
import { makeKey, memoryPorts } from '@beamhop/testkit';
import { RELAY_ENGINE_SERVICE, type RelayEngine, relayModule } from '../src/index.ts';

const SUBS = Number(process.env.SUBS ?? 10_000);
const CONNS = Math.max(1, Math.floor(SUBS / 10));
const EVENTS = Number(process.env.EVENTS ?? 50_000);
const AUTHORS = 5_000;

let seed = 7;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const hex = (n: number) => n.toString(16).padStart(64, '0');
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]!;

const authors = Array.from({ length: AUTHORS }, (_, i) => hex(i + 1));
const kinds = [0, 1, 3, 6, 7, 1111, 30023];

function randomFilter(): Filter {
  const r = rand();
  if (r < 0.5)
    return { authors: Array.from({ length: 1 + Math.floor(rand() * 20) }, () => pick(authors)) };
  if (r < 0.8) return { kinds: [pick(kinds)], '#p': [pick(authors)] };
  if (r < 0.95) return { '#e': [hex(1_000_000 + Math.floor(rand() * 10_000))] };
  return { kinds: [pick(kinds)] };
}

function randomEvent(i: number): NostrEvent {
  return {
    id: hex(10_000_000 + i),
    pubkey: pick(authors),
    kind: pick(kinds),
    created_at: 1_700_000_000 + i,
    content: 'bench',
    sig: '0'.repeat(128),
    tags: [
      ['p', pick(authors)],
      ['e', hex(1_000_000 + Math.floor(rand() * 10_000))],
    ],
  };
}

class SinkConn implements Connection {
  readonly ipHash = 'bench';
  readonly openedAt = 0;
  readonly authed = new Set<string>();
  readonly state = new Map<string, unknown>();
  challenge = '';
  frames = 0;
  bytes = 0;
  constructor(
    readonly id: string,
    readonly relayId: string,
  ) {}
  send(frame: string): void {
    this.frames++;
    this.bytes += frame.length;
  }
  bufferedAmount(): number {
    return 0;
  }
  close(): void {}
}

async function main() {
  const ports = memoryPorts();
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config: parseConfig({ relays: [{ id: 'main', hosts: ['bench.test'] }] }),
    modules: [relayModule],
  });
  const engine = kernel.use<RelayEngine>(RELAY_ENGINE_SERVICE)!;
  const conns: SinkConn[] = [];
  const allFilters: Filter[][] = [];
  for (let i = 0; i < CONNS; i++) {
    const c = new SinkConn(`c${i}`, 'main');
    await engine.open(c);
    conns.push(c);
  }
  for (let s = 0; s < SUBS; s++) {
    const c = conns[s % CONNS]!;
    const filters = [randomFilter()];
    allFilters.push(filters);
    await engine.handle(c, JSON.stringify(['REQ', `s${s}`, ...filters]));
  }
  console.log(`subscriptions: ${engine.subscriptionCount('main')} over ${CONNS} connections`);

  // 1. Broadcast through the index.
  const events = Array.from({ length: EVENTS }, (_, i) => randomEvent(i));
  for (const c of conns) c.frames = 0;
  let t0 = performance.now();
  for (const e of events) engine.broadcast('main', e);
  let dt = (performance.now() - t0) / 1000;
  const delivered = conns.reduce((n, c) => n + c.frames, 0);
  console.log(
    `broadcast: ${Math.round(EVENTS / dt).toLocaleString()} events/s, ` +
      `${Math.round(delivered / dt).toLocaleString()} frames/s (${delivered.toLocaleString()} deliveries)`,
  );

  // 3. Naive brute force for comparison (subset of events).
  const naiveN = Math.min(EVENTS, 2_000);
  t0 = performance.now();
  let naiveHits = 0;
  for (let i = 0; i < naiveN; i++) {
    const e = events[i]!;
    for (const fs of allFilters) if (fs.some((f) => matchFilter(f, e))) naiveHits++;
  }
  dt = (performance.now() - t0) / 1000;
  console.log(
    `naive matching: ${Math.round(naiveN / dt).toLocaleString()} events/s (${naiveHits} hits)`,
  );

  // 2. End-to-end ingest with signature verification.
  const INGEST = Number(process.env.INGEST ?? 2_000);
  const keys = Array.from({ length: 50 }, () => makeKey());
  const now = ports.clock.now();
  const signed = Array.from({ length: INGEST }, (_, i) =>
    finalizeEvent(
      { kind: 1, tags: [['p', pick(authors)]], content: `ingest ${i}`, created_at: now - i },
      keys[i % keys.length]!.sk,
    ),
  );
  const writer = new SinkConn('writer', 'main');
  await engine.open(writer);
  t0 = performance.now();
  for (const e of signed) await engine.handle(writer, JSON.stringify(['EVENT', e]));
  dt = (performance.now() - t0) / 1000;
  const oks = writer.frames;
  if (oks < INGEST) throw new Error(`only ${oks}/${INGEST} events acknowledged`);
  console.log(
    `ingest (verify+store+fan-out): ${Math.round(INGEST / dt).toLocaleString()} events/s`,
  );
}

await main();
