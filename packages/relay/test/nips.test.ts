// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type EventStore, finalizeEvent } from '@beamhop/core';
import { MemoryEventStore, makeKey } from '@beamhop/testkit';
import {
  committedDifficulty,
  countLeadingZeroBits,
  minePow,
  powDifficulty,
  relayInfo,
} from '../src/index.ts';
import { eventsOf, setup } from './helpers.ts';

describe('NIP-09 deletion', () => {
  test('kind 5 deletes referenced events, emits event.deleted, and blocks re-publish', async () => {
    const h = await setup();
    const deleted = h.record('event.deleted');
    const c = await h.connect();
    const k = makeKey();
    const target = h.event(k);
    await h.publish(c, target);
    const del = h.event(k, { kind: 5, tags: [['e', target.id]] });
    expect((await h.publish(c, del))[2]).toBe(true);
    expect(deleted).toEqual([{ relayId: 'main', ids: [target.id], cause: 'nip09' }]);
    expect(await h.ports.events.getById('main', target.id)).toBeNull();
    // The deletion request itself is stored and served.
    expect(eventsOf(await h.req(c, 'd', { kinds: [5] }))).toEqual([del]);
  });

  test('deletion of someone else’s event is ignored', async () => {
    const h = await setup();
    const deleted = h.record('event.deleted');
    const c = await h.connect();
    const target = h.event(makeKey());
    await h.publish(c, target);
    await h.publish(c, h.event(makeKey(), { kind: 5, tags: [['e', target.id]] }));
    expect(deleted).toEqual([]);
    expect(await h.ports.events.getById('main', target.id)).not.toBeNull();
  });

  test('re-publishing a deleted event is blocked', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const target = h.event(k);
    // Tombstone directly so the relay dedupe cache has never seen the id.
    await h.ports.events.save('main', target);
    await h.ports.events.applyDeletion('main', h.event(k, { kind: 5, tags: [['e', target.id]] }));
    const ok = await h.publish(c, target);
    expect(ok).toEqual(['OK', target.id, false, 'blocked: this event has been deleted']);
  });
});

