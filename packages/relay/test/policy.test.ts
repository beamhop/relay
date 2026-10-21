// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { ACCEPT, type Decision, type Kernel, defineModule, reject } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { eventsOf, setup } from './helpers.ts';

function hookModule(id: string, install: (k: Kernel) => void) {
  return defineModule({ id, register: install });
}

describe('policy outcomes', () => {
  test('reject → OK false with prefix and event.rejected with hook id', async () => {
    const h = await setup({
      modules: [
        hookModule('t', (k) =>
          k.policy.add({
            id: 'test.spam',
            priority: 200,
            onEvent: (e) =>
              e.content.includes('spam') ? reject('blocked', 'looks like spam') : ACCEPT,
          }),
        ),
      ],
    });
    const rejected = h.record('event.rejected');
    const c = await h.connect();
    const ev = h.event(makeKey(), { content: 'buy spam' });
    expect(await h.publish(c, ev)).toEqual(['OK', ev.id, false, 'blocked: looks like spam']);
    expect(rejected).toEqual([
      {
        relayId: 'main',
        eventId: ev.id,
        pubkey: ev.pubkey,
        kind: 1,
        reason: 'blocked: looks like spam',
        by: 'test.spam',
      },
    ]);
    expect(await h.ports.events.getById('main', ev.id)).toBeNull();
  });

  test('shadow → OK true but neither stored nor broadcast', async () => {
    const h = await setup({
      modules: [
        hookModule('t', (k) =>
          k.policy.add({ id: 'test.shadow', priority: 200, onEvent: () => ({ action: 'shadow' }) }),
        ),
      ],
    });
    const accepted = h.record('event.accepted');
    const reader = await h.connect();
    const writer = await h.connect();
    await h.req(reader, 's', {});
    const ev = h.event(makeKey());
    expect(await h.publish(writer, ev)).toEqual(['OK', ev.id, true, '']);
    expect(reader.take()).toEqual([]);
    expect(accepted).toEqual([]);
    expect(await h.ports.events.getById('main', ev.id)).toBeNull();
  });

  test('hold → OK true, event.held, not stored or broadcast', async () => {
    const h = await setup({
      modules: [
        hookModule('t', (k) =>
          k.policy.add({
            id: 'test.hold',
            priority: 200,
            onEvent: (): Decision => ({ action: 'hold', message: 'pending review' }),
          }),
        ),
      ],
    });
    const held = h.record('event.held');
    const reader = await h.connect();
    const writer = await h.connect();
    await h.req(reader, 's', {});
    const ev = h.event(makeKey());
    expect(await h.publish(writer, ev)).toEqual(['OK', ev.id, true, 'pending review']);
    expect(held).toEqual([
      { relayId: 'main', event: ev, by: 'test.hold', reason: 'pending review' },
    ]);
    expect(reader.take()).toEqual([]);
    expect(await h.ports.events.getById('main', ev.id)).toBeNull();
  });

  test('onConnect reject closes the connection', async () => {
    const h = await setup({
      modules: [
        hookModule('t', (k) =>
          k.policy.add({
            id: 'test.conn',
            priority: 10,
            onConnect: () => reject('blocked', 'go away'),
          }),
        ),
      ],
    });
    const opens = h.record('conn.open');
    const c = await h.connect();
    expect(c.take()).toEqual([['NOTICE', 'blocked: go away']]);
    expect(c.closedWith?.code).toBe(1008);
    expect(opens).toEqual([]);
    await h.send(c, ['REQ', 'x', {}]);
    expect(c.take()).toEqual([]);
  });

  test('onReq reject → CLOSED; onReq shadow → EOSE only', async () => {
    let mode: 'reject' | 'shadow' = 'reject';
    const h = await setup({
      modules: [
        hookModule('t', (k) =>
          k.policy.add({
            id: 'test.req',
            priority: 10,
            onReq: () => (mode === 'reject' ? reject('restricted', 'no') : { action: 'shadow' }),
          }),
        ),
      ],
    });
    const c = await h.connect();
    await h.publish(c, h.event(makeKey()));
    expect(await h.req(c, 'a', {})).toEqual([['CLOSED', 'a', 'restricted: no']]);
    mode = 'shadow';
    expect(await h.req(c, 'b', {})).toEqual([['EOSE', 'b']]);
    expect(h.engine.subscriptionCount('main')).toBe(0);
  });

  test('onAuth reject refuses the sign-in', async () => {
    const banned = makeKey();
    const h = await setup({
      modules: [
        hookModule('t', (k) =>
          k.policy.add({
            id: 'test.auth',
            priority: 10,
            onAuth: (pk) => (pk === banned.pk ? reject('blocked', 'banned') : ACCEPT),
          }),
        ),
      ],
    });
    const c = await h.connect();
    expect((await h.auth(c, banned))[3]).toBe('blocked: banned');
    expect(c.authed.size).toBe(0);
    expect((await h.auth(c, makeKey()))[2]).toBe(true);
  });

  test('policy context carries tier and connection', async () => {
    const seen: Array<{ tier?: string; connId?: string }> = [];
    const k = makeKey();
    const h = await setup({
      modules: [
        hookModule('t', (kern) => {
          kern.access.push({
            id: 'tiers',
            tierOf: async (_r, pk) => (pk === k.pk ? 'plus' : undefined),
          });
          kern.policy.add({
            id: 'test.ctx',
            priority: 300,
            onEvent: (_e, ctx) => {
              seen.push({ tier: ctx.tier, connId: ctx.conn?.id });
              return ACCEPT;
            },
          });
        }),
      ],
    });
    const c = await h.connect();
    await h.publish(c, h.event(k));
    expect(seen).toEqual([{ tier: 'plus', connId: c.id }]);
    expect(h.limitCalls).toContain('plus');
  });
});

