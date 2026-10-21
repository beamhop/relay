// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { NostrEvent } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { eventsOf, setup } from './helpers.ts';

describe('NIP-01 protocol', () => {
  test('connect issues an AUTH challenge and emits conn.open / conn.close', async () => {
    const h = await setup();
    const opens = h.record('conn.open');
    const closes = h.record('conn.close');
    const c = await h.connect();
    expect(c.challenge).toMatch(/^[0-9a-f]{32}$/);
    expect(c.take()).toEqual([['AUTH', c.challenge]]);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ relayId: 'main', connId: c.id, ipHash: 'iphash' });
    h.ports.clock.advance(5);
    h.engine.onClose(c);
    expect(closes).toEqual([{ relayId: 'main', connId: c.id, durationMs: 5000 }]);
    expect(h.engine.connectionCount()).toBe(0);
  });

  test('unknown relay closes the connection', async () => {
    const h = await setup();
    const c = await h.connect('nope');
    expect(c.closedWith?.code).toBe(1008);
    expect(c.of('NOTICE')).toHaveLength(1);
  });

  test('EVENT is stored, acknowledged and served to REQ with EOSE', async () => {
    const h = await setup();
    const accepted = h.record('event.accepted');
    const served = h.record('req.served');
    const c = await h.connect();
    const k = makeKey();
    const ev = h.event(k);
    expect(await h.publish(c, ev)).toEqual(['OK', ev.id, true, '']);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(accepted[0]!.connId).toBe(c.id);
    const frames = await h.req(c, 's1', { authors: [k.pk] });
    expect(frames).toEqual([
      ['EVENT', 's1', ev],
      ['EOSE', 's1'],
    ]);
    expect(served[0]).toMatchObject({ relayId: 'main', filters: 1, results: 1 });
  });

  test('live events reach open subscriptions; CLOSE stops them', async () => {
    const h = await setup();
    const reader = await h.connect();
    const writer = await h.connect();
    const k = makeKey();
    await h.req(reader, 'live', { kinds: [1] });
    const ev = h.event(k);
    await h.publish(writer, ev);
    expect(reader.take()).toEqual([['EVENT', 'live', ev]]);
    await h.send(reader, ['CLOSE', 'live']);
    await h.publish(writer, h.event(k));
    expect(reader.take()).toEqual([]);
    expect(h.engine.subscriptionCount('main')).toBe(0);
  });

  test('REQ with same id replaces the subscription', async () => {
    const h = await setup();
    const c = await h.connect();
    const w = await h.connect();
    const k = makeKey();
    await h.req(c, 'x', { kinds: [1] });
    await h.req(c, 'x', { kinds: [7] });
    await h.publish(w, h.event(k, { kind: 1 }));
    expect(c.take()).toEqual([]);
    const r = h.event(k, { kind: 7 });
    await h.publish(w, r);
    expect(eventsOf(c.take(), 'x')).toEqual([r]);
    expect(h.engine.subscriptionCount('main')).toBe(1);
  });

  test('duplicates are acknowledged with the duplicate prefix before signature checks', async () => {
    const h = await setup();
    const c = await h.connect();
    const ev = h.event(makeKey());
    await h.publish(c, ev);
    const ok = await h.publish(c, ev);
    expect(ok[2]).toBe(true);
    expect(String(ok[3])).toStartWith('duplicate:');
    // A forged copy with the same id is short-circuited without verification.
    const forged = { ...ev, sig: 'f'.repeat(128) };
    const ok2 = await h.publish(c, forged);
    expect(ok2[2]).toBe(true);
    expect(String(ok2[3])).toStartWith('duplicate:');
  });

  test('stored duplicates are detected after a restart of the dedupe cache', async () => {
    const h = await setup();
    const c = await h.connect();
    const ev = h.event(makeKey());
    await h.ports.events.save('main', ev);
    const ok = await h.publish(c, ev);
    expect(ok).toEqual(['OK', ev.id, true, 'duplicate: already have this event']);
  });

  test('invalid events are rejected with invalid prefix', async () => {
    const h = await setup();
    const rejected = h.record('event.rejected');
    const c = await h.connect();
    const k = makeKey();
    const ev = h.event(k);
    const badSig = { ...ev, sig: ev.sig.replace(/^./, ev.sig[0] === 'a' ? 'b' : 'a') };
    expect(await h.publish(c, badSig)).toEqual(['OK', ev.id, false, 'invalid: bad signature']);
    const badId = { ...h.event(k), content: 'tampered' };
    const okId = await h.publish(c, badId);
    expect(okId[2]).toBe(false);
    expect(String(okId[3])).toStartWith('invalid:');
    const shape = await h.publish(c, { id: 'abc', kind: 1 });
    expect(shape).toEqual(['OK', 'abc', false, 'invalid: bad id']);
    expect(rejected.map((r) => r.reason)).toContain('invalid: bad signature');
  });

  test('malformed frames produce NOTICE', async () => {
    const h = await setup();
    const c = await h.connect();
    c.take();
    await h.engine.handle(c, 'not json');
    await h.send(c, ['WHAT', 1]);
    await h.send(c, ['REQ', '']);
    const notices = c.take();
    expect(notices.map((n) => n[0])).toEqual(['NOTICE', 'NOTICE', 'NOTICE']);
    expect(String(notices[0]![1])).toStartWith('invalid:');
  });

  test('oversized frames are refused', async () => {
    const h = await setup({ relayModule: { maxMessageBytes: 100 } });
    const c = await h.connect();
    c.take();
    await h.send(c, ['EVENT', h.event(makeKey(), { content: 'x'.repeat(200) })]);
    expect(c.take()).toEqual([['NOTICE', 'invalid: message is too large']]);
  });

  test('AUTH events sent via EVENT are refused', async () => {
    const h = await setup();
    const c = await h.connect();
    const ok = await h.publish(c, h.authEvent(makeKey(), c));
    expect(ok[2]).toBe(false);
  });

  test('replaceable events: newest wins, older is superseded', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const now = h.ports.clock.now();
    const older = h.event(k, { kind: 0, content: '{"name":"a"}', created_at: now - 10 });
    const newer = h.event(k, { kind: 0, content: '{"name":"b"}', created_at: now });
    expect((await h.publish(c, newer))[2]).toBe(true);
    const ok = await h.publish(c, older);
    expect(ok[2]).toBe(true);
    expect(String(ok[3])).toStartWith('duplicate:');
    expect(eventsOf(await h.req(c, 'p', { kinds: [0], authors: [k.pk] }))).toEqual([newer]);
  });

  test('addressable events are keyed by d tag', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const now = h.ports.clock.now();
    const a1 = h.event(k, { kind: 30023, tags: [['d', 'a']], created_at: now - 5 });
    const a2 = h.event(k, { kind: 30023, tags: [['d', 'a']], created_at: now });
    const b1 = h.event(k, { kind: 30023, tags: [['d', 'b']], created_at: now - 5 });
    for (const e of [a1, a2, b1]) await h.publish(c, e);
    const got = eventsOf(await h.req(c, 'a', { kinds: [30023] }));
    expect(got.map((e) => e.id).sort()).toEqual([a2.id, b1.id].sort());
  });

  test('ephemeral events are broadcast but never stored', async () => {
    const h = await setup();
    const reader = await h.connect();
    const writer = await h.connect();
    const k = makeKey();
    await h.req(reader, 'eph', { kinds: [20001] });
    const ev = h.event(k, { kind: 20001 });
    expect(await h.publish(writer, ev)).toEqual(['OK', ev.id, true, '']);
    expect(eventsOf(reader.take())).toEqual([ev]);
    expect(await h.ports.events.getById('main', ev.id)).toBeNull();
    expect(eventsOf(await h.req(reader, 'again', { kinds: [20001] }))).toEqual([]);
  });

  test('live events published while the stored query runs are delivered once after EOSE', async () => {
    const h = await setup();
    const store = h.ports.events;
    const k = makeKey();
    const stored = h.event(k, { created_at: h.ports.clock.now() - 1 });
    await store.save('main', stored);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const origQuery = store.query.bind(store);
    store.query = async (...args) => {
      await gate;
      return origQuery(...args);
    };
    const reader = await h.connect();
    const writer = await h.connect();
    reader.take();
    const reqDone = h.send(reader, ['REQ', 's', { authors: [k.pk] }]);
    for (let i = 0; i < 100 && h.engine.subscriptionCount('main') === 0; i++) await Bun.sleep(0);
    expect(h.engine.subscriptionCount('main')).toBe(1);
    const live = h.event(k);
    store.query = origQuery;
    await h.publish(writer, live);
    expect(reader.frames).toEqual([]);
    release();
    await reqDone;
    // Stored query (released after live was saved) sees both; live is not repeated.
    const frames = reader.take();
    const ids = eventsOf(frames).map((e) => e.id);
    expect(frames.findIndex((f) => f[0] === 'EOSE')).toBe(frames.length - 1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(live.id);
    expect(ids).toContain(stored.id);
  });
});