describe('NIP-11 relay information', () => {
  test('serves the info document with CORS for application/nostr+json', async () => {
    const h = await setup({
      relay: {
        info: { name: 'Test Relay', description: 'hi', pubkey: 'a'.repeat(64), contact: 'x@y' },
      },
      limits: { minPowDifficulty: 8 },
    });
    const res = await h.kernel.http.request('http://relay.test/', {
      headers: { accept: 'application/nostr+json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/nostr+json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const doc = (await res.json()) as ReturnType<typeof relayInfo>;
    expect(doc.name).toBe('Test Relay');
    expect(doc.pubkey).toBe('a'.repeat(64));
    expect(doc.supported_nips).toEqual([
      1, 2, 9, 11, 13, 17, 29, 40, 42, 45, 50, 56, 59, 62, 65, 70, 77,
    ]);
    expect(doc.self).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.limitation.min_pow_difficulty).toBe(8);
    expect(doc.limitation.auth_required).toBe(false);
    expect(doc.software).toContain('beamhop');
  });

  test('ignores other paths and plain requests; answers CORS preflight', async () => {
    const h = await setup();
    const plain = await h.kernel.http.request('http://relay.test/');
    expect(plain.status).toBe(404);
    const other = await h.kernel.http.request('http://relay.test/other', {
      headers: { accept: 'application/nostr+json' },
    });
    expect(other.status).toBe(404);
    const pre = await h.kernel.http.request('http://relay.test/', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toBe('*');
  });

  test('advertises auth and restricted writes; omits 50 when search unsupported', async () => {
    const store = new MemoryEventStore();
    Object.defineProperty(store, 'capabilities', { value: { search: false, exactCount: true } });
    const h = await setup({
      ports: { events: store },
      relay: { access: { mode: 'allowlist', authRequired: { read: true } } },
      relayModule: { negentropy: { enabled: false } },
    });
    const res = await h.kernel.http.request('http://relay.test/', {
      headers: { accept: 'application/nostr+json' },
    });
    const doc = (await res.json()) as ReturnType<typeof relayInfo>;
    expect(doc.supported_nips).not.toContain(50);
    expect(doc.supported_nips).not.toContain(77);
    expect(doc.limitation.auth_required).toBe(true);
    expect(doc.limitation.restricted_writes).toBe(true);
  });
});

describe('NIP-13 proof of work', () => {
  test('helpers', () => {
    expect(countLeadingZeroBits('ffff')).toBe(0);
    expect(countLeadingZeroBits('0fff')).toBe(4);
    expect(
      countLeadingZeroBits('000000000e9d97a1ab09fc381030b346cdd7a142ad57e6df0b46dc9bef6c7e2d'),
    ).toBe(36);
    expect(countLeadingZeroBits('1')).toBe(3);
    expect(countLeadingZeroBits('0000')).toBe(16);
    expect(committedDifficulty({ tags: [['nonce', '1', '20']] })).toBe(20);
    expect(powDifficulty({ id: `0000${'f'.repeat(60)}`, tags: [['nonce', '1', '8']] })).toBe(8);
  });

  test('enforces minPowDifficulty from limits', async () => {
    const h = await setup({ limits: { minPowDifficulty: 8 } });
    const c = await h.connect();
    const k = makeKey();
    const now = h.ports.clock.now();
    // Find an event with difficulty < 8 (overwhelmingly likely on first try).
    let low = h.event(k);
    while (countLeadingZeroBits(low.id) >= 8) low = h.event(k);
    const ok = await h.publish(c, low);
    expect(ok[2]).toBe(false);
    expect(String(ok[3])).toStartWith('pow:');

    const mined = minePow({ pubkey: k.pk, kind: 1, tags: [], content: 'work', created_at: now }, 8);
    expect(countLeadingZeroBits(mined.id)).toBeGreaterThanOrEqual(8);
    const signed = finalizeEvent(
      { kind: mined.kind, tags: mined.tags, content: mined.content, created_at: mined.created_at },
      k.sk,
    );
    expect(signed.id).toBe(mined.id);
    expect((await h.publish(c, signed))[2]).toBe(true);
  });
});

describe('NIP-40 expiration', () => {
  test('already-expired events are rejected', async () => {
    const h = await setup();
    const c = await h.connect();
    const now = h.ports.clock.now();
    const ok = await h.publish(c, h.event(makeKey(), { tags: [['expiration', String(now - 1)]] }));
    expect(ok[3]).toBe('invalid: event has expired');
  });

  test('expired events are never served and are swept by the scheduler', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const now = h.ports.clock.now();
    const ev = h.event(k, { tags: [['expiration', String(now + 10)]] });
    await h.publish(c, ev);
    expect(eventsOf(await h.req(c, 'a', { authors: [k.pk] }))).toEqual([ev]);
    h.ports.clock.advance(20);
    expect(eventsOf(await h.req(c, 'b', { authors: [k.pk] }))).toEqual([]);
    expect(h.ports.scheduler.jobs.has('relay.expire')).toBe(true);
    await h.ports.scheduler.tick('relay.expire');
    expect(await h.ports.events.getById('main', ev.id)).toBeNull();
  });
});

describe('NIP-42 authentication', () => {
  test('valid AUTH marks the connection and emits auth.success', async () => {
    const h = await setup();
    const auths = h.record('auth.success');
    const c = await h.connect();
    const k = makeKey();
    const ok = await h.auth(c, k);
    expect(ok[2]).toBe(true);
    expect(c.authed.has(k.pk)).toBe(true);
    expect(auths).toEqual([{ relayId: 'main', connId: c.id, pubkey: k.pk }]);
  });

  test('rejects wrong challenge, relay, kind, age and signature', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const send = async (ev: unknown) => {
      c.take();
      await h.send(c, ['AUTH', ev]);
      return c.take()[0]!;
    };
    expect((await send(h.authEvent(k, c, { challenge: 'nope' })))[3]).toBe(
      'invalid: challenge does not match',
    );
    expect((await send(h.authEvent(k, c, { relay: 'wss://other.example/' })))[3]).toBe(
      'invalid: sign-in event is for a different relay',
    );
    const wrongKind = h.event(k, {
      kind: 1,
      tags: [
        ['relay', 'wss://relay.test'],
        ['challenge', c.challenge],
      ],
    });
    expect(String((await send(wrongKind))[3])).toStartWith('invalid: sign-in event must be kind');
    const stale = finalizeEvent(
      {
        kind: 22242,
        created_at: h.ports.clock.now() - 3600,
        content: '',
        tags: [
          ['relay', 'wss://relay.test'],
          ['challenge', c.challenge],
        ],
      },
      k.sk,
    );
    expect(String((await send(stale))[3])).toStartWith('invalid: sign-in event is too old');
    const good = h.authEvent(k, c);
    expect((await send({ ...good, sig: '0'.repeat(128) }))[3]).toBe('invalid: bad signature');
    expect(c.authed.size).toBe(0);
  });

  test('authRequired.write gates EVENT until AUTH', async () => {
    const h = await setup({ relay: { access: { authRequired: { write: true } } } });
    const c = await h.connect();
    const k = makeKey();
    const ev = h.event(k);
    expect(await h.publish(c, ev)).toEqual([
      'OK',
      ev.id,
      false,
      'auth-required: please sign in to post',
    ]);
    await h.auth(c, k);
    expect((await h.publish(c, h.event(k)))[2]).toBe(true);
  });

  test('authRequired.read gates REQ and COUNT until AUTH', async () => {
    const h = await setup({ relay: { access: { authRequired: { read: true } } } });
    const c = await h.connect();
    expect(await h.req(c, 's', {})).toEqual([
      ['CLOSED', 's', 'auth-required: please sign in to read'],
    ]);
    c.take();
    await h.send(c, ['COUNT', 'n', {}]);
    expect(c.take()[0]?.[0]).toBe('CLOSED');
    await h.auth(c, makeKey());
    expect(await h.req(c, 's', {})).toEqual([['EOSE', 's']]);
  });
});

describe('NIP-45 COUNT', () => {
  test('counts matching events', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    for (let i = 0; i < 3; i++) await h.publish(c, h.event(k));
    await h.publish(c, h.event(makeKey()));
    c.take();
    await h.send(c, ['COUNT', 'q', { authors: [k.pk] }]);
    expect(c.take()).toEqual([['COUNT', 'q', { count: 3 }]]);
  });

  test('marks approximate counts', async () => {
    const store = new MemoryEventStore();
    Object.defineProperty(store, 'capabilities', { value: { search: true, exactCount: false } });
    const h = await setup({ ports: { events: store } });
    const c = await h.connect();
    c.take();
    await h.send(c, ['COUNT', 'q', {}]);
    expect(c.take()).toEqual([['COUNT', 'q', { count: 0, approximate: true }]]);
  });
});

