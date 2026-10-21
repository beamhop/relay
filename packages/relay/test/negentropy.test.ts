// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { NostrEvent } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { Negentropy, NegentropyStorageVector } from '../src/index.ts';
import { type FakeConn, type Harness, setup } from './helpers.ts';

async function negRound(h: Harness, c: FakeConn, msg: unknown[]): Promise<unknown[]> {
  c.take();
  await h.send(c, msg);
  const frames = c.take();
  expect(frames).toHaveLength(1);
  return frames[0]!;
}

async function sync(h: Harness, c: FakeConn, clientEvents: NostrEvent[], filter: object) {
  const storage = new NegentropyStorageVector();
  for (const e of clientEvents) storage.insert(e.created_at, e.id);
  storage.seal();
  const client = new Negentropy(storage, 0);
  let out: string | null = await client.initiate();
  const have: string[] = [];
  const need: string[] = [];
  let reply = await negRound(h, c, ['NEG-OPEN', 'n', filter, out]);
  let rounds = 0;
  for (;;) {
    expect(reply[0]).toBe('NEG-MSG');
    const [next, h1, n1] = await client.reconcile(reply[2] as string);
    have.push(...h1);
    need.push(...n1);
    out = next;
    if (out === null) break;
    reply = await negRound(h, c, ['NEG-MSG', 'n', out]);
    if (++rounds > 50) throw new Error('did not converge');
  }
  return { have: have.sort(), need: need.sort(), rounds };
}

describe('NIP-77 negentropy', () => {
  test('reconciles client and relay sets over multiple rounds', async () => {
    const h = await setup({ relayModule: { negentropy: { frameSizeLimit: 4096 } } });
    const c = await h.connect();
    const k = makeKey();
    const base = h.ports.clock.now() - 10_000;
    const all: NostrEvent[] = [];
    for (let i = 0; i < 400; i++) all.push(h.event(k, { created_at: base + i * 3 }));
    const shared = all.slice(0, 300);
    const relayOnly = all.slice(300, 350);
    const clientOnly = all.slice(350);
    for (const e of [...shared, ...relayOnly]) await h.ports.events.save('main', e);
    const res = await sync(h, c, [...shared, ...clientOnly], { authors: [k.pk] });
    expect(res.have).toEqual(clientOnly.map((e) => e.id).sort());
    expect(res.need).toEqual(relayOnly.map((e) => e.id).sort());
    expect(res.rounds).toBeGreaterThan(0);
  });

  test('identical sets converge immediately', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const evs = Array.from({ length: 50 }, (_, i) => h.event(k, { created_at: 1_000 + i }));
    for (const e of evs) await h.ports.events.save('main', e);
    const res = await sync(h, c, evs, {});
    expect(res.have).toEqual([]);
    expect(res.need).toEqual([]);
  });

  test('NEG-MSG for unknown session, NEG-CLOSE, bad input, and disabled', async () => {
    const h = await setup();
    const c = await h.connect();
    expect(await negRound(h, c, ['NEG-MSG', 'zz', '61'])).toEqual([
      'NEG-ERR',
      'zz',
      'closed: unknown sync session',
    ]);
    const bad = await negRound(h, c, ['NEG-OPEN', 'b', {}, 'zz-not-hex']);
    expect(bad[0]).toBe('NEG-ERR');
    expect(String(bad[2])).toStartWith('invalid:');

    const storage = new NegentropyStorageVector();
    storage.seal();
    const init = await new Negentropy(storage).initiate();
    expect((await negRound(h, c, ['NEG-OPEN', 'ok', {}, init]))[0]).toBe('NEG-MSG');
    c.take();
    await h.send(c, ['NEG-CLOSE', 'ok']);
    expect(c.take()).toEqual([]);
    expect((await negRound(h, c, ['NEG-MSG', 'ok', init]))[0]).toBe('NEG-ERR');

    const off = await setup({ relayModule: { negentropy: { enabled: false } } });
    const c2 = await off.connect();
    expect((await negRound(off, c2, ['NEG-OPEN', 'x', {}, init]))[0]).toBe('NEG-ERR');
  });

  test('enforces maxRecords and read auth', async () => {
    const h = await setup({
      relayModule: { negentropy: { maxRecords: 2 } },
      relay: { access: { authRequired: { read: true } } },
    });
    const c = await h.connect();
    const k = makeKey();
    for (let i = 0; i < 3; i++)
      await h.ports.events.save('main', h.event(k, { created_at: 10 + i }));
    const storage = new NegentropyStorageVector();
    storage.seal();
    const init = await new Negentropy(storage).initiate();
    expect(await negRound(h, c, ['NEG-OPEN', 'x', {}, init])).toEqual([
      'NEG-ERR',
      'x',
      'auth-required: please sign in to read',
    ]);
    await h.auth(c, k);
    expect(await negRound(h, c, ['NEG-OPEN', 'x', {}, init])).toEqual([
      'NEG-ERR',
      'x',
      'blocked: too many records',
    ]);
  });
});