describe('access resolvers', () => {
  test('allowlist mode without a resolver admits only the owner', async () => {
    const owner = makeKey();
    const h = await setup({ relay: { access: { mode: 'allowlist' }, info: { pubkey: owner.pk } } });
    const c = await h.connect();
    const ok = await h.publish(c, h.event(makeKey()));
    expect(ok[3]).toBe('restricted: you are not allowed to post here');
    expect((await h.publish(c, h.event(owner)))[2]).toBe(true);
  });

  test('canWrite resolver decides; first non-undefined answer wins', async () => {
    const friend = makeKey();
    const h = await setup({
      relay: { access: { mode: 'allowlist' } },
      modules: [
        hookModule('t', (k) => {
          k.access.push({ id: 'abstain', canWrite: async () => undefined });
          k.access.push({ id: 'list', canWrite: async (_r, pk) => pk === friend.pk });
          k.access.push({ id: 'never-reached', canWrite: async () => true });
        }),
      ],
    });
    const c = await h.connect();
    expect((await h.publish(c, h.event(friend)))[2]).toBe(true);
    expect((await h.publish(c, h.event(makeKey())))[2]).toBe(false);
  });

  test('canRead resolver gates REQ using the authed pubkey', async () => {
    const reader = makeKey();
    const h = await setup({
      modules: [
        hookModule('t', (k) => {
          k.access.push({ id: 'read', canRead: async (_r, pk) => pk === reader.pk });
        }),
      ],
    });
    const c = await h.connect();
    expect(await h.req(c, 's', {})).toEqual([
      ['CLOSED', 's', 'restricted: you are not allowed to read here'],
    ]);
    await h.auth(c, reader);
    expect(await h.req(c, 's', {})).toEqual([['EOSE', 's']]);
  });
});

describe('module wiring', () => {
  test('sets kernel.ws and exposes the engine', async () => {
    const h = await setup();
    expect(h.kernel.ws).toBe(h.engine);
    expect(h.kernel.isEnabled('relay')).toBe(true);
    expect(h.kernel.policy.list().map((p) => p.id)).toContain('relay.pow');
  });

  test('ConnectionHandler entry points work without awaiting', async () => {
    const h = await setup();
    const c = await h.connect();
    const k = makeKey();
    const ev = h.event(k);
    h.engine.onMessage(c, JSON.stringify(['EVENT', ev]));
    h.engine.onMessage(c, JSON.stringify(['REQ', 's', { ids: [ev.id] }]));
    for (let i = 0; i < 50 && !c.frames.some((f) => f[0] === 'EOSE'); i++) await Bun.sleep(1);
    expect(eventsOf(c.frames, 's')).toEqual([ev]);
  });
});
