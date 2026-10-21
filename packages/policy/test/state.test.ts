// SPDX-License-Identifier: AGPL-3.0-or-later
// First-seen / last-activity writes are batched in memory and flushed together.
import { describe, expect, test } from 'bun:test';
import type { DocStore } from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { DuplicateWindow } from '../src/hooks.ts';
import { COLLECTIONS, PolicyState } from '../src/state.ts';

/** Count writes reaching the DocStore. */
function counted(docs: DocStore) {
  const writes: string[] = [];
  let fail = false;
  const wrapped: DocStore = {
    init: () => docs.init(),
    get: (c, k) => docs.get(c, k),
    list: (c, o) => docs.list(c, o),
    delete: (c, k) => docs.delete(c, k),
    async put(c, k, v) {
      if (fail) throw new Error('disk full');
      writes.push(`put ${c} ${k}`);
      return docs.put(c, k, v);
    },
    async cas(c, k, e, n) {
      if (fail) throw new Error('disk full');
      writes.push(`cas ${c} ${k}`);
      return docs.cas(c, k, e, n);
    },
  };
  return {
    wrapped,
    writes,
    setFail(v: boolean) {
      fail = v;
    },
  };
}

function setup(opts: { flushMs?: number; flushSize?: number } = {}) {
  const ports = memoryPorts();
  const c = counted(ports.docs);
  const errors: unknown[] = [];
  const state = new PolicyState(
    { ...ports, docs: c.wrapped },
    { flushMs: 60_000, ...opts, onError: (e) => errors.push(e) },
  );
  return { ports, state, ...c, errors };
}

describe('duplicate window', () => {
  test('stays bounded and cheap when it is full of live entries', () => {
    const w = new DuplicateWindow();
    const t0 = performance.now();
    for (let i = 0; i < 120_000; i++) w.record(`post number ${i}`, 1000, 600, 0);
    // A full scan per post (the old behaviour) took seconds here.
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(w.check('post number 119999', 1000, 0)).toBe('exact');
    expect(w.check('post number 0', 1000, 0)).toBeUndefined(); // forgotten (oldest)
    expect(w.check('post number 119999', 1700, 0)).toBeUndefined(); // expired
  });
});

describe('policy state write batching', () => {
  test('writes wait in memory, reads see them, flush writes them once', async () => {
    const { ports, state, writes } = setup();
    await state.markSeen('main', 'a', 100);
    await state.markSeen('main', 'a', 200);
    await state.markActive('main', 'a', 100);
    await state.markActive('main', 'b', 100);
    expect(writes).toEqual([]);
    expect(state.pendingWrites).toBe(3);
    expect(await state.firstSeen('main', 'a')).toBe(100);

    await state.flush();
    expect(writes.sort()).toEqual([
      'cas policy.seen main:a',
      'put policy.active main:a',
      'put policy.active main:b',
    ]);
    expect(state.pendingWrites).toBe(0);
    expect(await ports.docs.get(COLLECTIONS.seen, 'main:a')).toBe(100);
    expect(await ports.docs.get(COLLECTIONS.active, 'main:b')).toEqual({
      pubkey: 'b',
      lastSeen: 100,
    });
  });

  test('lists flush first', async () => {
    const { state } = setup();
    await state.markSeen('main', 'a', 100);
    await state.markActive('main', 'a', 100);
    expect(await state.listSeen('main')).toEqual([{ pubkey: 'a', at: 100 }]);
    expect(await state.listActive('main')).toEqual([{ pubkey: 'a', lastSeen: 100 }]);
  });

  test('flushes on its own when enough writes are waiting, or after the interval', async () => {
    const big = setup({ flushSize: 4 });
    for (const pk of ['a', 'b', 'c', 'd']) await big.state.markSeen('main', pk, 1);
    await Bun.sleep(0);
    await big.state.flush();
    expect(big.writes).toHaveLength(4);

    const timed = setup({ flushMs: 5 });
    await timed.state.markActive('main', 'a', 1);
    expect(timed.writes).toHaveLength(0);
    await Bun.sleep(30);
    expect(timed.writes).toEqual(['put policy.active main:a']);
  });

  test('an earlier first-seen time recorded elsewhere wins', async () => {
    const { ports, state } = setup();
    // Recorded by another node after this one looked.
    const seen = state.markSeen('main', 'a', 500);
    await ports.docs.put(COLLECTIONS.seen, 'main:a', 50);
    await seen;
    await state.flush();
    expect(await ports.docs.get(COLLECTIONS.seen, 'main:a')).toBe(50);
    expect(await state.firstSeen('main', 'a')).toBe(50);
  });

  test('failed writes are kept and retried on the next flush', async () => {
    const { ports, state, setFail } = setup();
    await state.markSeen('main', 'a', 100);
    await state.markActive('main', 'a', 100);
    setFail(true);
    await expect(state.flush()).rejects.toThrow('disk full');
    expect(state.pendingWrites).toBe(2);
    expect(await state.firstSeen('main', 'a')).toBe(100);
    setFail(false);
    await state.flush();
    expect(state.pendingWrites).toBe(0);
    expect(await ports.docs.get(COLLECTIONS.seen, 'main:a')).toBe(100);
  });
});
