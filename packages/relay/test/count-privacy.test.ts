// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeKey } from '@beamhop/testkit';
import { type FakeConn, type Harness, setup } from './helpers.ts';

async function count(h: Harness, c: FakeConn, ...filters: unknown[]) {
  c.take();
  await h.send(c, ['COUNT', 'n', ...filters]);
  const f = c.take().find((x) => x[0] === 'COUNT' || x[0] === 'CLOSED');
  if (!f) throw new Error('no answer');
  return f[0] === 'COUNT'
    ? (f[2] as { count: number; approximate?: boolean })
    : { closed: String(f[2]) };
}

describe('NIP-45 COUNT never reveals private data', () => {
  test('gift wraps are only counted for their AUTHed recipient', async () => {
    const h = await setup();
    const bob = makeKey();
    const eve = makeKey();
    const pub = await h.connect();
    for (let i = 0; i < 3; i++)
      await h.publish(pub, h.event(makeKey(), { kind: 1059, tags: [['p', bob.pk]] }));
    await h.publish(pub, h.event(makeKey(), { kind: 1, tags: [['p', bob.pk]] }));

    const anon = await h.connect();
    // No kinds: only the public note may be counted.
    expect(await count(h, anon, { '#p': [bob.pk] })).toEqual({ count: 1 });
    expect(await count(h, anon, {})).toEqual({ count: 1 });
    // Explicit wrap kinds without signing in: refused like REQ.
    expect(await count(h, anon, { kinds: [1059], '#p': [bob.pk] })).toMatchObject({
      closed: expect.stringMatching(/^auth-required: /),
    });

    const stranger = await h.connect();
    await h.auth(stranger, eve);
    expect(await count(h, stranger, { '#p': [bob.pk] })).toEqual({ count: 1 });
    expect(await count(h, stranger, { kinds: [1059], '#p': [bob.pk] })).toMatchObject({
      closed: expect.stringMatching(/^restricted: /),
    });
    expect(await count(h, stranger, { kinds: [1059] })).toEqual({ count: 0 });

    const me = await h.connect();
    await h.auth(me, bob);
    expect(await count(h, me, { '#p': [bob.pk] })).toEqual({ count: 4 });
    expect(await count(h, me, { kinds: [1059] })).toEqual({ count: 3 });
  });

  test('posts in private groups are only counted for members', async () => {
    const h = await setup();
    const alice = makeKey();
    const bob = makeKey();
    const ca = await h.connect();
    await h.auth(ca, alice);
    const created = await h.publish(
      ca,
      h.event(alice, { kind: 9007, tags: [['h', 'secret'], ['private']] }),
    );
    expect(created[2]).toBe(true);
    for (let i = 0; i < 2; i++) {
      const ok = await h.publish(ca, h.event(alice, { kind: 9, tags: [['h', 'secret']] }));
      expect(ok[2]).toBe(true);
    }
    await h.publish(ca, h.event(alice, { kind: 1 }));

    const anon = await h.connect();
    // Only the public note (the 9007 create event is itself h-tagged, so private).
    expect(await count(h, anon, { authors: [alice.pk] })).toEqual({ count: 1 });
    expect(await count(h, anon, { kinds: [9] })).toEqual({ count: 0 });
    expect(await count(h, anon, { '#h': ['secret'] })).toMatchObject({
      closed: expect.stringMatching(/^auth-required: /),
    });

    const cb = await h.connect();
    await h.auth(cb, bob);
    expect(await count(h, cb, { authors: [alice.pk], kinds: [9] })).toEqual({ count: 0 });

    expect(await count(h, ca, { authors: [alice.pk], kinds: [9] })).toEqual({ count: 2 });
  });

  test('scan is bounded and marked approximate at the cap', async () => {
    const h = await setup({ relayModule: { countScanLimit: 2 } });
    const pub = await h.connect();
    for (let i = 0; i < 3; i++) await h.publish(pub, h.event(makeKey()));
    expect(await count(h, pub, {})).toEqual({ count: 2, approximate: true });
    // Filters that cannot match restricted events use the store's exact count.
    expect(await count(h, pub, { kinds: [1] })).toEqual({ count: 3 });
  });
});
