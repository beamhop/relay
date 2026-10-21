// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { WorkQueue } from '../src/queue.ts';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('WorkQueue', () => {
  test('respects the concurrency limit and push never blocks', async () => {
    const q = new WorkQueue({ concurrency: 2, maxQueued: 10 });
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, deferred);
    for (const g of gates) {
      const r = q.push(async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      });
      expect(r.accepted).toBe(true);
    }
    // Nothing has started synchronously.
    expect(running).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(q.stats().running).toBe(2);
    expect(q.depth).toBe(3);
    for (const g of gates) g.resolve();
    await q.onIdle();
    expect(peak).toBe(2);
    expect(q.stats().done).toBe(5);
  });

  test('drops normal jobs when full, never high-priority ones', async () => {
    const q = new WorkQueue({ concurrency: 1, maxQueued: 2 });
    const g = deferred();
    q.push(() => g.promise);
    await Promise.resolve();
    expect(q.push(async () => {}).accepted).toBe(true);
    expect(q.push(async () => {}).accepted).toBe(true);
    expect(q.push(async () => {}).accepted).toBe(false);
    expect(q.stats().dropped).toBe(1);
    const order: string[] = [];
    expect(q.push(async () => void order.push('high'), { priority: 'high' }).accepted).toBe(true);
    q.push(async () => void order.push('late'));
    g.resolve();
    await q.onIdle();
    // High priority jumped ahead of queued normal jobs.
    expect(order[0]).toBe('high');
  });

  test('coalesces jobs by key and counts failures', async () => {
    const errors: unknown[] = [];
    const q = new WorkQueue({ concurrency: 1, onError: (e) => errors.push(e) });
    let n = 0;
    const a = q.push(async () => void n++, { key: 'k' });
    const b = q.push(async () => void n++, { key: 'k' });
    expect(b.done).toBe(a.done);
    expect(q.has('k')).toBe(true);
    q.push(async () => {
      throw new Error('boom');
    });
    await q.onIdle();
    expect(n).toBe(1);
    expect(q.has('k')).toBe(false);
    expect(q.stats().failed).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test('close stops accepting work', async () => {
    const q = new WorkQueue();
    q.close();
    expect(q.push(async () => {}, { priority: 'high' }).accepted).toBe(false);
  });
});
