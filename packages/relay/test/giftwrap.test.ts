// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeKey } from '@beamhop/testkit';
import { giftWrapFilters } from '../src/index.ts';
import { eventsOf, setup } from './helpers.ts';

describe('NIP-17/59 gift wraps', () => {
  test('anyone can publish a gift wrap', async () => {
    const h = await setup();
    const c = await h.connect();
    const wrap = h.event(makeKey(), { kind: 1059, tags: [['p', makeKey().pk]] });
    expect((await h.publish(c, wrap))[2]).toBe(true);
  });

  test('asking for gift wraps without signing in → CLOSED auth-required', async () => {
    const h = await setup();
    const bob = makeKey();
    const c = await h.connect();
    const frames = await h.req(c, 'dm', { kinds: [1059], '#p': [bob.pk] });
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toBe('CLOSED');
    expect(String(frames[0]![2])).toMatch(/^auth-required: /);
    // The AUTH challenge was issued on connect, so the client can sign in and retry.
    expect(c.challenge).toMatch(/^[0-9a-f]+$/);
    c.take();
    await h.send(c, ['COUNT', 'n', { kinds: [1059] }]);
    expect(String(c.of('CLOSED')[0]?.[2])).toMatch(/^auth-required: /);
  });

  test('only the AUTHed recipient receives stored and live gift wraps', async () => {
    const h = await setup();
    const alice = makeKey();
    const bob = makeKey();
    const pub = await h.connect();
    const toBob = h.event(makeKey(), { kind: 1059, tags: [['p', bob.pk]] });
    const toAlice = h.event(makeKey(), { kind: 1059, tags: [['p', alice.pk]] });
    await h.publish(pub, toBob);
    await h.publish(pub, toAlice);

    const b = await h.connect();
    await h.auth(b, bob);
    // No #p given: narrowed to the signed-in pubkey.
    expect(eventsOf(await h.req(b, 'dm', { kinds: [1059] }))).toEqual([toBob]);

    const a = await h.connect();
    await h.auth(a, alice);
    const denied = await h.req(a, 'snoop', { kinds: [1059], '#p': [bob.pk] });
    expect(denied[0]![0]).toBe('CLOSED');
    expect(String(denied[0]![2])).toMatch(/^restricted: /);
    // Mixed kinds: the gift-wrap part is narrowed, the rest is served.
    const note = h.event(alice, { kind: 1 });
    await h.publish(pub, note);
    const mixed = eventsOf(await h.req(a, 'mixed', { kinds: [1, 1059], '#p': [bob.pk] }));
    expect(mixed).toEqual([]);
    const mine = eventsOf(await h.req(a, 'mine', { kinds: [1, 1059] }));
    expect(mine.map((e) => e.id).sort()).toEqual([note.id, toAlice.id].sort());

    // Filters without kinds never leak someone else's wraps.
    const anon = await h.connect();
    const all = eventsOf(await h.req(anon, 'all', {}));
    expect(all.some((e) => e.kind === 1059)).toBe(false);
    const byId = eventsOf(await h.req(anon, 'id', { ids: [toBob.id] }));
    expect(byId).toEqual([]);

    // Live.
    b.take();
    anon.take();
    const live = h.event(makeKey(), { kind: 1059, tags: [['p', bob.pk]] });
    await h.publish(pub, live);
    expect(eventsOf(b.frames, 'dm')).toEqual([live]);
    expect(eventsOf(anon.frames)).toEqual([]);
  });

  test('filter rewriting', () => {
    const me = new Set(['a'.repeat(64)]);
    const r = giftWrapFilters([{ kinds: [1, 1059], limit: 5 }], me);
    expect(r).toEqual({
      ok: true,
      filters: [
        { kinds: [1059], '#p': ['a'.repeat(64)], limit: 5 },
        { kinds: [1], limit: 5 },
      ],
    });
    expect(giftWrapFilters([{ kinds: [1059] }], new Set()).ok).toBe(false);
  });

  test('kind 10050 (DM relays) and 10002 (NIP-65 relay list) are replaceable', async () => {
    const h = await setup();
    const k = makeKey();
    const c = await h.connect();
    for (const kind of [10050, 10002]) {
      const old = h.event(k, {
        kind,
        tags: [['relay', 'wss://old.example']],
        created_at: h.ports.clock.now() - 10,
      });
      const cur = h.event(k, { kind, tags: [['r', 'wss://new.example']] });
      expect((await h.publish(c, old))[2]).toBe(true);
      expect((await h.publish(c, cur))[2]).toBe(true);
      const stale = await h.publish(c, old);
      expect(stale[2]).toBe(true);
      expect(eventsOf(await h.req(c, 'x', { kinds: [kind], authors: [k.pk] }))).toEqual([cur]);
    }
  });
});

describe('deletion bus events', () => {
  test('NIP-62 vanish reports deleted ids and removes gift wraps addressed to the user', async () => {
    const h = await setup();
    const deleted = h.record('event.deleted');
    const k = makeKey();
    const c = await h.connect();
    const n1 = h.event(k, { created_at: h.ports.clock.now() - 5 });
    const n2 = h.event(k, { created_at: h.ports.clock.now() - 4 });
    const wrap = h.event(makeKey(), {
      kind: 1059,
      tags: [['p', k.pk]],
      created_at: h.ports.clock.now() - 3,
    });
    for (const e of [n1, n2, wrap]) await h.publish(c, e);
    const vanish = h.event(k, { kind: 62, tags: [['relay', 'ALL_RELAYS']] });
    expect((await h.publish(c, vanish))[2]).toBe(true);
    const ev = deleted.at(-1)!;
    expect(ev.cause).toBe('nip62');
    expect(ev.ids.sort()).toEqual([n1.id, n2.id, wrap.id].sort());
    expect(ev.count).toBe(3);
    expect(await h.ports.events.getById('main', wrap.id)).toBeNull();
  });

  test('vanish id collection is capped; count carries the total', async () => {
    const h = await setup({ relayModule: { vanishIdCap: 2 } });
    const deleted = h.record('event.deleted');
    const k = makeKey();
    const c = await h.connect();
    for (let i = 0; i < 5; i++)
      await h.publish(c, h.event(k, { created_at: h.ports.clock.now() - 10 + i }));
    await h.publish(c, h.event(k, { kind: 62, tags: [['relay', 'ALL_RELAYS']] }));
    expect(deleted.at(-1)!.ids).toHaveLength(2);
    expect(deleted.at(-1)!.count).toBe(5);
  });

  test('NIP-40 expiry sweep emits event.deleted with a count', async () => {
    const h = await setup();
    const deleted = h.record('event.deleted');
    const c = await h.connect();
    const exp = h.ports.clock.now() + 10;
    await h.publish(c, h.event(makeKey(), { tags: [['expiration', String(exp)]] }));
    h.ports.clock.advance(20);
    await h.ports.scheduler.tick('relay.expire');
    expect(deleted).toEqual([{ relayId: '*', ids: [], cause: 'expiry', count: 1 }]);
  });
});
