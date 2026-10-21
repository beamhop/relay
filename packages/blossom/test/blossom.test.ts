// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import { type AppEvents, type MediaProcessor, finalizeEvent } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { BlossomClient } from 'blossom-client-sdk';
import { Hono } from 'hono';
import { BLOSSOM_GC_JOB, checkAuth, isPrivateHost, parseRange } from '../src/index.ts';
import {
  BASE,
  HOST,
  OTHER,
  admin,
  authEvent,
  authHeader,
  enc,
  hashOf,
  setup,
  streamOf,
} from './helpers.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PNG = enc('\x89PNG fake image bytes for testing');

async function put(
  s: Awaited<ReturnType<typeof setup>>,
  key: ReturnType<typeof makeKey>,
  data: Uint8Array,
  o: { type?: string; host?: string; headers?: Record<string, string>; x?: string[] } = {},
) {
  return s.req(
    '/upload',
    {
      method: 'PUT',
      body: data as BodyInit,
      headers: {
        authorization: authHeader(key, 'upload', { x: o.x ?? [hashOf(data)] }),
        'content-type': o.type ?? 'image/png',
        ...o.headers,
      },
    },
    o.host,
  );
}

describe('blossom-client-sdk interop (BUD-01/02/06)', () => {
  test('upload, has, download, list, delete via the official client', async () => {
    const s = await setup();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      s.kernel.http.fetch(new Request(input, init))) as typeof fetch;
    const key = makeKey();
    const signer = async (draft: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent(draft, key.sk);
    const client = new BlossomClient(BASE, signer);
    const blob = new Blob([PNG], { type: 'image/png' });

    const desc = await client.uploadBlob(blob, { auth: true });
    expect(desc.sha256).toBe(hashOf(PNG));
    expect(desc.size).toBe(PNG.length);
    expect(desc.type).toBe('image/png');
    expect(desc.url).toBe(`${BASE}/${hashOf(PNG)}.png`);

    expect(await client.hasBlob(desc.sha256)).toBe(true);
    const downloaded = await client.downloadBlob(desc.sha256);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(PNG);

    const list = await client.listBlobs(key.pk);
    expect(list.map((d) => d.sha256)).toEqual([desc.sha256]);

    expect(await client.deleteBlob(desc.sha256, { auth: true })).toBe(true);
    expect(await client.hasBlob(desc.sha256)).toBe(false);
    expect(await s.ports.blobs.head(desc.sha256)).toBeNull();
  });

  test('HEAD /upload pre-flight reports requirements (BUD-06)', async () => {
    const s = await setup({ blossom: { maxBlobBytes: 100, allowedTypes: ['image/*'] } });
    const key = makeKey();
    const head = (h: Record<string, string>) =>
      s.req('/upload', {
        method: 'HEAD',
        headers: { authorization: authHeader(key, 'upload'), ...h },
      });
    expect(
      (
        await head({
          'x-sha-256': hashOf(PNG),
          'x-content-length': '10',
          'x-content-type': 'image/png',
        })
      ).status,
    ).toBe(200);
    const big = await head({ 'x-content-length': '101' });
    expect(big.status).toBe(413);
    expect(big.headers.get('x-reason')).toContain('too large');
    expect((await head({ 'x-content-type': 'application/zip' })).status).toBe(415);
    expect((await s.req('/upload', { method: 'HEAD' })).status).toBe(401);
  });
});

