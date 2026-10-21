// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { defineModule } from '@beamhop/core';
import { type AuditEntry, COL } from '../src/index.ts';
import { seqKey } from '../src/util.ts';
import { NODE, ORIGIN, RELAY, addMember, bootClaimed, call, makeKey, nip98 } from './helpers.ts';

async function rpc(
  env: Awaited<ReturnType<typeof bootClaimed>>,
  url: string,
  key: { sk: string; pk: string },
  method: string,
  params: unknown[] = [],
) {
  const body = JSON.stringify({ method, params });
  const auth = await nip98(env.ports, key, url, 'POST', body);
  return call(env.kernel, 'POST', url, {
    raw: body,
    headers: { authorization: auth, 'content-type': 'application/nostr+json+rpc' },
  });
}

describe('NIP-86', () => {
  test('methods map onto registry actions; unknown ones are unsupported', async () => {
    const env = await bootClaimed();
    const url = `${RELAY()}/nip86`;
    const sm = await rpc(env, url, env.owner, 'supportedmethods');
    expect(sm.status).toBe(200);
    expect(sm.json.error).toBeNull();
    expect(sm.json.result).toContain('banpubkey');
    expect(sm.json.result).toContain('listbannedpubkeys');
    expect(sm.json.result).toContain('changerelayname');
    expect(sm.json.result).not.toContain('blockip');

    const target = makeKey().pk;
    const ban = await rpc(env, url, env.owner, 'banpubkey', [target, 'spam']);
    expect(ban.json).toEqual({ result: true, error: null });
    expect(env.banned.get('main')?.has(target)).toBe(true);
    const list = await rpc(env, url, env.owner, 'listbannedpubkeys');
    expect(list.json.result).toEqual([{ pubkey: target, reason: '' }]);

    const un = await rpc(env, url, env.owner, 'blockip', ['1.2.3.4']);
    expect(un.json).toEqual({ result: null, error: 'unsupported method: blockip' });

    const name = await rpc(env, url, env.owner, 'changerelayname', ['Night Owls']);
    expect(name.json.result).toBe(true);
    expect(env.kernel.relay('main')?.info.name).toBe('Night Owls');

    // Audited like any other action.
    const act = await call(env.kernel, 'GET', `${RELAY()}/activity`, { token: env.ownerToken });
    const texts = act.json.items.map((i: { text: string }) => i.text);
    expect(texts).toContain(`Ayşe banned ${target.slice(0, 8)}`);
  });

  test('auth: NIP-98 required, admins only, permissions enforced', async () => {
    const env = await bootClaimed();
    const url = `${RELAY()}/nip86`;
    const noAuth = await call(env.kernel, 'POST', url, {
      raw: JSON.stringify({ method: 'supportedmethods', params: [] }),
      headers: { 'content-type': 'application/nostr+json+rpc' },
    });
    expect(noAuth.status).toBe(401);
    const stranger = await rpc(env, url, makeKey(), 'supportedmethods');
    expect(stranger.status).toBe(401);
    const viewer = await addMember(env, 'viewer');
    const denied = await rpc(env, url, viewer.key, 'banpubkey', [makeKey().pk]);
    expect(denied.json.result).toBeNull();
    expect(denied.json.error).toContain('permission');
    // Payload hash must match the body.
    const body = JSON.stringify({ method: 'supportedmethods', params: [] });
    const auth = await nip98(env.ports, env.owner, url, 'POST', '{"other":1}');
    const tampered = await call(env.kernel, 'POST', url, {
      raw: body,
      headers: { authorization: auth, 'content-type': 'application/nostr+json+rpc' },
    });
    expect(tampered.status).toBe(401);
  });

  test("also answers on the relay's own URL when the runtime set the route", async () => {
    const env = await bootClaimed();
    const { Hono } = await import('hono');
    const outer = new Hono<{
      Variables: { route: { relayId: string; publicUrl: string; ipHash: string } };
    }>();
    outer.use('*', async (c, next) => {
      c.set('route', { relayId: 'main', publicUrl: ORIGIN, ipHash: 'x' });
      await next();
    });
    outer.route('/', env.kernel.http as never);
    const url = `${ORIGIN}/`;
    const body = JSON.stringify({ method: 'supportedmethods', params: [] });
    const res = await outer.request(url, {
      method: 'POST',
      body,
      headers: {
        authorization: await nip98(env.ports, env.owner, url, 'POST', body),
        'content-type': 'application/nostr+json+rpc',
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string[] }).result).toContain('supportedmethods');
  });
});

