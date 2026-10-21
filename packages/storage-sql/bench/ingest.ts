// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * bun:sqlite ingest + query throughput (not run in CI).
 *
 *   bun packages/storage-sql/bench/ingest.ts [events=100000] [dbPath]
 *
 * Events are well-formed but unsigned (the store does not verify signatures),
 * so this measures storage only. Concurrency mimics many connections saving at
 * once (group commit batches them into one transaction per tick).
 */
import type { NostrEvent } from '@beamhop/core';
import { createSqlStores } from '../src/index.ts';
import { fakeEvent, randHex } from '../test/fake.ts';

const N = Number(process.argv[2] ?? 100_000);
const path =
  process.argv[3] ?? `${process.env.TMPDIR ?? '/tmp'}/beamhop-bench-${randHex(4)}.sqlite`;
const R = 'bench';

const authors = Array.from({ length: 2000 }, () => randHex(32));
const hashtags = ['nostr', 'bitcoin', 'bun', 'sqlite', 'relay', 'beamhop', 'news', 'art'];
const words = 'the quick brown fox jumps over lazy dog nostr relay event search full text'.split(
  ' ',
);
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;

const ids: string[] = [];
function gen(i: number): NostrEvent {
  const r = Math.random();
  const kind = r < 0.7 ? 1 : r < 0.85 ? 7 : r < 0.9 ? 0 : r < 0.95 ? 3 : 30023;
  const tags: string[][] = [];
  if (ids.length && Math.random() < 0.5) tags.push(['e', pick(ids)]);
  tags.push(['p', pick(authors)]);
  if (Math.random() < 0.3) tags.push(['t', pick(hashtags)]);
  if (kind === 3) for (let j = 0; j < 100; j++) tags.push(['p', pick(authors)]);
  if (kind === 30023) tags.push(['d', `post-${i % 50}`]);
  const content = Array.from({ length: 12 }, () => pick(words)).join(' ');
  const e = fakeEvent({
    pubkey: pick(authors),
    kind,
    tags,
    content,
    created_at: 1_700_000_000 + i,
  });
  ids.push(e.id);
  return e;
}

const stores = await createSqlStores({ driver: 'sqlite', path });
await stores.events.init();
const events = Array.from({ length: N }, (_, i) => gen(i));

const CONCURRENCY = 256;
let t0 = performance.now();
for (let i = 0; i < N; i += CONCURRENCY) {
  await Promise.all(events.slice(i, i + CONCURRENCY).map((e) => stores.events.save(R, e)));
}
let dt = (performance.now() - t0) / 1000;
console.log(`ingest: ${N} events in ${dt.toFixed(2)}s = ${Math.round(N / dt)} events/s (${path})`);

t0 = performance.now();
const seq = Math.min(N, 5000);
for (let i = 0; i < seq; i++) await stores.events.save(R, gen(N + i));
dt = (performance.now() - t0) / 1000;
console.log(`ingest (sequential awaits): ${Math.round(seq / dt)} events/s`);

const queries: Array<[string, () => Promise<unknown>]> = [
  ['recent global (limit 100)', () => stores.events.query(R, [{ limit: 100 }])],
  ['kind 1 (limit 100)', () => stores.events.query(R, [{ kinds: [1], limit: 100 }])],
  [
    'author feed 50 authors',
    () => stores.events.query(R, [{ authors: authors.slice(0, 50), kinds: [1], limit: 200 }]),
  ],
  [
    'profile + contacts',
    () => stores.events.query(R, [{ authors: [pick(authors)], kinds: [0, 3, 10002] }]),
  ],
  ['#e thread', () => stores.events.query(R, [{ '#e': [pick(ids)], limit: 500 }])],
  ['#p mentions (limit 50)', () => stores.events.query(R, [{ '#p': [pick(authors)], limit: 50 }])],
  ['#t hashtag (limit 100)', () => stores.events.query(R, [{ '#t': ['nostr'], limit: 100 }])],
  ['search (limit 50)', () => stores.events.query(R, [{ search: 'quick fox', limit: 50 }])],
  ['getById', () => stores.events.getById(R, pick(ids))],
  ['count kind 7', () => stores.events.count(R, [{ kinds: [7] }])],
];
for (const [name, q] of queries) {
  const iters = 500;
  await q();
  t0 = performance.now();
  for (let i = 0; i < iters; i++) await q();
  const ms = (performance.now() - t0) / iters;
  console.log(`query ${name.padEnd(28)} ${ms.toFixed(3)} ms  (${Math.round(1000 / ms)} q/s)`);
}

console.log('stats', await stores.events.stats(R));
await stores.close();