describe('limits', () => {
  test('created_at bounds', async () => {
    const h = await setup({
      limits: { maxCreatedAtFutureSeconds: 60, maxCreatedAtPastSeconds: 3600 },
    });
    const c = await h.connect();
    const k = makeKey();
    const now = h.ports.clock.now();
    const future = await h.publish(c, h.event(k, { created_at: now + 120 }));
    expect(future[2]).toBe(false);
    expect(String(future[3])).toBe('invalid: created_at is too far in the future');
    const past = await h.publish(c, h.event(k, { created_at: now - 7200 }));
    expect(String(past[3])).toBe('invalid: created_at is too far in the past');
    expect((await h.publish(c, h.event(k, { created_at: now + 30 })))[2]).toBe(true);
  });

  test('maxEventBytes', async () => {
    const h = await setup({ limits: { maxEventBytes: 400 } });
    const c = await h.connect();
    const ok = await h.publish(c, h.event(makeKey(), { content: 'é'.repeat(100) }));
    expect(ok[2]).toBe(false);
    expect(String(ok[3])).toStartWith('invalid: event is too large');
  });

  test('maxSubscriptions and maxFilters', async () => {
    const h = await setup({ limits: { maxSubscriptions: 2, maxFilters: 2 } });
    const c = await h.connect();
    await h.req(c, 'a', {});
    await h.req(c, 'b', {});
    const third = await h.req(c, 'c', {});
    expect(third[0]?.[0]).toBe('CLOSED');
    expect(String(third[0]?.[2])).toStartWith('rate-limited:');
    // Replacing an existing id is allowed at the cap.
    expect((await h.req(c, 'a', { kinds: [1] })).at(-1)).toEqual(['EOSE', 'a']);
    const many = await h.req(c, 'd', {}, {}, {});
    expect(many[0]).toEqual(['CLOSED', 'd', 'invalid: too many filters (max 2)']);
    const none = await h.req(c, 'e');
    expect(none[0]?.[0]).toBe('CLOSED');
  });

  test('limit is clamped to maxLimit', async () => {
    const h = await setup({ limits: { maxLimit: 2 } });
    const c = await h.connect();
    const k = makeKey();
    for (let i = 0; i < 5; i++)
      await h.publish(c, h.event(k, { created_at: h.ports.clock.now() - i }));
    expect(eventsOf(await h.req(c, 'a', { authors: [k.pk], limit: 100 }))).toHaveLength(2);
    expect(eventsOf(await h.req(c, 'b', { authors: [k.pk] }))).toHaveLength(2);
    expect(eventsOf(await h.req(c, 'c', { authors: [k.pk], limit: 1 }))).toHaveLength(1);
  });

  test('invalid filters are CLOSED', async () => {
    const h = await setup();
    const c = await h.connect();
    const frames = await h.req(c, 'a', { kinds: ['x'] });
    expect(frames).toEqual([['CLOSED', 'a', 'invalid: kinds']]);
  });

  test('allowed and blocked kinds', async () => {
    const h = await setup({ limits: { allowedKinds: [1, 7], blockedKinds: [7] } });
    const c = await h.connect();
    const k = makeKey();
    expect((await h.publish(c, h.event(k, { kind: 1 })))[2]).toBe(true);
    expect(String((await h.publish(c, h.event(k, { kind: 7 })))[3])).toStartWith('blocked:');
    expect(String((await h.publish(c, h.event(k, { kind: 4 })))[3])).toStartWith('blocked:');
  });

  test('pending message cap', async () => {
    const h = await setup({ relayModule: { maxPendingMessages: 1 } });
    const c = await h.connect();
    c.take();
    const p1 = h.send(c, ['COUNT', 'a', {}]);
    const p2 = h.send(c, ['COUNT', 'b', {}]);
    await Promise.all([p1, p2]);
    const types = c.take().map((f) => f[0]);
    expect(types).toContain('NOTICE');
    expect(types).toContain('COUNT');
  });
});