describe('audit log', () => {
  test('hash chain verifies and detects tampering', async () => {
    const env = await bootClaimed();
    for (let i = 0; i < 3; i++)
      await call(env.kernel, 'POST', `${RELAY()}/actions/moderation.ban-pubkey`, {
        token: env.ownerToken,
        body: { input: { pubkey: makeKey().pk } },
      });
    const v = await call(env.kernel, 'GET', `${NODE}/audit/verify`, { token: env.ownerToken });
    expect(v.json).toEqual({ ok: true, count: 4 }); // claim + 3 bans
    const list = await call(env.kernel, 'GET', `${NODE}/audit?limit=2`, { token: env.ownerToken });
    expect(list.json.items.map((e: AuditEntry) => e.seq)).toEqual([4, 3]);
    expect(list.json.cursor).toBeString();
    const next = await call(env.kernel, 'GET', `${NODE}/audit?limit=2&cursor=${list.json.cursor}`, {
      token: env.ownerToken,
    });
    expect(next.json.items.map((e: AuditEntry) => e.seq)).toEqual([2, 1]);
    expect(next.json.items[1].actionId).toBe('auth.claim');

    // Concurrent appends never fork the chain.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        call(env.kernel, 'POST', `${RELAY()}/actions/moderation.ban-pubkey`, {
          token: env.ownerToken,
          body: { input: { pubkey: makeKey().pk } },
        }),
      ),
    );
    expect(
      (await call(env.kernel, 'GET', `${NODE}/audit/verify`, { token: env.ownerToken })).json,
    ).toEqual({ ok: true, count: 9 });

    const docs = env.ports.docs;
    const e2 = (await docs.get<AuditEntry>(COL.audit, seqKey(2)))!;
    await docs.put(COL.audit, seqKey(2), { ...e2, summary: 'Nothing happened' });
    const bad = await call(env.kernel, 'GET', `${NODE}/audit/verify`, { token: env.ownerToken });
    expect(bad.json).toMatchObject({ ok: false, brokenAt: 2, reason: 'entry was modified' });

    // Viewers cannot read the raw audit log.
    const viewer = await addMember(env, 'admin');
    expect((await call(env.kernel, 'GET', `${NODE}/audit`, { token: viewer.token })).status).toBe(
      403,
    );
  });

  test('activity feed: plain sentences, relay filter', async () => {
    const env = await bootClaimed();
    const pk = makeKey().pk;
    await call(env.kernel, 'POST', `${RELAY('team')}/actions/moderation.ban-pubkey`, {
      token: env.ownerToken,
      body: { input: { pubkey: pk } },
    });
    await addMember(env, 'moderator', 'main', 'Mo');
    const node = await call(env.kernel, 'GET', `${NODE}/activity`, { token: env.ownerToken });
    expect(node.json.items.map((i: { text: string }) => i.text)).toEqual([
      'Ayşe invited Mo as a moderator on relay “main”',
      `Ayşe banned ${pk.slice(0, 8)}`,
      'Ayşe claimed this server and became its owner',
    ]);
    const team = await call(env.kernel, 'GET', `${RELAY('team')}/activity`, {
      token: env.ownerToken,
    });
    expect(team.json.items).toHaveLength(1);
  });
});

async function readEvents(res: Response, count: number, timeoutMs = 2000): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const r = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((ok) =>
        setTimeout(() => ok({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (r.done) break;
    buf += dec.decode(r.value);
    let i = buf.indexOf('\n\n');
    while (i >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.includes('event:')) events.push(chunk);
      i = buf.indexOf('\n\n');
    }
  }
  await reader.cancel();
  return events;
}

describe('live channel (SSE)', () => {
  test('streams permission-filtered bus events', async () => {
    const env = await bootClaimed();
    const teamMod = await addMember(env, 'moderator', 'team');
    const ownerRes = await env.kernel.http.request(
      `${NODE}/live?events=event.rejected,report.received,admin.action`,
      {
        headers: { authorization: `Bearer ${env.ownerToken}` },
      },
    );
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.headers.get('content-type')).toContain('text/event-stream');
    const modRes = await env.kernel.http.request(
      `${RELAY('team')}/live?events=event.rejected,report.received`,
      {
        headers: { authorization: `Bearer ${teamMod.token}` },
      },
    );
    expect(modRes.status).toBe(200);

    const ownerP = readEvents(ownerRes, 4);
    const modP = readEvents(modRes, 3);
    await Promise.resolve();
    const rej = (relayId: string) => ({
      relayId,
      eventId: 'e',
      pubkey: 'p',
      kind: 1,
      reason: 'spam',
    });
    env.kernel.bus.emit('event.rejected', rej('main'));
    env.kernel.bus.emit('event.rejected', rej('team'));
    env.kernel.bus.emit('report.received', { relayId: 'team', report: { id: 'r' } as never });
    env.kernel.bus.emit('conn.open', { relayId: 'team', connId: 'c', ipHash: 'h' }); // not subscribed
    const owner = await ownerP;
    const mod = await modP;
    expect(owner[0]).toContain('event: ready');
    expect(owner.filter((e) => e.includes('event: event.rejected'))).toHaveLength(2);
    expect(owner.some((e) => e.includes('event: report.received'))).toBe(true);
    expect(mod[0]).toContain('event: ready');
    const modRej = mod.filter((e) => e.includes('event: event.rejected'));
    expect(modRej).toHaveLength(1);
    expect(modRej[0]).toContain('"relayId":"team"');
    expect(mod.some((e) => e.includes('event: report.received'))).toBe(true);

    // A viewer may not see moderation-only events.
    const viewer = await addMember(env, 'viewer');
    const vRes = await env.kernel.http.request(
      `${NODE}/live?events=report.received,event.rejected`,
      {
        headers: { authorization: `Bearer ${viewer.token}` },
      },
    );
    const vP = readEvents(vRes, 3, 300);
    await Promise.resolve();
    env.kernel.bus.emit('report.received', { relayId: 'main', report: { id: 'r' } as never });
    env.kernel.bus.emit('event.rejected', rej('main'));
    const v = await vP;
    expect(v.some((e) => e.includes('report.received') && !e.includes('ready'))).toBe(false);
    expect(v.some((e) => e.includes('event: event.rejected'))).toBe(true);
  });
});