describe('auth (kind 24242)', () => {
  test('rejects missing, malformed, expired, wrong verb, wrong kind, future, forged, x mismatch', async () => {
    const s = await setup();
    const key = makeKey();
    const sha = hashOf(PNG);
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string | undefined, number, string]> = [
      [undefined, 401, 'Sign-in'],
      ['Bearer abc', 401, 'Nostr'],
      ['Nostr !!!notbase64', 401, 'malformed'],
      [authHeader(key, 'upload', { x: [sha], expiration: now - 1 }), 401, 'expired'],
      [authHeader(key, 'delete', { x: [sha] }), 401, 't=upload'],
      [authHeader(key, 'upload', { x: [sha], kind: 1 }), 401, 'kind'],
      [authHeader(key, 'upload', { x: [sha], createdAt: now + 3600 }), 401, 'future'],
      [authHeader(key, 'upload', { x: ['0'.repeat(64)] }), 403, 'x tag'],
      [
        authHeader(key, 'upload', { x: [sha], server: 'https://elsewhere.example' }),
        403,
        'different server',
      ],
    ];
    for (const [header, status, reason] of cases) {
      const res = await s.req('/upload', {
        method: 'PUT',
        body: PNG,
        headers: header ? { authorization: header } : {},
      });
      expect([res.status, res.headers.get('x-reason')?.includes(reason)]).toEqual([status, true]);
    }
    // forged signature
    const ev = authEvent(key, 'upload', { x: [sha] });
    const forged = { ...ev, sig: ev.sig.replace(/^./, ev.sig[0] === 'a' ? 'b' : 'a') };
    const res = await s.req('/upload', {
      method: 'PUT',
      body: PNG,
      headers: { authorization: `Nostr ${btoa(JSON.stringify(forged))}` },
    });
    expect(res.status).toBe(401);
    expect(await s.ports.blobs.head(sha)).toBeNull();

    // matching server tag is accepted
    const ok = await s.req('/upload', {
      method: 'PUT',
      body: PNG,
      headers: { authorization: authHeader(key, 'upload', { x: [sha], server: BASE }) },
    });
    expect(ok.status).toBe(200);
  });

  test('checkAuth unit: base64url accepted', () => {
    const key = makeKey();
    const ev = authEvent(key, 'list');
    const b64url = btoa(JSON.stringify(ev))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const r = checkAuth(`Nostr ${b64url}`, 'list', { now: Math.floor(Date.now() / 1000) });
    expect(r.ok).toBe(true);
  });

  test('delete requires the x tag of the blob and ownership', async () => {
    const s = await setup();
    const owner = makeKey();
    const stranger = makeKey();
    await put(s, owner, PNG);
    const sha = hashOf(PNG);
    const del = (k: ReturnType<typeof makeKey>, x: string[]) =>
      s.req(`/${sha}`, {
        method: 'DELETE',
        headers: { authorization: authHeader(k, 'delete', { x }) },
      });
    expect((await s.req(`/${sha}`, { method: 'DELETE' })).status).toBe(401);
    expect((await del(owner, [])).status).toBe(403);
    expect((await del(stranger, [sha])).status).toBe(404);
    expect((await del(owner, [sha])).status).toBe(204);
  });
});

