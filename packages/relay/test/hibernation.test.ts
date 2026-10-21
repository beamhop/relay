// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { NostrEvent } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { CONN_STATE_KEY, Negentropy, NegentropyStorageVector } from '../src/index.ts';
import { type FakeConn, type Harness, eventsOf, setup } from './helpers.ts';

/** A second node instance over the same storage (what a Durable Object wake-up looks like). */
async function wake(h: Harness, extra: Parameters<typeof setup>[0] = {}): Promise<Harness> {
  return setup({
    ...extra,
    ports: { events: h.ports.events, docs: h.ports.docs, clock: h.ports.clock },
  });
}

describe('hibernation', () => {
  test('subscriptions survive: restored without replay, live events still delivered', async () => {
    const h1 = await setup();
    const k = makeKey();
    const c = await h1.connect();
    const stored = h1.event(k);
    await h1.publish(await h1.connect(), stored);
    const first = await h1.req(c, 's1', { kinds: [1] });
    expect(eventsOf(first)).toHaveLength(1);
    expect(first.at(-1)).toEqual(['EOSE', 's1']);
    await h1.req(c, 's2', { authors: [k.pk] });
    await h1.send(c, ['CLOSE', 's2']);

    // State is plain JSON data.
    const raw = c.state.get(CONN_STATE_KEY);
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
    expect(Object.keys((raw as { subs: object }).subs)).toEqual(['s1']);

    const h2 = await wake(h1);
    const c2 = c.hibernate();
    h2.engine.onRestore(c2);
    expect(c2.frames).toEqual([]); // no stored events, no EOSE, no new AUTH challenge
    expect(h2.engine.connectionCount()).toBe(1);
    expect(h2.engine.subscriptionCount('main')).toBe(1);

    const live = h2.event(k, { content: 'after wake-up' });
    await h2.publish(await h2.connect(), live);
    expect(c2.frames).toEqual([['EVENT', 's1', live]]);

    // CLOSE still works after the restore.
    await h2.send(c2, ['CLOSE', 's1']);
    expect(h2.engine.subscriptionCount('main')).toBe(0);
  });

  test('a message on a hibernated connection restores it even without onRestore', async () => {
    const h1 = await setup();
    const k = makeKey();
    const c = await h1.connect();
    await h1.req(c, 'feed', { kinds: [1] });
    const h2 = await wake(h1);
    const c2 = c.hibernate();
    await h2.send(c2, ['REQ', 'other', { kinds: [7] }]);
    expect(c2.of('AUTH')).toHaveLength(0);
    expect(c2.of('EOSE')).toEqual([['EOSE', 'other']]);
    c2.take();
    const ev = h2.event(k, { content: 'after wake-up' });
    await h2.publish(await h2.connect(), ev);
    expect(eventsOf(c2.frames, 'feed')).toEqual([ev]);
  });

  test('NIP-42 auth survives: gift wraps are still delivered to the recipient', async () => {
    const h1 = await setup();
    const bob = makeKey();
    const c = await h1.connect();
    expect((await h1.auth(c, bob))[2]).toBe(true);
    const res = await h1.req(c, 'dm', { kinds: [1059], '#p': [bob.pk] });
    expect(res).toEqual([['EOSE', 'dm']]);

    const h2 = await wake(h1);
    const c2 = c.hibernate();
    h2.engine.onRestore(c2);
    const wrap = h2.event(makeKey(), { kind: 1059, tags: [['p', bob.pk]] });
    await h2.publish(await h2.connect(), wrap);
    expect(eventsOf(c2.frames, 'dm')).toEqual([wrap]);
  });

  test('closed connections are not resurrected', async () => {
    const h1 = await setup();
    const c = await h1.connect();
    await h1.req(c, 's', { kinds: [1] });
    h1.engine.onClose(c);
    const h2 = await wake(h1);
    const c2 = c.hibernate();
    h2.engine.onRestore(c2);
    expect(h2.engine.connectionCount()).toBe(0);
  });

  test('negentropy sessions continue on the woken instance', async () => {
    const opts = { relayModule: { negentropy: { frameSizeLimit: 4096 } } };
    const h1 = await setup(opts);
    const k = makeKey();
    const base = h1.ports.clock.now() - 10_000;
    const all: NostrEvent[] = [];
    for (let i = 0; i < 400; i++) all.push(h1.event(k, { created_at: base + i * 3 }));
    const shared = all.slice(0, 300);
    const relayOnly = all.slice(300, 350);
    const clientOnly = all.slice(350);
    for (const e of [...shared, ...relayOnly]) await h1.ports.events.save('main', e);

    const storage = new NegentropyStorageVector();
    for (const e of [...shared, ...clientOnly]) storage.insert(e.created_at, e.id);
    storage.seal();
    const client = new Negentropy(storage, 0);

    const c = await h1.connect();
    c.take();
    await h1.send(c, ['NEG-OPEN', 'n', { authors: [k.pk] }, await client.initiate()]);
    let reply = c.take()[0]!;
    expect(reply[0]).toBe('NEG-MSG');

    let node = h1;
    let conn: FakeConn = c;
    const have: string[] = [];
    const need: string[] = [];
    for (let rounds = 0; ; rounds++) {
      const [next, h, n] = await client.reconcile(reply[2] as string);
      have.push(...h);
      need.push(...n);
      if (next === null) break;
      // Hibernate (fresh instance) between every round.
      node = await wake(h1, opts);
      conn = conn.hibernate();
      node.engine.onRestore(conn);
      await node.send(conn, ['NEG-MSG', 'n', next]);
      reply = conn.take()[0]!;
      expect(reply[0]).toBe('NEG-MSG');
      if (rounds > 50) throw new Error('did not converge');
    }
    expect(node).not.toBe(h1);
    expect(need.sort()).toEqual(relayOnly.map((e) => e.id).sort());
    expect(have.sort()).toEqual(clientOnly.map((e) => e.id).sort());

    await node.send(conn, ['NEG-CLOSE', 'n']);
    expect((conn.state.get(CONN_STATE_KEY) as { negs: object }).negs).toEqual({});
  });
});