describe('aggregates', () => {
  test('health score, batched cards, ui manifest, playbooks', async () => {
    const env = await bootClaimed([
      defineModule({
        id: 'contrib',
        register(k) {
          k.health.push(
            {
              id: 'db',
              subsystem: 'storage',
              weight: 3,
              run: async () => ({ score: 100, status: 'ok', message: 'Database is fine' }),
            },
            {
              id: 'disk',
              subsystem: 'storage',
              weight: 1,
              run: async () => ({ score: 20, status: 'warn', message: 'Disk 82% full' }),
            },
            {
              id: 'boom',
              subsystem: 'network',
              weight: 0,
              run: async () => {
                throw new Error('x');
              },
            },
          );
          const card = (id: string, batchKey?: string, severity: 'info' | 'warning' = 'info') => ({
            id,
            relayId: 'main',
            severity,
            title: `Card ${id}`,
            body: 'b',
            createdAt: 1,
            ...(batchKey ? { batchKey } : {}),
            primary: { label: 'Ban', actionId: 'moderation.ban-pubkey', input: {} },
          });
          k.cards.push(
            {
              id: 'spam',
              cards: async () => [
                card('a', 'wave'),
                card('b', 'wave', 'warning'),
                card('c', 'wave'),
              ],
            },
            { id: 'other', cards: async () => [card('d')] },
            {
              id: 'broken',
              cards: async () => {
                throw new Error('nope');
              },
            },
          );
          k.ui.push({ path: '/settings/x', title: 'X', placement: 'settings-section', chunk: 'x' });
          k.playbooks.push({
            id: 'spam-attack',
            title: 'Spam attack',
            steps: [{ title: 'Breathe', body: '…' }],
          });
        },
      }),
    ]);
    const t = env.ownerToken;
    const h = await call(env.kernel, 'GET', `${NODE}/health`, { token: t });
    expect(h.json.score).toBe(80); // (100*3 + 20*1 + 0*0) / 4
    expect(h.json.status).toBe('critical');
    expect(h.json.checks.find((c: { id: string }) => c.id === 'boom').message).toBe(
      'This check could not run',
    );
    const storage = h.json.subsystems.find((s: { subsystem: string }) => s.subsystem === 'storage');
    expect(storage).toMatchObject({ score: 80, status: 'warn', message: 'Disk 82% full' });

    const cards = await call(env.kernel, 'GET', `${RELAY()}/cards`, { token: t });
    expect(cards.json.cards).toHaveLength(2);
    const batch = cards.json.cards[0];
    expect(batch).toMatchObject({
      id: 'batch:wave',
      count: 3,
      severity: 'warning',
      primaryAllowed: true,
    });
    expect(batch.items).toHaveLength(3);
    expect(cards.json.cards[1]).toMatchObject({ id: 'd', count: 1 });

    expect((await call(env.kernel, 'GET', `${NODE}/ui`, { token: t })).json.routes[0].path).toBe(
      '/settings/x',
    );
    const pbs = await call(env.kernel, 'GET', `${NODE}/playbooks`, { token: t });
    expect(pbs.json.playbooks).toEqual([{ id: 'spam-attack', title: 'Spam attack', steps: 1 }]);
    expect(
      (await call(env.kernel, 'GET', `${NODE}/playbooks/spam-attack`, { token: t })).json.steps,
    ).toHaveLength(1);
    expect((await call(env.kernel, 'GET', `${NODE}/playbooks/nope`, { token: t })).status).toBe(
      404,
    );

    const nodes = await call(env.kernel, 'GET', `${ORIGIN}/api/v1/nodes`, { token: t });
    expect(nodes.json.nodes[0].relays.map((r: { id: string }) => r.id)).toEqual(['main', 'team']);
  });
});
