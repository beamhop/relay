// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { PolicyService } from '@beamhop/policy';
import { makeKey } from '@beamhop/testkit';
import { npub } from '../src/index.ts';
import { ORIGIN, setup } from './helpers.ts';

type H = Awaited<ReturnType<typeof setup>>;

async function addBlob(h: H, pubkey: string, body: string, uploadedAt: number) {
  const data = new TextEncoder().encode(body);
  const sha = await h.ports.crypto.sha256Hex(data);
  await h.ports.blobs.put({ sha256: sha, size: data.length, type: 'text/plain' }, data);
  await h.ports.blobIndex.addOwner({
    relayId: 'main',
    sha256: sha,
    pubkey,
    size: data.length,
    type: 'text/plain',
    uploadedAt,
  });
  return sha;
}

describe('portal sign-in (NIP-98)', () => {
  test('anonymous visitors see the sign-in page', async () => {
    const h = await setup();
    const { res, body } = await h.html('/portal');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toContain('id="login"');
  });

  test('a real signed kind 27235 event yields a session cookie', async () => {
    const h = await setup();
    const key = makeKey();
    const { res, cookie } = await h.login(key);
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Secure');
    expect(set).toContain('Path=/portal');
    expect(cookie.startsWith('bh_portal=')).toBe(true);

    const { body } = await h.html('/portal', { headers: { cookie } });
    expect(body).toContain(npub(key.pk));
    expect(body).toContain('Plan: Default');
    expect(body).toContain('posts per minute');
    expect(body).toContain('You can post here.');
    expect(body.length).toBeLessThan(30 * 1024);
  });

  test('rejects replayed challenges, wrong URL, wrong method, stale events and tampering', async () => {
    const h = await setup();
    const key = makeKey();
    const first = await h.login(key);
    expect(first.res.status).toBe(200);
    // Replay the exact same request.
    const replay = await h.request('/portal/login', {
      method: 'POST',
      headers: { authorization: `Nostr ${btoa(JSON.stringify(first.ev))}` },
      body: first.body,
    });
    expect(replay.status).toBe(401);

    expect((await h.login(key, { url: 'https://evil.test/portal/login' })).res.status).toBe(401);
    expect((await h.login(key, { method: 'GET' })).res.status).toBe(401);
    expect((await h.login(key, { skew: -600 })).res.status).toBe(401);

    const forged = await h.login(key);
    const parts = forged.cookie.split('=')[1]?.split('.') ?? [];
    const evil = `bh_portal=${parts[0]}x.${parts[1]}`;
    expect((await h.html('/portal', { headers: { cookie: evil } })).body).toContain('id="login"');
  });

  test('sessions expire', async () => {
    const h = await setup({ publicWeb: { sessionMinutes: 5 } });
    const { cookie } = await h.login(makeKey());
    h.ports.clock.advance(301);
    expect((await h.html('/portal', { headers: { cookie } })).body).toContain('id="login"');
  });

  test('a session is bound to its relay', async () => {
    const h = await setup({
      relays: [
        { id: 'main', hosts: ['relay.test'] },
        { id: 'other', hosts: ['relay.test'], pathPrefix: '/other' },
      ],
    });
    const { cookie } = await h.login(makeKey());
    const other = await h.html('/other/portal', { headers: { cookie } });
    expect(other.body).toContain('id="login"');
  });
});

