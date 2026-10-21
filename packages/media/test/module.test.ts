// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AppEvents, Principal } from '@beamhop/core';
import {
  MATCHES,
  type MediaService,
  PENDING,
  VARIANTS,
  VARIANT_OF,
  VARIANT_OWNER,
  type VariantRecord,
  type VariantsResponse,
} from '../src/index.ts';
import {
  FakeProcessor,
  loadSharp,
  setup,
  sha,
  sharpProcessor,
  stubFetch,
  syntheticImage,
} from './helpers.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'test-hashes.txt');
const LIST_URL = 'https://lists.example/blocked.txt';
const enc = (s: string) => new TextEncoder().encode(s);
const admin: Principal = { id: 'test-admin', roles: { '*': 'owner' }, via: 'cli' };
const media = (s: { kernel: { use<T>(n: string): T | undefined } }) =>
  s.kernel.use<MediaService>('media') as MediaService;

/** Hash list containing the fake processor's pHash of `bytes`. */
async function listFor(...bytes: Uint8Array[]): Promise<string> {
  const lines = await Promise.all(bytes.map(async (b) => (await sha(b)).slice(0, 16)));
  return `# test list\n${lines.join('\n')}\n`;
}

describe('abuse scanning', () => {
  test('a listed upload is quarantined, never served, notified and audited', async () => {
    const bad = enc('pretend this is a bad picture');
    const good = enc('a perfectly fine picture');
    const proc = new FakeProcessor();
    const s = await setup({
      blossom: { scanning: { lists: [LIST_URL] }, optimize: { thumbnails: false, resize: false } },
      module: { processor: proc, fetch: stubFetch({ [LIST_URL]: await listFor(bad) }) },
    });
    const quarantined: AppEvents['blob.quarantined'][] = [];
    const audit: AppEvents['admin.action'][] = [];
    s.kernel.bus.on('blob.quarantined', (e) => quarantined.push(e));
    s.kernel.bus.on('admin.action', (e) => audit.push(e));

    const badSha = await sha(bad);
    expect((await s.upload(bad)).status).toBe(200);
    expect((await s.upload(good)).status).toBe(200);
    // GET waits for the in-flight scan, then refuses.
    const res = await s.req(`/${badSha}`);
    expect(res.status).toBe(403);
    await media(s).queue.onIdle();
    expect((await s.req(`/${await sha(good)}`)).status).toBe(200);
    expect((await s.req(`/${badSha}`)).status).toBe(403);

    expect(quarantined).toEqual([
      { relayId: 'main', sha256: badSha, reason: 'Matched a known-abuse image list' },
    ]);
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0]).toMatchObject({ severity: 'critical', relayId: 'main' });
    expect(audit[0]).toMatchObject({ actionId: 'media.scan-match', principalId: 'system:media' });
    const matches = await s.ports.docs.list(MATCHES);
    expect(matches.items).toHaveLength(1);
    expect(matches.items[0]?.value).toMatchObject({
      sha256: badSha,
      distance: 0,
      source: LIST_URL,
    });
    // pending markers are cleared
    expect((await s.ports.docs.list(PENDING)).items).toHaveLength(0);

    // listed via the read-only action
    const listed = await s.kernel.actions
      .get('media.list-matches')
      ?.run({ limit: 10 }, { principal: admin, relayId: 'main', ports: s.ports });
    expect((listed?.output as { items: unknown[] }).items).toHaveLength(1);
  });

  test('downloads are held while a scan is still running', async () => {
    const bad = enc('slow bad picture');
    const proc = new FakeProcessor();
    let release!: () => void;
    proc.gate = new Promise((r) => {
      release = r;
    });
    const s = await setup({
      blossom: { scanning: { lists: [LIST_URL] }, optimize: { thumbnails: false, resize: false } },
      media: { scanWaitMs: 20 },
      module: { processor: proc, fetch: stubFetch({ [LIST_URL]: '0000000000000000' }) },
    });
    const h = await sha(bad);
    await s.upload(bad);
    const held = await s.req(`/${h}`);
    expect(held.status).toBe(403);
    expect(held.headers.get('x-reason')).toBe('This file is unavailable');
    expect((await s.ports.docs.list(PENDING)).items.map((i) => i.key)).toEqual([`main:${h}`]);
    release();
    await media(s).queue.onIdle();
    expect((await s.req(`/${h}`)).status).toBe(200);
  });

  test('no lists configured → hashes are recorded but serving is not gated', async () => {
    const proc = new FakeProcessor();
    const s = await setup({
      blossom: { optimize: { thumbnails: false, resize: false } },
      module: { processor: proc },
    });
    const img = enc('img');
    await s.upload(img);
    expect(media(s).pending.size).toBe(0);
    await media(s).queue.onIdle();
    expect(await s.ports.docs.get('media.hashes', await sha(img))).toMatchObject({
      phash: (await sha(img)).slice(0, 16),
      width: 2000,
    });
  });

  test('rescan action quarantines after a list update; local list files work', async () => {
    const lists: Record<string, string> = { [LIST_URL]: '0000000000000000' };
    const s = await setup({
      blossom: { scanning: { lists: [FIXTURE] }, optimize: { thumbnails: false, resize: false } },
      module: { processor: new FakeProcessor(), fetch: stubFetch(lists) },
    });
    const img = enc('later listed');
    const h = await sha(img);
    await s.upload(img);
    await media(s).queue.onIdle();
    expect((await s.req(`/${h}`)).status).toBe(200);
    expect(
      media(s)
        .lists.status()
        .map((l) => [l.source, l.entries.length]),
    ).toEqual([[FIXTURE, 2]]);
    // A list update now contains this image.
    lists[LIST_URL] = await listFor(img);
    const cfg = s.kernel.config();
    await s.kernel.applyConfig({
      ...cfg,
      relays: cfg.relays.map((r) => ({
        ...r,
        blossom: { ...r.blossom, scanning: { enabled: true, lists: [FIXTURE, LIST_URL] } },
      })),
    });
    await media(s).refreshLists();
    const action = s.kernel.actions.get('media.rescan');
    const ctx = { principal: admin, relayId: 'main', ports: s.ports };
    expect(await action?.preview?.({ sha256: h }, ctx)).toHaveLength(1);
    const r = await action?.run({ sha256: h }, ctx);
    expect((r?.output as { matched: boolean }).matched).toBe(true);
    expect((await s.req(`/${h}`)).status).toBe(403);
  });

  test('real pixels: a near-duplicate of a listed synthetic image is blocked', async () => {
    const sharp = await loadSharp();
    const proc = await sharpProcessor();
    if (!sharp || !proc) {
      console.warn('[media tests] sharp missing: skipping real-pixel quarantine test');
      return;
    }
    const s = await setup({
      blossom: { scanning: { lists: [FIXTURE] }, optimize: { thumbnails: false, resize: false } },
      module: { processor: proc },
    });
    const near = await syntheticImage(sharp, 1, {
      width: 300,
      height: 300,
      format: 'jpeg',
      quality: 70,
    });
    const fine = await syntheticImage(sharp, 2);
    await s.upload(near, 'image/jpeg');
    await s.upload(fine);
    await media(s).queue.onIdle();
    expect((await s.req(`/${await sha(near)}`)).status).toBe(403);
    expect((await s.req(`/${await sha(fine)}`)).status).toBe(200);
  });
});

