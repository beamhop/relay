// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import type { NostrEvent } from '@beamhop/core';
import { makeEvent, makeKey } from '@beamhop/testkit';
import { VerifyPool, VerifyUnavailableError } from '../src/verify-pool.ts';

const FAKE = new URL('./fixtures/fake-verify-worker.ts', import.meta.url).href;
type SigInput = Pick<NostrEvent, 'id' | 'pubkey' | 'sig'>;
const fake = (id: string, valid = true): SigInput => ({
  id,
  pubkey: 'p',
  sig: valid ? 'ok' : 'no',
});

const pools: VerifyPool[] = [];
const pool = (opts: ConstructorParameters<typeof VerifyPool>[0]) => {
  const p = new VerifyPool(opts);
  pools.push(p);
  return p;
};
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close(100);
});

function flip(e: NostrEvent): NostrEvent {
  return { ...e, sig: e.sig.replace(/^./, e.sig[0] === 'a' ? 'b' : 'a') };
}

describe('VerifyPool (real worker)', () => {
  test('mixed valid/invalid events come back in order', async () => {
    const p = pool({ workers: 2 });
    const k = makeKey();
    const events = Array.from({ length: 200 }, (_, i) => {
      const e = makeEvent(k, { content: `n${i}` });
      return i % 3 === 0 ? flip(e) : e;
    });
    const got = await p.verify(events);
    expect(got).toEqual(events.map((_, i) => i % 3 !== 0));
    // Garbage never throws, it is just invalid.
    expect(await p.verify([{ id: 'zz', pubkey: 'not hex', sig: '' }])).toEqual([false]);
    expect(p.stats().batches).toBeGreaterThanOrEqual(Math.ceil(200 / 64));
  });

  test('concurrent callers each get their own answers', async () => {
    const p = pool({ workers: 3 });
    const k = makeKey();
    const calls = Array.from({ length: 50 }, (_, i) => {
      const e = makeEvent(k, { content: `c${i}` });
      return { e: i % 2 ? flip(e) : e, want: i % 2 === 0 };
    });
    const got = await Promise.all(calls.map((c) => p.verify([c.e])));
    expect(got.map((r) => r[0])).toEqual(calls.map((c) => c.want));
    // Same-tick callers were batched together.
    expect(p.stats().batches).toBeLessThan(50);
  });
});

describe('VerifyPool (fake worker)', () => {
  test('micro-batches: full batches of maxBatch', async () => {
    const p = pool({ workers: 2, workerUrl: FAKE, maxBatch: 64 });
    const events = Array.from({ length: 1000 }, (_, i) => fake(`e${i}`, i % 7 !== 0));
    const got = await p.verify(events);
    expect(got).toEqual(events.map((e) => e.sig === 'ok'));
    expect(p.stats().batches).toBe(Math.ceil(1000 / 64));
    expect(p.stats().verified).toBe(1000);
  });

  test('a crashing worker fails its events (never valid) and is replaced', async () => {
    const p = pool({ workers: 1, workerUrl: FAKE });
    expect(await p.verify([fake('a')])).toEqual([true]);
    await expect(p.verify([fake('throw-1')])).rejects.toBeInstanceOf(VerifyUnavailableError);
    expect(p.stats().respawns).toBe(1);
    expect(await p.verify([fake('b'), fake('c', false)])).toEqual([true, false]);
    await expect(p.verify([fake('exit-1')])).rejects.toBeInstanceOf(VerifyUnavailableError);
    expect(await p.verify([fake('d')])).toEqual([true]);
    expect(p.stats().respawns).toBe(2);
    expect(p.stats().failed).toBe(2);
  });

  test('a worker that stops answering is treated as crashed', async () => {
    const p = pool({ workers: 1, workerUrl: FAKE, batchTimeoutMs: 100 });
    await expect(p.verify([fake('hang-1')])).rejects.toBeInstanceOf(VerifyUnavailableError);
    expect(await p.verify([fake('a')])).toEqual([true]);
  });

  test('threads that keep crashing → checks move to the main thread', async () => {
    let inline = 0;
    const p = pool({
      workers: 1,
      workerUrl: FAKE,
      maxCrashes: 2,
      inline: (e) => {
        inline++;
        return e.sig === 'ok';
      },
    });
    await expect(p.verify([fake('throw-1')])).rejects.toThrow();
    await expect(p.verify([fake('throw-2')])).rejects.toThrow();
    expect(p.stats().broken).toBe(true);
    expect(await p.verify([fake('x'), fake('y', false)])).toEqual([true, false]);
    expect(inline).toBe(2);
  });

  test('a full queue falls back to inline checks', async () => {
    let inline = 0;
    const p = pool({
      workers: 1,
      workerUrl: FAKE,
      maxQueue: 4,
      maxInFlight: 1,
      inline: (e) => {
        inline++;
        return e.sig === 'ok';
      },
    });
    const busy = p.verify([fake('slow-0')]);
    await Bun.sleep(5); // the slow batch is now with the worker
    const queued = p.verify([fake('q1'), fake('q2'), fake('q3'), fake('q4', false)]);
    expect(p.stats().queued).toBe(4);
    // Over the bound: answered right here, on the main thread.
    expect(await p.verify([fake('over', false)])).toEqual([false]);
    expect(inline).toBe(1);
    expect(await busy).toEqual([true]);
    expect(await queued).toEqual([true, true, true, false]);
    expect(p.stats().inline).toBe(1);
  });

  test('close(): finishes in-flight work, checks the queue, then runs inline', async () => {
    let inline = 0;
    const p = pool({
      workers: 1,
      workerUrl: FAKE,
      maxInFlight: 1,
      inline: (e) => {
        inline++;
        return e.sig === 'ok';
      },
    });
    const busy = p.verify([fake('slow-0')]);
    await Bun.sleep(5);
    const queued = p.verify([fake('q1', false)]);
    await p.close(1000);
    expect(await busy).toEqual([true]);
    expect(await queued).toEqual([false]);
    expect(inline).toBe(1);
    expect(p.stats().live).toBe(0);
    expect(await p.verify([fake('after')])).toEqual([true]);
    expect(inline).toBe(2);
  });

  test('close() does not wait forever for a stuck worker', async () => {
    const p = pool({ workers: 1, workerUrl: FAKE });
    const stuck = p.verify([fake('hang-1')]);
    await Bun.sleep(5);
    await p.close(50);
    await expect(stuck).rejects.toBeInstanceOf(VerifyUnavailableError);
  });
});