describe('backpressure', () => {
  test('drops live events above the soft limit with a single NOTICE', async () => {
    const h = await setup({
      relayModule: { backpressure: { dropAboveBytes: 10, closeAboveBytes: 1000 } },
    });
    const reader = await h.connect();
    const writer = await h.connect();
    await h.req(reader, 's', {});
    reader.buffered = 100;
    const k = makeKey();
    await h.publish(writer, h.event(k));
    await h.publish(writer, h.event(k));
    const frames = reader.take();
    expect(frames.filter((f) => f[0] === 'EVENT')).toHaveLength(0);
    expect(frames.filter((f) => f[0] === 'NOTICE')).toHaveLength(1);
    reader.buffered = 0;
    const ev: NostrEvent = h.event(k);
    await h.publish(writer, ev);
    expect(eventsOf(reader.take())).toEqual([ev]);
  });

  test('closes slow consumers above the hard limit', async () => {
    const h = await setup({
      relayModule: { backpressure: { dropAboveBytes: 10, closeAboveBytes: 50 } },
    });
    const closes = h.record('conn.close');
    const reader = await h.connect();
    const writer = await h.connect();
    await h.req(reader, 's', {});
    reader.buffered = 100;
    await h.publish(writer, h.event(makeKey()));
    expect(reader.closedWith?.code).toBe(1013);
    expect(closes.map((c) => c.connId)).toEqual([reader.id]);
    expect(h.engine.subscriptionCount('main')).toBe(0);
  });
});
