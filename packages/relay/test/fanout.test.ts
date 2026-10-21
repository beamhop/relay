// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type Filter, type NostrEvent, matchFilter } from '@beamhop/core';
import { MemoryEventStore, MemoryPubSub, makeKey } from '@beamhop/testkit';
import { type IndexedSub, SubscriptionIndex, fanoutChannel } from '../src/index.ts';
import { eventsOf, setup } from './helpers.ts';

describe('cross-node fan-out via PubSub', () => {
  test('events reach subscribers on another node exactly once', async () => {
    const pubsub = new MemoryPubSub();
    const events = new MemoryEventStore();
    const a = await setup({ ports: { pubsub, events } });
    const b = await setup({ ports: { pubsub, events } });
    expect(a.engine.nodeId).not.toBe(b.engine.nodeId);
    const writer = await a.connect();
    const reader = await b.connect();
    const localReader = await a.connect();
    await b.req(reader, 'r', { kinds: [1] });
    await a.req(localReader, 'l', { kinds: [1] });
    const ev = a.event(makeKey());
    await a.publish(writer, ev);
    expect(eventsOf(reader.take())).toEqual([ev]);
    expect(eventsOf(localReader.take())).toEqual([ev]);
    // Re-delivery of the same message (at-least-once pubsub) is deduplicated.
    await pubsub.publish(fanoutChannel('main'), { o: a.engine.nodeId, e: ev });
    await pubsub.publish(fanoutChannel('main'), { o: 'some-other-node', e: ev });
    expect(reader.take()).toEqual([]);
    expect(localReader.take()).toEqual([]);
  });

  test('malformed pubsub messages are ignored', async () => {
    const pubsub = new MemoryPubSub();
    const h = await setup({ ports: { pubsub } });
    const c = await h.connect();
    await h.req(c, 's', {});
    await pubsub.publish(fanoutChannel('main'), null);
    await pubsub.publish(fanoutChannel('main'), { o: 'x', e: { id: 'nope' } });
    expect(c.take()).toEqual([]);
  });

  test('relays are isolated', async () => {
    const h = await setup();
    await h.kernel.applyConfig({
      ...h.kernel.config(),
      relays: [
        ...h.kernel.config().relays,
        { ...h.kernel.config().relays[0]!, id: 'second', hosts: ['two.test'] },
      ],
    });
    const c1 = await h.connect('main');
    const c2 = await h.connect('second');
    await h.req(c2, 's', {});
    await h.publish(c1, h.event(makeKey()));
    expect(c2.take()).toEqual([]);
    expect(eventsOf(await h.req(c2, 't', {}))).toEqual([]);
  });
});

// ───────────────────────── index property test ─────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const hex = (n: number) => n.toString(16).padStart(64, '0');

describe('SubscriptionIndex', () => {
  test('matches exactly the brute-force set (randomized)', () => {
    const rand = rng(42);
    const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)]!;
    const ids = Array.from({ length: 8 }, (_, i) => hex(i + 1));
    const authors = Array.from({ length: 6 }, (_, i) => hex(100 + i));
    const kinds = [0, 1, 3, 7, 30023];
    const tagVals = ['a', 'b', 'c', 'd'];
    const sample = <T>(arr: T[], max: number) => {
      const n = Math.floor(rand() * (max + 1));
      return Array.from({ length: n }, () => pick(arr));
    };
    const randomFilter = (): Filter => {
      const f: Filter = {};
      if (rand() < 0.2) f.ids = sample(ids, 3);
      if (rand() < 0.4) f.authors = sample(authors, 3);
      if (rand() < 0.5) f.kinds = sample(kinds, 3);
      if (rand() < 0.3) f['#e'] = sample(tagVals, 2);
      if (rand() < 0.3) f['#p'] = sample(tagVals, 2);
      if (rand() < 0.2) f.since = 50 + Math.floor(rand() * 50);
      if (rand() < 0.2) f.until = 100 + Math.floor(rand() * 50);
      return f;
    };
    const randomEvent = (): NostrEvent => ({
      id: pick(ids),
      pubkey: pick(authors),
      kind: pick(kinds),
      created_at: 50 + Math.floor(rand() * 100),
      content: '',
      sig: '0'.repeat(128),
      tags: [
        ...sample(tagVals, 2).map((v) => ['e', v]),
        ...sample(tagVals, 2).map((v) => ['p', v]),
        ...(rand() < 0.3 ? [['t', 'x']] : []),
      ],
    });

    const index = new SubscriptionIndex<IndexedSub>();
    const subs = new Map<string, IndexedSub>();
    let next = 0;
    for (let round = 0; round < 3000; round++) {
      const r = rand();
      if (r < 0.45 || subs.size === 0) {
        const key = rand() < 0.1 && subs.size > 0 ? pick([...subs.keys()]) : `s${next++}`;
        const nFilters = 1 + Math.floor(rand() * 3);
        const sub = { key, filters: Array.from({ length: nFilters }, randomFilter) };
        subs.set(key, sub);
        index.add(sub);
      } else if (r < 0.6) {
        const key = pick([...subs.keys()]);
        subs.delete(key);
        expect(index.remove(key)).toBe(true);
      } else {
        const ev = randomEvent();
        const expected = [...subs.values()]
          .filter((s) => s.filters.some((f) => matchFilter(f, ev)))
          .map((s) => s.key)
          .sort();
        const got = index
          .match(ev)
          .map((s) => s.key)
          .sort();
        expect(got).toEqual(expected);
      }
      expect(index.size).toBe(subs.size);
    }
  });

  test('empty-array filters never match and are not indexed', () => {
    const index = new SubscriptionIndex();
    index.add({ key: 'a', filters: [{ authors: [] }, { kinds: [1], '#e': [] }] });
    const ev: NostrEvent = {
      id: hex(1),
      pubkey: hex(2),
      kind: 1,
      created_at: 1,
      content: '',
      sig: '',
      tags: [['e', 'x']],
    };
    expect(index.match(ev)).toEqual([]);
    expect(index.remove('a')).toBe(true);
    expect(index.remove('a')).toBe(false);
  });

  test('a subscription is returned once even if several filters match', () => {
    const index = new SubscriptionIndex();
    index.add({ key: 'a', filters: [{ kinds: [1] }, { authors: [hex(2)] }, {}] });
    const ev: NostrEvent = {
      id: hex(1),
      pubkey: hex(2),
      kind: 1,
      created_at: 1,
      content: '',
      sig: '',
      tags: [],
    };
    expect(index.match(ev).map((s) => s.key)).toEqual(['a']);
  });
});