describe('upload integrity and limits', () => {
  test('streams with declared hash; mismatch is rejected and nothing is kept', async () => {
    const s = await setup();
    const key = makeKey();
    const wrong = hashOf(enc('something else'));
    const res = await s.req('/upload', {
      method: 'PUT',
      body: streamOf(PNG.slice(0, 5), PNG.slice(5)),
      // @ts-expect-error Bun supports duplex for streaming request bodies
      duplex: 'half',
      headers: {
        authorization: authHeader(key, 'upload', { x: [wrong] }),
        'x-sha-256': wrong,
        'content-length': String(PNG.length),
      },
    });
    expect(res.status).toBe(409);
    expect(await s.ports.blobs.head(wrong)).toBeNull();
    expect(await s.ports.blobs.head(hashOf(PNG))).toBeNull();
    expect(await s.ports.blobIndex.refCount(wrong)).toBe(0);

    const good = await s.req('/upload', {
      method: 'PUT',
      body: streamOf(PNG.slice(0, 5), PNG.slice(5)),
      // @ts-expect-error Bun supports duplex for streaming request bodies
      duplex: 'half',
      headers: {
        authorization: authHeader(key, 'upload', { x: [hashOf(PNG)] }),
        'content-length': String(PNG.length),
        'content-type': 'image/png',
      },
    });
    expect(good.status).toBe(200);
    expect((await s.ports.blobs.head(hashOf(PNG)))?.size).toBe(PNG.length);

    // Lying Content-Length: bytes never committed, ownership rolled back
    const other = enc('another file body');
    const liar = await s.req('/upload', {
      method: 'PUT',
      body: streamOf(other),
      // @ts-expect-error Bun supports duplex for streaming request bodies
      duplex: 'half',
      headers: {
        authorization: authHeader(key, 'upload', { x: [hashOf(other)] }),
        'content-length': '3',
      },
    });
    expect(liar.status).toBe(400);
    expect(await s.ports.blobs.head(hashOf(other))).toBeNull();
    expect(await s.ports.blobIndex.refCount(hashOf(other))).toBe(0);
  });

  test('buffered upload without declared hash verifies against auth x tags', async () => {
    const s = await setup();
    const key = makeKey();
    const a = enc('aaa');
    const b = enc('bbb');
    const res = await s.req('/upload', {
      method: 'PUT',
      body: streamOf(b),
      // @ts-expect-error Bun supports duplex for streaming request bodies
      duplex: 'half',
      headers: { authorization: authHeader(key, 'upload', { x: [hashOf(a), hashOf(enc('c'))] }) },
    });
    expect(res.status).toBe(403);
    expect(await s.ports.blobs.head(hashOf(b))).toBeNull();
  });

  test('max blob size from relay config, then tier', async () => {
    const s = await setup({
      blossom: { maxBlobBytes: 10 },
      relay: {
        tiers: [
          { id: 'default', name: 'Default' },
          { id: 'plus', name: 'Plus', maxBlobBytes: 1000 },
        ],
      },
    });
    const free = makeKey();
    const plus = makeKey();
    s.kernel.access.push({
      id: 'test-tiers',
      tierOf: async (_r, pk) => (pk === plus.pk ? 'plus' : undefined),
    });
    const r1 = await put(s, free, PNG);
    expect(r1.status).toBe(413);
    expect(r1.headers.get('x-reason')).toContain('too large');
    expect((await put(s, plus, PNG)).status).toBe(200);
  });

  test('quota: relay default, tier quota, admin override with preview and undo', async () => {
    const s = await setup({
      blossom: { defaultQuotaBytes: 40 },
      relay: {
        tiers: [
          { id: 'default', name: 'Default' },
          { id: 'big', name: 'Big', blobQuotaBytes: 100 },
        ],
      },
    });
    const key = makeKey();
    const f1 = enc('x'.repeat(30));
    const f2 = enc('y'.repeat(30));
    expect((await put(s, key, f1)).status).toBe(200);
    // re-upload of an owned file does not count twice
    expect((await put(s, key, f1)).status).toBe(200);
    const over = await put(s, key, f2);
    expect(over.status).toBe(413);
    expect(over.headers.get('x-reason')).toContain('quota');

    const action = s.kernel.actions.get('media.set-quota')!;
    const ctx = { principal: admin, relayId: 'main', ports: s.ports };
    const input = action.input.parse({ pubkey: key.pk, quotaBytes: 1000 });
    const preview = await action.preview!(input, ctx);
    expect(preview[0]?.text).toContain('→ 1000 B');
    const result = await action.run(input, ctx);
    expect((await put(s, key, f2)).status).toBe(200);
    await action.undo!(result.undo!.payload, ctx);
    expect((await put(s, key, enc('z'.repeat(30)))).status).toBe(413);

    // tier quota applies when no override
    s.kernel.access.push({ id: 'tiers', tierOf: async () => 'big' });
    expect((await put(s, key, enc('z'.repeat(30)))).status).toBe(200);
  });

  test('allowed types and blossom disabled', async () => {
    const s = await setup({ blossom: { allowedTypes: ['image/*'] } });
    const key = makeKey();
    expect((await put(s, key, enc('pdf'), { type: 'application/pdf' })).status).toBe(415);
    const off = await setup({ blossom: { enabled: false } });
    expect((await put(off, key, PNG)).status).toBe(404);
  });

  test('anonymous uploads when requireAuth is off', async () => {
    const s = await setup({ blossom: { requireAuth: false } });
    const res = await s.req('/upload', {
      method: 'PUT',
      body: PNG,
      headers: { 'content-type': 'image/png' },
    });
    expect(res.status).toBe(200);
    expect((await s.req(`/${hashOf(PNG)}`)).status).toBe(200);
  });
});