describe('NIP-50 search', () => {
  test('passes search to a capable store', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const hit = h.event(k, { content: 'Bitcoin and nostr' });
    await h.publish(c, hit);
    await h.publish(c, h.event(k, { content: 'something else' }));
    expect(eventsOf(await h.req(c, 's', { search: 'nostr' }))).toEqual([hit]);
    // Live matching applies the search terms too.
    const w = await h.connect();
    const live = h.event(k, { content: 'more nostr' });
    await h.publish(w, h.event(k, { content: 'unrelated' }));
    await h.publish(w, live);
    expect(eventsOf(c.take())).toEqual([live]);
  });

  test('CLOSED unsupported when the store cannot search', async () => {
    const store: EventStore = new MemoryEventStore();
    Object.defineProperty(store, 'capabilities', { value: { search: false, exactCount: true } });
    const h = await setup({ ports: { events: store } });
    const c = await h.connect();
    const frames = await h.req(c, 's', { search: 'x' });
    expect(frames).toEqual([['CLOSED', 's', 'unsupported: search is not supported by this relay']]);
  });
});

describe('NIP-62 right to vanish', () => {
  test('deletes everything by the author and blocks older re-publishing', async () => {
    const h = await setup();
    const deleted = h.record('event.deleted');
    const c = await h.connect();
    const k = makeKey();
    const other = makeKey();
    const now = h.ports.clock.now();
    const old = h.event(k, { created_at: now - 100 });
    await h.publish(c, old);
    await h.publish(c, h.event(k, { kind: 0, created_at: now - 50 }));
    const keep = h.event(other);
    await h.publish(c, keep);
    const vanish = h.event(k, { kind: 62, tags: [['relay', 'wss://relay.test']] });
    expect((await h.publish(c, vanish))[2]).toBe(true);
    expect(deleted.at(-1)).toMatchObject({ cause: 'nip62' });
    expect(eventsOf(await h.req(c, 'a', { authors: [k.pk] }))).toEqual([]);
    expect(eventsOf(await h.req(c, 'b', { authors: [other.pk] }))).toEqual([keep]);
    const again = h.event(k, { created_at: now - 10 });
    expect((await h.publish(c, again))[3]).toBe('blocked: this event has been deleted');
  });

  test('ALL_RELAYS is honored; other relays are refused', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const wrong = h.event(k, { kind: 62, tags: [['relay', 'wss://elsewhere.example']] });
    expect((await h.publish(c, wrong))[2]).toBe(false);
    const all = h.event(k, { kind: 62, tags: [['relay', 'ALL_RELAYS']] });
    expect((await h.publish(c, all))[2]).toBe(true);
  });

  test('vanish is honored even when posting is restricted', async () => {
    const h = await setup({ relay: { access: { mode: 'allowlist' } } });
    const c = await h.connect();
    const k = makeKey();
    const vanish = h.event(k, { kind: 62, tags: [['relay', 'ALL_RELAYS']] });
    expect((await h.publish(c, vanish))[2]).toBe(true);
  });
});