describe('portal account features', () => {
  test('lists files with quota and deletes one (CSRF protected)', async () => {
    const h = await setup();
    const key = makeKey();
    const sha = await addBlob(h, key.pk, 'hello file', h.ports.clock.now());
    const { cookie } = await h.login(key);
    const page = (await h.html('/portal', { headers: { cookie } })).body;
    expect(page).toContain(sha.slice(0, 10));
    expect(page).toMatch(/10 B of [0-9.]+ GB used/);

    const bad = await h.post('/portal/files/delete', cookie, { sha256: sha, csrf: 'nope' });
    expect(bad.status).toBe(303);
    expect(bad.headers.get('location')).toBe('/portal?m=csrf');
    expect((await h.ports.blobIndex.owners('main', sha)).length).toBe(1);

    const csrf = await h.csrf(cookie);
    const ok = await h.post('/portal/files/delete', cookie, { sha256: sha, csrf });
    expect(ok.headers.get('location')).toBe('/portal?m=deleted');
    expect((await h.ports.blobIndex.owners('main', sha)).length).toBe(0);
    expect(await h.ports.blobs.head(sha)).toBeNull();
    expect((await h.html('/portal?m=deleted', { headers: { cookie } })).body).toContain(
      'File deleted.',
    );
  });

  test('cross-origin form posts are refused', async () => {
    const h = await setup();
    const key = makeKey();
    const { cookie } = await h.login(key);
    const csrf = await h.csrf(cookie);
    const res = await h.request('/portal/logout', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://evil.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }).toString(),
    });
    expect(res.headers.get('location')).toBe('/portal?m=csrf');
  });

  test('exports events and blob list as NDJSON', async () => {
    const h = await setup();
    const key = makeKey();
    const other = makeKey();
    const mine = [h.event(key, { content: 'one' }), h.event(key, { content: 'two', kind: 7 })];
    for (const e of mine) await h.ports.events.save('main', e);
    await h.ports.events.save('main', h.event(other, { content: 'not mine' }));
    const sha = await addBlob(h, key.pk, 'export me', h.ports.clock.now());
    const { cookie } = await h.login(key);

    const res = await h.request('/portal/export', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as { type: string; event?: { id: string }; sha256?: string; url?: string },
      );
    expect(lines[0]?.type).toBe('meta');
    const events = lines.filter((l) => l.type === 'event').map((l) => l.event?.id);
    expect(events.sort()).toEqual(mine.map((e) => e.id).sort());
    const blobs = lines.filter((l) => l.type === 'blob');
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.sha256).toBe(sha);
    expect(blobs[0]?.url).toBe(`${ORIGIN}/${sha}`);

    expect((await h.request('/portal/export')).status).toBe(303);
  });

  test('right to vanish needs a signed kind 62 request and removes everything', async () => {
    const h = await setup();
    const key = makeKey();
    for (const c of ['a', 'b', 'c'])
      await h.ports.events.save('main', h.event(key, { content: c }));
    const sha = await addBlob(h, key.pk, 'bye', h.ports.clock.now());
    const { cookie } = await h.login(key);
    const csrf = await h.csrf(cookie);

    // Missing signature → nothing happens.
    const unsigned = await h.post('/portal/vanish', cookie, { csrf, confirm: 'DELETE', event: '' });
    expect(unsigned.headers.get('location')).toBe('/portal?m=vanish-bad');
    // Someone else's request → refused.
    const foreign = h.event(makeKey(), { kind: 62, tags: [['relay', 'wss://relay.test']] });
    const r1 = await h.post('/portal/vanish', cookie, {
      csrf,
      confirm: 'DELETE',
      event: JSON.stringify(foreign),
    });
    expect(r1.headers.get('location')).toBe('/portal?m=vanish-bad');
    // Wrong relay → refused.
    const elsewhere = h.event(key, { kind: 62, tags: [['relay', 'wss://elsewhere.test']] });
    const r2 = await h.post('/portal/vanish', cookie, {
      csrf,
      confirm: 'DELETE',
      event: JSON.stringify(elsewhere),
    });
    expect(r2.headers.get('location')).toBe('/portal?m=vanish-bad');
    expect(await h.ports.events.count('main', [{ authors: [key.pk] }])).toBe(3);

    const req = h.event(key, { kind: 62, tags: [['relay', 'wss://relay.test/']] });
    const ok = await h.post('/portal/vanish', cookie, {
      csrf,
      confirm: 'DELETE',
      event: JSON.stringify(req),
    });
    expect(ok.headers.get('location')).toBe('/portal?m=vanished&e=3&f=1');
    expect(await h.ports.events.count('main', [{ authors: [key.pk] }])).toBe(0);
    expect((await h.ports.blobIndex.owners('main', sha)).length).toBe(0);
    const log = await h.ports.docs.get<{ request: { id: string } }>(
      'public.vanish',
      `main:${key.pk}`,
    );
    expect(log?.request.id).toBe(req.id);
    // Tombstoned: re-publishing old events is refused by the store.
    const again = await h.ports.events.save(
      'main',
      h.event(key, { created_at: req.created_at - 1 }),
    );
    expect(again.status).toBe('deleted');
  });

  test('the vanish admin action has a preview and requires users.write', async () => {
    const h = await setup();
    const key = makeKey();
    await h.ports.events.save('main', h.event(key));
    const a = h.kernel.actions.get('portal.right-to-vanish')!;
    expect(a.permission).toBe('users.write');
    expect(a.sensitive).toBe(true);
    const ctx = {
      principal: { id: 'o', roles: {}, via: 'cli' as const },
      relayId: 'main',
      ports: h.ports,
    };
    const lines = await a.preview!(a.input.parse({ pubkey: key.pk }), ctx);
    expect(lines[0]?.text).toContain('1 posts and 0 files');
  });

  test('invite redemption through the policy service', async () => {
    const h = await setup({ relay: { access: { mode: 'allowlist' } } });
    const policy = h.kernel.use<PolicyService>('policy')!;
    await policy.state.createInvite('main', {
      code: 'WELCOME1',
      createdAt: h.ports.clock.now(),
      expiresAt: h.ports.clock.now() + 3600,
      maxUses: 1,
      uses: 0,
      by: 'owner',
      redeemedBy: [],
    });
    const key = makeKey();
    const { cookie } = await h.login(key);
    const before = (await h.html('/portal?invite=WELCOME1', { headers: { cookie } })).body;
    expect(before).toContain('value="WELCOME1"');
    expect(before).toContain('You can read, but cannot post yet.');

    const csrf = await h.csrf(cookie);
    const bad = await h.post('/portal/invite', cookie, { csrf, code: 'NOPE' });
    expect(bad.headers.get('location')).toBe('/portal?m=invite-unknown');
    const ok = await h.post('/portal/invite', cookie, { csrf, code: 'WELCOME1' });
    expect(ok.headers.get('location')).toBe('/portal?m=invite-ok');
    const after = (await h.html('/portal?m=invite-ok', { headers: { cookie } })).body;
    expect(after).toContain('Welcome! You can now post here.');
    expect(after).toContain('You can post here.');

    const second = await h.login(makeKey());
    const csrf2 = await h.csrf(second.cookie);
    const used = await h.post('/portal/invite', second.cookie, { csrf: csrf2, code: 'WELCOME1' });
    expect(used.headers.get('location')).toBe('/portal?m=invite-used-up');
  });

  test('sign out clears the cookie', async () => {
    const h = await setup();
    const { cookie } = await h.login(makeKey());
    const csrf = await h.csrf(cookie);
    const res = await h.post('/portal/logout', cookie, { csrf });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('bh_portal=;');
  });
});