describe('serving (BUD-01)', () => {
  test('content-type, extension, range, suffix range, 416, HEAD, ETag', async () => {
    const s = await setup();
    const key = makeKey();
    const data = enc('0123456789abcdef');
    await put(s, key, data, { type: 'text/plain' });
    const sha = hashOf(data);

    const full = await s.req(`/${sha}.txt`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('text/plain');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('access-control-allow-origin')).toBe('*');
    expect(await full.text()).toBe('0123456789abcdef');

    const part = await s.req(`/${sha}`, { headers: { range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/16');
    expect(await part.text()).toBe('2345');

    const suffix = await s.req(`/${sha}`, { headers: { range: 'bytes=-3' } });
    expect(await suffix.text()).toBe('def');
    const open = await s.req(`/${sha}`, { headers: { range: 'bytes=14-' } });
    expect(await open.text()).toBe('ef');

    const bad = await s.req(`/${sha}`, { headers: { range: 'bytes=50-60' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */16');

    const head = await s.req(`/${sha}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('16');
    expect(await head.text()).toBe('');

    const etag = full.headers.get('etag')!;
    expect((await s.req(`/${sha}`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await s.req(`/${'f'.repeat(64)}`)).status).toBe(404);
  });

  test('octet-stream blob gets type from extension', async () => {
    const s = await setup();
    await put(s, makeKey(), PNG, { type: 'application/octet-stream' });
    const res = await s.req(`/${hashOf(PNG)}.png`);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  test('parseRange unit', () => {
    expect(parseRange('bytes=0-0', 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-0', 10)).toBeNull();
    expect(parseRange('bytes=1-2,4-5', 10)).toBeNull();
    expect(parseRange('items=1-2', 10)).toBeNull();
  });
});

describe('dedupe across relays and GC', () => {
  test('same bytes stored once; ownership per relay; bytes erased when last owner leaves', async () => {
    const s = await setup();
    const a = makeKey();
    const b = makeKey();
    const sha = hashOf(PNG);
    const deleted: Array<AppEvents['blob.deleted']> = [];
    s.kernel.bus.on('blob.deleted', (e) => deleted.push(e));
    const uploads: Array<AppEvents['blob.uploaded']> = [];
    s.kernel.bus.on('blob.uploaded', (e) => uploads.push(e));
    let puts = 0;
    const origPut = s.ports.blobs.put.bind(s.ports.blobs);
    s.ports.blobs.put = async (m, d) => {
      puts++;
      return origPut(m, d);
    };

    expect((await put(s, a, PNG)).status).toBe(200);
    // other relay can't see it before someone uploads there
    expect((await s.req(`/${sha}`, {}, OTHER)).status).toBe(404);
    const second = await put(s, b, PNG, { host: OTHER });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { url: string }).url).toBe(`https://${OTHER}/${sha}.png`);
    expect(puts).toBe(1);
    expect(await s.ports.blobIndex.refCount(sha)).toBe(2);
    expect(uploads.map((u) => u.relayId)).toEqual(['main', 'other']);

    const del = (k: ReturnType<typeof makeKey>, host: string) =>
      s.req(
        `/${sha}`,
        { method: 'DELETE', headers: { authorization: authHeader(k, 'delete', { x: [sha] }) } },
        host,
      );
    expect((await del(a, HOST)).status).toBe(204);
    expect(await s.ports.blobs.head(sha)).not.toBeNull();
    expect((await s.req(`/${sha}`)).status).toBe(404);
    expect((await s.req(`/${sha}`, {}, OTHER)).status).toBe(200);
    expect((await del(b, OTHER)).status).toBe(204);
    expect(await s.ports.blobs.head(sha)).toBeNull();
    expect(deleted.map((d) => [d.relayId, d.cause])).toEqual([
      ['main', 'owner'],
      ['other', 'owner'],
    ]);
  });

  test('scheduled GC erases orphaned bytes and expired ownerships', async () => {
    const s = await setup({ module: { gcMaxScan: 2 } });
    expect(s.ports.scheduler.jobs.has(BLOSSOM_GC_JOB)).toBe(true);
    const orphans = ['o1', 'o2', 'o3'].map(enc);
    for (const o of orphans)
      await s.ports.blobs.put({ sha256: hashOf(o), size: o.length, type: 'text/plain' }, o);
    const key = makeKey();
    await put(s, key, PNG);
    const sha = hashOf(PNG);
    const now = s.ports.clock.now();
    const own = (await s.ports.blobIndex.owners('main', sha))[0]!;
    await s.ports.blobIndex.addOwner({ ...own, expiresAt: now + 10 });

    await s.ports.scheduler.tick(BLOSSOM_GC_JOB);
    await s.ports.scheduler.tick(BLOSSOM_GC_JOB);
    for (const o of orphans) expect(await s.ports.blobs.head(hashOf(o))).toBeNull();
    expect(await s.ports.blobs.head(sha)).not.toBeNull();

    s.ports.clock.advance(60);
    await s.ports.scheduler.tick(BLOSSOM_GC_JOB);
    expect(await s.ports.blobIndex.refCount(sha)).toBe(0);
    expect(await s.ports.blobs.head(sha)).toBeNull();
  });
});

describe('legal hold', () => {
  test('held bytes survive owner delete and orphan GC until the hold is released', async () => {
    const s = await setup();
    const key = makeKey();
    const sha = hashOf(PNG);
    const orphan = enc('held orphan');
    const orphanSha = hashOf(orphan);
    const held = new Set([sha, orphanSha]);
    s.kernel.provide('lifecycle.holds', {
      active: () => true,
      isHeld: async (_r: string, subj: { sha256?: string }) => held.has(subj.sha256 ?? ''),
    });
    await s.ports.blobs.put({ sha256: orphanSha, size: orphan.length, type: 'text/plain' }, orphan);
    expect((await put(s, key, PNG)).status).toBe(200);
    const del = await s.req(`/${sha}`, {
      method: 'DELETE',
      headers: { authorization: authHeader(key, 'delete', { x: [sha] }) },
    });
    expect(del.status).toBe(204);
    // Ownership is gone (not listed / served for the owner), bytes are frozen.
    expect(await s.ports.blobIndex.refCount(sha)).toBe(0);
    expect(await s.ports.blobs.head(sha)).not.toBeNull();
    await s.ports.scheduler.tick(BLOSSOM_GC_JOB);
    expect(await s.ports.blobs.head(sha)).not.toBeNull();
    expect(await s.ports.blobs.head(orphanSha)).not.toBeNull();

    held.clear();
    await s.ports.scheduler.tick(BLOSSOM_GC_JOB);
    expect(await s.ports.blobs.head(sha)).toBeNull();
    expect(await s.ports.blobs.head(orphanSha)).toBeNull();
  });
});

describe('mirror (BUD-04)', () => {
  function remote(files: Record<string, { data: Uint8Array; type: string }>) {
    const app = new Hono();
    app.get('/:file', (c) => {
      const f = files[c.req.param('file')];
      if (!f) return c.text('nope', 404);
      return new Response(f.data as BodyInit, {
        headers: { 'content-type': f.type, 'content-length': String(f.data.length) },
      });
    });
    return async (r: Request) => app.fetch(r);
  }

  test('copies from a remote server and verifies the hash', async () => {
    const sha = hashOf(PNG);
    const evil = enc('not what you asked for');
    const s = await setup({
      module: {
        fetch: remote({
          [`${sha}.png`]: { data: PNG, type: 'image/png' },
          [`${'e'.repeat(64)}.png`]: { data: evil, type: 'image/png' },
        }),
      },
    });
    const key = makeKey();
    const mirror = (url: string, x: string[]) =>
      s.req('/mirror', {
        method: 'PUT',
        body: JSON.stringify({ url }),
        headers: {
          'content-type': 'application/json',
          authorization: authHeader(key, 'upload', { x }),
        },
      });
    const ok = await mirror(`https://cdn.remote.example/${sha}.png`, [sha]);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { sha256: string; type: string }).type).toBe('image/png');
    expect((await s.req(`/${sha}`)).status).toBe(200);

    const bad = await mirror(`https://cdn.remote.example/${'e'.repeat(64)}.png`, ['e'.repeat(64)]);
    expect(bad.status).toBe(409);
    expect(await s.ports.blobs.head(hashOf(evil))).toBeNull();

    expect((await mirror('https://cdn.remote.example/missing', [sha])).status).toBe(502);
    expect((await mirror('http://127.0.0.1/x', [sha])).status).toBe(403);
    expect((await mirror('ftp://example.com/x', [sha])).status).toBe(400);
  });

  test('mirror can be turned off', async () => {
    const s = await setup({ blossom: { mirror: false } });
    const res = await s.req('/mirror', {
      method: 'PUT',
      body: JSON.stringify({ url: 'https://x.example/a' }),
      headers: { authorization: authHeader(makeKey(), 'upload', { x: [hashOf(PNG)] }) },
    });
    expect(res.status).toBe(403);
  });

  test('isPrivateHost', () => {
    for (const h of [
      'localhost',
      '10.1.2.3',
      '192.168.0.1',
      '172.20.0.1',
      '[::1]',
      'fd00::1',
      'db.internal',
    ])
      expect(isPrivateHost(h)).toBe(true);
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(h)).toBe(false);
  });
});

describe('media (BUD-05)', () => {
  test('falls back to a plain upload without a media processor', async () => {
    const s = await setup();
    const key = makeKey();
    const res = await s.req('/media', {
      method: 'PUT',
      body: PNG,
      headers: {
        'content-type': 'image/png',
        authorization: authHeader(key, 'media', { x: [hashOf(PNG)] }),
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sha256: string }).sha256).toBe(hashOf(PNG));
    const head = await s.req('/media', {
      method: 'HEAD',
      headers: { authorization: authHeader(key, 'media'), 'x-content-type': 'image/png' },
    });
    expect(head.status).toBe(200);
  });

  test('delegates to ports.media and stores the optimized result', async () => {
    const stripped = enc('stripped png');
    const media: MediaProcessor = {
      supports: ['strip-metadata'],
      async process(_input, type, ops) {
        return ops.map((o) => ({ op: o.op, data: stripped, type }));
      },
    };
    const s = await setup({ ports: { media } });
    const key = makeKey();
    const res = await s.req('/media', {
      method: 'PUT',
      body: PNG,
      headers: {
        'content-type': 'image/png',
        authorization: authHeader(key, 'media', { x: [hashOf(PNG)] }),
      },
    });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { sha256: string; size: number };
    expect(d.sha256).toBe(hashOf(stripped));
    expect(await s.ports.blobs.head(hashOf(PNG))).toBeNull();
    expect((await s.req(`/${d.sha256}`)).status).toBe(200);

    // x tag must name the original
    const wrong = await s.req('/media', {
      method: 'PUT',
      body: PNG,
      headers: { authorization: authHeader(key, 'media', { x: [hashOf(stripped)] }) },
    });
    expect(wrong.status).toBe(403);
  });
});

describe('policy hooks', () => {
  test('onUpload reject → 403; hold → quarantined (never served); onBlobServe reject → 403', async () => {
    const s = await setup();
    const key = makeKey();
    const blocked = enc('blocked content');
    const held = enc('held content');
    const quarantined: string[] = [];
    s.kernel.bus.on('blob.quarantined', (e) => quarantined.push(e.sha256));
    s.kernel.policy.add({
      id: 'test.blocklist',
      priority: 200,
      onUpload(info) {
        if (info.sha256 === hashOf(blocked))
          return { action: 'reject', prefix: 'blocked', message: 'Known bad file' };
        if (info.sha256 === hashOf(held)) return { action: 'hold', message: 'Needs review' };
        return { action: 'accept' };
      },
    });
    const r1 = await put(s, key, blocked);
    expect(r1.status).toBe(403);
    expect(r1.headers.get('x-reason')).toBe('Known bad file');
    expect(await s.ports.blobs.head(hashOf(blocked))).toBeNull();
    expect(await s.ports.blobIndex.refCount(hashOf(blocked))).toBe(0);

    expect((await put(s, key, held)).status).toBe(200);
    expect(quarantined).toEqual([hashOf(held)]);
    expect((await s.req(`/${hashOf(held)}`)).status).toBe(403);

    expect((await put(s, key, PNG)).status).toBe(200);
    expect((await s.req(`/${hashOf(PNG)}`)).status).toBe(200);
    s.kernel.policy.add({
      id: 'test.serve',
      priority: 200,
      onBlobServe: () => ({
        action: 'reject',
        prefix: 'blocked',
        message: 'Removed by moderators',
      }),
    });
    const r = await s.req(`/${hashOf(PNG)}`);
    expect(r.status).toBe(403);
    expect(r.headers.get('x-reason')).toBe('Removed by moderators');
  });
});

describe('admin actions and health', () => {
  test('media.list-blobs and media.delete-blob with preview and undo', async () => {
    const s = await setup();
    const a = makeKey();
    const b = makeKey();
    await put(s, a, PNG);
    await put(s, b, PNG, { host: OTHER });
    const sha = hashOf(PNG);
    const ctx = { principal: admin, relayId: 'main', ports: s.ports };

    const list = s.kernel.actions.get('media.list-blobs')!;
    const listed = (await list.run(list.input.parse({}), ctx)).output as {
      items: Array<{ sha256: string }>;
    };
    expect(listed.items.map((i) => i.sha256)).toEqual([sha]);
    // Absolute URL on the relay's public URL; no thumbnail without the media module.
    expect(listed.items[0]).toMatchObject({ url: `${BASE}/${sha}.png` });
    expect(listed.items[0]).not.toHaveProperty('thumbUrl');

    const del = s.kernel.actions.get('media.delete-blob')!;
    const input = del.input.parse({ sha256: sha });
    const preview = await del.preview!(input, ctx);
    expect(preview.map((l) => l.kind)).toEqual(['remove', 'info']);
    const res = await del.run(input, ctx);
    expect(res.output).toEqual({ removed: 1, erased: false });
    expect((await s.req(`/${sha}`)).status).toBe(404);
    await del.undo!(res.undo!.payload, ctx);
    expect((await s.req(`/${sha}`)).status).toBe(200);

    // Deleting the last owner erases bytes; preview warns
    const otherCtx = { ...ctx, relayId: 'other' };
    await del.run(input, ctx);
    const p2 = await del.preview!(input, otherCtx);
    expect(p2.some((l) => l.kind === 'warning')).toBe(true);
    const r2 = await del.run(input, otherCtx);
    expect(r2.output).toEqual({ removed: 1, erased: true });
    expect(r2.undo).toBeUndefined();
    expect(await s.ports.blobs.head(sha)).toBeNull();
  });

  test('health check reports storage state', async () => {
    const s = await setup();
    const hc = s.kernel.health.find((h) => h.id === 'blossom.storage')!;
    expect((await hc.run('main')).status).toBe('ok');
    s.ports.blobs.list = async () => {
      throw new Error('disk gone');
    };
    const bad = await hc.run(null);
    expect(bad.status).toBe('critical');
    expect(bad.score).toBe(0);
  });
});