describe('variants', () => {
  test('thumbnail + responsive sizes are stored as blobs, recorded and served', async () => {
    const proc = new FakeProcessor();
    const s = await setup({ module: { processor: proc } });
    const img = enc('a photo');
    const h = await sha(img);
    await s.upload(img, 'image/jpeg');
    await media(s).queue.onIdle();
    const rec = await s.ports.docs.get<VariantRecord>(VARIANTS, h);
    expect(rec?.variants.map((v) => [v.role, v.width])).toEqual([
      ['thumbnail', 320],
      ['responsive', 640],
      ['responsive', 1280],
    ]);
    expect(rec?.blurhash).toBeDefined();
    for (const v of rec?.variants ?? []) {
      expect(await s.ports.blobs.head(v.sha256)).toMatchObject({ type: 'image/webp' });
      const owners = await s.ports.blobIndex.owners('main', v.sha256);
      expect(owners.map((o) => o.pubkey)).toEqual([VARIANT_OWNER]);
      expect(await s.ports.docs.get(VARIANT_OF, v.sha256)).toEqual({ original: h });
      const got = await s.req(`/${v.sha256}.webp`);
      expect(got.status).toBe(200);
    }
    // Variants don't count against the uploader's quota.
    expect(await s.ports.blobIndex.usage('main', 'anonymous')).toBe(img.length);

    const res = await s.req(`/${h}/variants`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as VariantsResponse;
    expect(body.status).toBe('ready');
    expect(body.url).toBe(`https://media.example.com/${h}.jpg`);
    expect(body.dim).toBe('2000x1000');
    expect(body.variants).toHaveLength(3);
    expect(body.imeta).toContain(`x ${h}`);
    expect(body.imeta).toContain('dim 2000x1000');
    expect(body.imeta.find((t) => t.startsWith('thumb '))).toBe(`thumb ${body.variants[0]?.url}`);
    expect(body.imeta.find((t) => t.startsWith('image '))).toBe(`image ${body.variants[2]?.url}`);
    expect(body.variantTags[1]).toContain('dim 640x320');

    // Blossom routes are unaffected.
    expect((await s.req(`/${h}.jpg`)).status).toBe(200);
    expect((await s.req(`/${'0'.repeat(64)}/variants`)).status).toBe(404);
  });

  test('responsive copies wider than the original are skipped; off switches respected', async () => {
    const proc = new FakeProcessor();
    const s = await setup({
      blossom: { optimize: { thumbnails: false } },
      media: { sizes: [640, 4000] },
      module: { processor: proc },
    });
    const img = enc('small photo');
    await s.upload(img);
    await media(s).queue.onIdle();
    const rec = await s.ports.docs.get<VariantRecord>(VARIANTS, await sha(img));
    expect(rec?.variants.map((v) => v.width)).toEqual([640]);
    expect(proc.calls.some((c) => c.op === 'thumbnail')).toBe(false);
  });

  test('deleting the original removes its variants', async () => {
    const s = await setup({ module: { processor: new FakeProcessor() } });
    const img = enc('to be deleted');
    const h = await sha(img);
    await s.upload(img);
    await media(s).queue.onIdle();
    const rec = await s.ports.docs.get<VariantRecord>(VARIANTS, h);
    expect(rec?.variants.length).toBeGreaterThan(0);
    const blossom = s.kernel.use<{
      removeOwnership(r: string, sha: string, pk: string, cause: string): Promise<unknown>;
    }>('blossom');
    await blossom?.removeOwnership('main', h, 'anonymous', 'owner');
    // cleanup runs asynchronously off the bus event
    for (let i = 0; i < 20 && (await s.ports.docs.get(VARIANTS, h)); i++) await Bun.sleep(1);
    expect(await s.ports.docs.get(VARIANTS, h)).toBeNull();
    for (const v of rec?.variants ?? []) {
      expect(await s.ports.blobs.head(v.sha256)).toBeNull();
      expect(await s.ports.docs.get(VARIANT_OF, v.sha256)).toBeNull();
    }
  });

  test('variants of a quarantined original are not served', async () => {
    const s = await setup({ module: { processor: new FakeProcessor() } });
    const img = enc('later blocked');
    const h = await sha(img);
    await s.upload(img);
    await media(s).queue.onIdle();
    const rec = await s.ports.docs.get<VariantRecord>(VARIANTS, h);
    const v = rec?.variants[0];
    expect(v).toBeDefined();
    const blossom = s.kernel.use<{ quarantine(r: string, s: string, why: string): Promise<void> }>(
      'blossom',
    );
    await blossom?.quarantine('main', h, 'reported');
    expect((await s.req(`/${v?.sha256}`)).status).toBe(403);
    expect((await s.req(`/${h}/variants`)).status).toBe(403);
  });

  test('backpressure: a full queue skips variants without blocking uploads', async () => {
    const proc = new FakeProcessor();
    proc.supports = ['thumbnail', 'resize'];
    let release!: () => void;
    proc.gate = new Promise((r) => {
      release = r;
    });
    const s = await setup({ media: { concurrency: 1, maxQueued: 1 }, module: { processor: proc } });
    for (const n of [1, 2, 3, 4]) expect((await s.upload(enc(`photo ${n}`))).status).toBe(200);
    const stats = media(s).queue.stats();
    expect(stats.dropped).toBe(2);
    const view = (await (
      await s.req(`/${await sha(enc('photo 2'))}/variants`)
    ).json()) as VariantsResponse;
    expect(view.status).toBe('processing');
    release();
    await media(s).queue.onIdle();
    const skipped = (await (
      await s.req(`/${await sha(enc('photo 4'))}/variants`)
    ).json()) as VariantsResponse;
    expect(skipped.status).toBe('none');
    // An admin can make them later.
    const r = await s.kernel.actions
      .get('media.regenerate-variants')
      ?.run(
        { sha256: await sha(enc('photo 4')) },
        { principal: admin, relayId: 'main', ports: s.ports },
      );
    expect(r?.summary).toBe('Made 3 copies');
  });

  test('real pixels: sharp variants have real dimensions', async () => {
    const sharp = await loadSharp();
    const proc = await sharpProcessor();
    if (!sharp || !proc) {
      console.warn('[media tests] sharp missing: skipping real-pixel variants test');
      return;
    }
    const s = await setup({ module: { processor: proc } });
    const img = await syntheticImage(sharp, 5, { width: 1000, height: 500 });
    const h = await sha(img);
    await s.upload(img);
    await media(s).queue.onIdle();
    const body = (await (await s.req(`/${h}/variants`)).json()) as VariantsResponse;
    expect(body.dim).toBe('1000x500');
    expect(body.blurhash).toHaveLength(28);
    expect(body.variants.map((v) => `${v.role}:${v.dim}:${v.type}`)).toEqual([
      'thumbnail:320x320:image/webp',
      'responsive:640x320:image/webp',
    ]);
  });
});

describe('health and attention', () => {
  test('missing tools with lists configured → critical health + card', async () => {
    const s = await setup({
      blossom: { scanning: { lists: [LIST_URL] }, optimize: { transcode: true } },
      module: { fetch: stubFetch({ [LIST_URL]: '0000000000000000' }) },
    });
    const hc = s.kernel.health.find((h) => h.id === 'media.pipeline');
    const r = await hc?.run('main');
    expect(r?.status).toBe('critical');
    expect(r?.technical).toContain('bun add sharp');
    const cards = await s.kernel.cards.find((c) => c.id === 'media')?.cards('main');
    expect(cards?.map((c) => c.id)).toEqual([
      'media.scan-unavailable:main',
      'media.ffmpeg-missing:main',
    ]);
  });

  test('sharp missing but media goals want it → info card, nothing to approve; tools present → ok', async () => {
    const s = await setup();
    const cards = await s.kernel.cards.find((c) => c.id === 'media')?.cards(null);
    expect(cards?.map((c) => c.id)).toEqual(['media.sharp-missing:main']);
    const card = cards?.[0];
    expect(card?.severity).toBe('info');
    expect(card?.body).toBe(
      'Photos are stored as they are. Thumbnails need an extra component; the standard download includes it.',
    );
    expect(card?.body).not.toMatch(/sharp|libvips|node_modules/i);
    expect(card?.technical).toContain('sharp');
    expect(card?.primary).toBeUndefined();
    expect(card?.secondary).toBeUndefined();
    const ok = await setup({ module: { processor: new FakeProcessor() } });
    const r = await ok.kernel.health.find((h) => h.id === 'media.pipeline')?.run(null);
    expect(r?.status).toBe('ok');
    expect(r?.technical).toContain('tools: fake');
    expect(await ok.kernel.cards.find((c) => c.id === 'media')?.cards(null)).toEqual([]);
  });

  test('pending scans from a previous process are re-queued on start', async () => {
    const proc = new FakeProcessor();
    const s = await setup({
      blossom: { scanning: { lists: [LIST_URL] } },
      module: { processor: proc, fetch: stubFetch({ [LIST_URL]: '0000000000000000' }) },
    });
    const img = enc('interrupted');
    const h = await sha(img);
    await s.upload(img);
    await media(s).queue.onIdle();
    await s.ports.docs.put(PENDING, `main:${h}`, { type: 'image/png', at: 1 });
    await s.ports.docs.delete('media.hashes', h);
    expect(await media(s).sweepPending()).toBe(1);
    await media(s).queue.onIdle();
    expect(await s.ports.docs.get('media.hashes', h)).not.toBeNull();
    expect((await s.ports.docs.list(PENDING)).items).toHaveLength(0);
  });
});
