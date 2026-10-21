// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeEvent, makeKey } from '@beamhop/testkit';
import { HibernatableConnection, connStorageKey } from '../src/connection.ts';
import { FakeWebSocket, setup, tick, upgradeRequest } from './fakes.ts';

async function connect(ctx: ReturnType<typeof setup>, url = 'https://alpha.example/') {
  const res = await ctx.runtime.worker.fetch(
    upgradeRequest(url, { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'test-client' }),
    ctx.env,
  );
  expect(res.headers.get('x-upgraded')).toBe('1');
  const name = ctx.ns.requests.at(-1)?.name as string;
  const state = ctx.ns.states.get(name);
  const ws = state?.sockets.at(-1) as FakeWebSocket;
  return { name, ws, room: ctx.ns.instance(name) };
}

describe('RelayRoom hibernation', () => {
  test('subscriptions, auth and challenge survive hibernation', async () => {
    const ctx = setup();
    const a = await connect(ctx);
    const challenge = (a.ws.frames()[0] as [string, string])[1];
    await a.room.webSocketMessage(a.ws, JSON.stringify(['AUTH', 'pk-alice']));
    await a.room.webSocketMessage(a.ws, JSON.stringify(['REQ', 'notes', { kinds: [1] }]));
    await tick(); // the handler registers the sub after an async hop
    await a.room.core.flush();

    const att = a.ws.deserializeAttachment() as Record<string, unknown>;
    expect(att.authed).toEqual(['pk-alice']);
    expect(att.challenge).toBe(challenge);
    expect(att.ipHash).not.toContain('203.0.113.9');

    // Hibernate: the object and its kernel are dropped, sockets + attachments remain.
    ctx.ns.hibernate(a.name);
    const woke = ctx.ns.instance(a.name);
    await woke.core.ready;
    expect(woke.core.conns.size).toBe(1);
    const conn = [...woke.core.conns.values()][0] as HibernatableConnection;
    expect([...conn.authed]).toEqual(['pk-alice']);
    expect(conn.challenge).toBe(challenge);
    expect(conn.userAgent).toBe('test-client');
    const subs = (conn.state.get('test-relay') as { subs: Map<string, unknown> }).subs;
    expect(subs).toBeInstanceOf(Map);
    expect([...subs.keys()]).toEqual(['notes']);
    expect(ctx.probe.restored).toEqual([conn.id]);

    // A second client publishes; the restored subscription receives it live.
    const b = await connect(ctx);
    const ev = makeEvent(makeKey(), { kind: 1 });
    await woke.webSocketMessage(b.ws, JSON.stringify(['EVENT', ev]));
    await tick();
    const got = a.ws.frames().filter((f) => (f as unknown[])[0] === 'EVENT');
    expect(got).toEqual([['EVENT', 'notes', ev]]);
  });

  test('Connection.country comes from cf-ipcountry and survives hibernation', async () => {
    const ctx = setup();
    const res = await ctx.runtime.worker.fetch(
      upgradeRequest('https://alpha.example/', { 'cf-ipcountry': 'jp' }),
      ctx.env,
    );
    expect(res.headers.get('x-upgraded')).toBe('1');
    const name = ctx.ns.requests.at(-1)?.name as string;
    const room = ctx.ns.instance(name);
    const conn = [...room.core.conns.values()][0] as HibernatableConnection;
    expect(conn.country).toBe('JP');
    ctx.ns.hibernate(name);
    const woke = ctx.ns.instance(name);
    await woke.core.ready;
    expect(([...woke.core.conns.values()][0] as HibernatableConnection).country).toBe('JP');
  });

  test('large state spills to storage and is restored', async () => {
    const ctx = setup();
    const a = await connect(ctx);
    await a.room.webSocketMessage(a.ws, JSON.stringify(['BIG', 5000]));
    await a.room.core.flush();
    const att = a.ws.deserializeAttachment() as { ext?: boolean; id: string };
    expect(att.ext).toBe(true);
    const state = ctx.ns.states.get(a.name);
    expect(typeof state?.storage.data.get(connStorageKey(att.id))).toBe('string');

    ctx.ns.hibernate(a.name);
    const woke = ctx.ns.instance(a.name);
    await woke.core.ready;
    const conn = [...woke.core.conns.values()][0] as HibernatableConnection;
    expect((conn.state.get('blob') as string).length).toBe(5000);

    // Close cleans up the spilled state.
    await woke.webSocketClose(a.ws, 1000, 'bye');
    expect(state?.storage.data.has(connStorageKey(att.id))).toBe(false);
    expect(woke.core.conns.size).toBe(0);
  });

  test('state persists after async work via send() without explicit flush', async () => {
    const ctx = setup({
      room: {
        createPair: () => ({ client: {}, server: new FakeWebSocket() }),
        upgradeResponse: () => new Response(null, { status: 200, headers: { 'x-upgraded': '1' } }),
      },
    });
    const a = await connect(ctx);
    await a.room.webSocketMessage(a.ws, JSON.stringify(['REQ', 's1', { kinds: [7] }]));
    await tick();
    await tick();
    await a.room.core.flush();
    const att = a.ws.deserializeAttachment() as { state: string };
    expect(att.state).toContain('s1');
  });

  test('CLOSE persists state so hibernation does not resurrect the subscription', async () => {
    const ctx = setup();
    const a = await connect(ctx);
    await a.room.webSocketMessage(a.ws, JSON.stringify(['REQ', 'gone', { kinds: [1] }]));
    await tick();
    await a.room.core.flush();
    expect((a.ws.deserializeAttachment() as { state: string }).state).toContain('gone');

    // The message-level flush runs before the handler's async CLOSE work lands.
    await a.room.webSocketMessage(a.ws, JSON.stringify(['CLOSE', 'gone']));
    await a.room.core.flush();
    await tick();
    // The state write itself marked the connection dirty (no frame was sent).
    await a.room.core.flush();
    expect((a.ws.deserializeAttachment() as { state: string }).state).not.toContain('gone');

    ctx.ns.hibernate(a.name);
    const woke = ctx.ns.instance(a.name);
    await woke.core.ready;
    const conn = [...woke.core.conns.values()][0] as HibernatableConnection;
    const subs = (conn.state.get('test-relay') as { subs: Map<string, unknown> }).subs;
    expect([...subs.keys()]).toEqual([]);
  });

  test('cross-shard fan-out delivers events to the other shard', async () => {
    const ctx = setup({ env: { RELAY_SHARDS: '2' } });
    const sockets: Array<{ name: string; ws: FakeWebSocket }> = [];
    // Connect until both shards have a client (shard choice is random).
    for (let i = 0; i < 64 && new Set(sockets.map((s) => s.name)).size < 2; i++) {
      const c = await connect(ctx);
      sockets.push(c);
    }
    const s0 = sockets.find((s) => s.name === 'alpha#0') as { ws: FakeWebSocket };
    const s1 = sockets.find((s) => s.name === 'alpha#1') as { ws: FakeWebSocket };
    expect(s0 && s1).toBeTruthy();
    const r0 = ctx.ns.instance('alpha#0');
    const r1 = ctx.ns.instance('alpha#1');
    await r1.webSocketMessage(s1.ws, JSON.stringify(['REQ', 'x', { kinds: [1] }]));
    await tick();
    const ev = makeEvent(makeKey(), { kind: 1 });
    await r0.webSocketMessage(s0.ws, JSON.stringify(['EVENT', ev]));
    await tick();
    await tick();
    expect(s1.ws.frames()).toContainEqual(['EVENT', 'x', ev]);
    // Only the other shard of the same relay was contacted, never beta.
    const forwarded = ctx.ns.requests.filter((r) => r.url.endsWith('/__beamhop/pubsub'));
    expect(forwarded.map((r) => r.name)).toEqual(['alpha#1']);
  });

  test('non-upgrade requests to a room are refused; pubsub to an unbooted room is a no-op', async () => {
    const ctx = setup();
    const room = ctx.ns.instance('alpha#0');
    expect((await room.fetch(new Request('https://x/'))).status).toBe(426);
    const res = await room.fetch(
      new Request('https://beamhop.internal/__beamhop/pubsub', {
        method: 'POST',
        body: JSON.stringify({ channel: 'events:alpha', message: {}, from: 'worker' }),
      }),
    );
    expect(res.status).toBe(204);
  });

  test('restore() tolerates a socket without attachment', () => {
    expect(HibernatableConnection.isAttachment(null)).toBe(false);
    expect(HibernatableConnection.isAttachment({ v: 1, id: 'a', relayId: 'r' })).toBe(true);
  });
});