describe('NIP-70 protected events', () => {
  test('require AUTH as the author', async () => {
    const h = await setup();
    const c = await h.connect();
    const author = makeKey();
    const ev = h.event(author, { tags: [['-']] });
    const noAuth = await h.publish(c, ev);
    expect(noAuth[3]).toBe('auth-required: this event may only be published by its author');
    await h.auth(c, makeKey());
    const wrong = await h.publish(c, h.event(author, { tags: [['-']] }));
    expect(String(wrong[3])).toStartWith('restricted:');
    await h.auth(c, author);
    expect((await h.publish(c, h.event(author, { tags: [['-']] })))[2]).toBe(true);
  });
});

describe('reports (NIP-56 kind 1984)', () => {
  test('emit report.received', async () => {
    const h = await setup();
    const reports = h.record('report.received');
    const c = await h.connect();
    const r = h.event(makeKey(), { kind: 1984, tags: [['p', 'b'.repeat(64), 'spam']] });
    await h.publish(c, r);
    expect(reports).toEqual([{ relayId: 'main', report: r }]);
  });
});

test('relayInfo omits created_at_lower_limit when unbounded', () => {
  const doc = relayInfo(
    {
      id: 'x',
      hosts: ['x'],
      info: { name: 'n', description: '' },
      access: { mode: 'open', authRequired: { read: false, write: false } },
    } as never,
    {
      maxEventBytes: 1,
      maxSubscriptions: 1,
      maxFilters: 1,
      maxLimit: 1,
      eventsPerMinute: 1,
      reqPerMinute: 1,
      minPowDifficulty: 0,
      newKeyPowDifficulty: 0,
      maxCreatedAtFutureSeconds: 1,
      maxCreatedAtPastSeconds: 0,
      blockedKinds: [],
      spamThreshold: 1,
      maxBlobBytes: 1,
      defaultBlobQuotaBytes: 1,
      overridden: [],
    },
    { search: false, exactCount: true },
    {
      negentropy: { enabled: true },
      groups: { enabled: false },
      software: 's',
      version: 'v',
      maxMessageBytes: 1,
    } as never,
  );
  expect(doc.limitation.created_at_lower_limit).toBeUndefined();
  expect(doc.supported_nips).toContain(77);
});
