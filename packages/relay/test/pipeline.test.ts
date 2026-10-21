// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pipelined saves: a connection keeps checking posts while earlier ones commit. */
import { describe, expect, test } from 'bun:test';
import { MemoryEventStore, makeKey } from '@beamhop/testkit';
import { RecentIds } from '../src/engine.ts';
import { eventsOf, setup } from './helpers.ts';

/** A store whose saves each take `ms` to commit (applied in call order). */
function slowStore(ms: number): MemoryEventStore {
  const inner = new MemoryEventStore();
  const store = Object.create(inner) as MemoryEventStore;
  store.save = (relayId, event) =>
    new Promise((r) => setTimeout(r, ms)).then(() => inner.save(relayId, event));
  return store;
}

describe('pipelined saves', () => {
  test('commits overlap; answers keep their order; a later REQ sees every post', async () => {
    const h = await setup({ ports: { events: slowStore(20) } });
    const c = await h.connect();
    c.take();
    const k = makeKey();
    const evs = Array.from({ length: 6 }, () => h.event(k));
    const tampered = { ...evs[2]!, content: 'tampered' };
    const sent = [evs[0]!, evs[1]!, tampered, evs[3]!, evs[4]!, evs[5]!];
    const t0 = performance.now();
    const all = sent.map((e) => h.send(c, ['EVENT', e]));
    const req = h.send(c, ['REQ', 's', { authors: [k.pk] }]);
    await Promise.all([...all, req]);
    const elapsed = performance.now() - t0;
    const frames = c.take();
    const oks = frames.filter((f) => f[0] === 'OK');
    expect(oks.map((f) => f[1])).toEqual(sent.map((e) => e.id));
    expect(oks.map((f) => f[2])).toEqual([true, true, false, true, true, true]);
    expect(oks[2]![3]).toBe('invalid: event id does not match its content');
    // The REQ is answered after every OK, with all five posts.
    const firstReq = frames.findIndex((f) => f[0] === 'EVENT' || f[0] === 'EOSE');
    expect(firstReq).toBeGreaterThan(frames.indexOf(oks[5]!));
    expect(eventsOf(frames, 's')).toHaveLength(5);
    // One at a time would take 5 × 20 ms.
    expect(elapsed).toBeLessThan(80);
  });

  test('pipelineSaves 0 handles one post at a time', async () => {
    const h = await setup({ ports: { events: slowStore(10) }, relayModule: { pipelineSaves: 0 } });
    const c = await h.connect();
    c.take();
    const k = makeKey();
    const evs = Array.from({ length: 4 }, () => h.event(k));
    const t0 = performance.now();
    await Promise.all(evs.map((e) => h.send(c, ['EVENT', e])));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(38);
    expect(
      c
        .take()
        .filter((f) => f[0] === 'OK')
        .map((f) => f[1]),
    ).toEqual(evs.map((e) => e.id));
  });

  test('a deletion waits for the earlier posts of its connection', async () => {
    const h = await setup({ ports: { events: slowStore(10) } });
    const c = await h.connect();
    c.take();
    const k = makeKey();
    const ev = h.event(k);
    const del = h.event(k, { kind: 5, tags: [['e', ev.id]] });
    await Promise.all([h.send(c, ['EVENT', ev]), h.send(c, ['EVENT', del])]);
    expect(
      c
        .take()
        .filter((f) => f[0] === 'OK')
        .map((f) => [f[1], f[2]]),
    ).toEqual([
      [ev.id, true],
      [del.id, true],
    ]);
    expect(await h.ports.events.getById('main', ev.id)).toBeNull();
  });

  test('a connection never has more than pipelineSaves posts committing', async () => {
    let inFlight = 0;
    let max = 0;
    const inner = new MemoryEventStore();
    const store = Object.create(inner) as MemoryEventStore;
    store.save = async (relayId, event) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return inner.save(relayId, event);
    };
    const h = await setup({ ports: { events: store }, relayModule: { pipelineSaves: 3 } });
    const c = await h.connect();
    const k = makeKey();
    await Promise.all(Array.from({ length: 12 }, () => h.send(c, ['EVENT', h.event(k)])));
    expect(max).toBeLessThanOrEqual(3);
    expect(max).toBeGreaterThan(1);
    expect(c.of('OK')).toHaveLength(12);
  });
});

describe('RecentIds', () => {
  test('keeps the most recent ids, evicting the oldest in O(1)', () => {
    const r = new RecentIds(3);
    for (const id of ['a', 'b', 'c', 'd']) r.add(id);
    expect(['a', 'b', 'c', 'd'].map((id) => r.has(id))).toEqual([false, true, true, true]);
    r.add('d');
    r.add('e');
    expect(r.has('b')).toBe(false);
    expect(r.has('e')).toBe(true);
    r.delete('e');
    expect(r.has('e')).toBe(false);
    const big = new RecentIds(10_000);
    const t0 = performance.now();
    for (let i = 0; i < 300_000; i++) big.add(`id-${i}`);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(big.has('id-299999')).toBe(true);
    expect(big.has('id-289999')).toBe(false);
  });
});
