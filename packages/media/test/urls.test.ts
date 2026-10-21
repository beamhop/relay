// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type Principal, dispatchHttp } from '@beamhop/core';
import type { MediaService, VariantsResponse } from '../src/index.ts';
import { FakeProcessor, setup, sha } from './helpers.ts';

const admin: Principal = { id: 'test-admin', roles: { '*': 'owner' }, via: 'cli' };
const enc = (s: string) => new TextEncoder().encode(s);

type Listed = {
  items: Array<{ sha256: string; pubkey: string; url: string; thumbUrl?: string }>;
};

describe('absolute media URLs for the admin app', () => {
  test('media.list-blobs has absolute url + thumbUrl; regenerate returns absolute variants', async () => {
    const s = await setup({ module: { processor: new FakeProcessor() } });
    const img = enc('a photo for the list');
    const h = await sha(img);
    await s.upload(img, 'image/jpeg');
    await s.kernel.use<MediaService>('media')!.queue.onIdle();
    const ctx = { principal: admin, relayId: 'main', ports: s.ports };
    const list = s.kernel.actions.get('media.list-blobs')!;
    const run = async () =>
      ((await list.run(list.input.parse({}), ctx)).output as Listed).items.find(
        (i) => i.sha256 === h,
      );

    // No routed request seen yet: derived from config (hosts[0] + TLS).
    const item = await run();
    expect(item?.url).toBe(`https://media.example.com/${h}.jpg`);
    const thumb = await s.kernel.use<MediaService>('media')!.thumbnailOf(h);
    expect(thumb?.role).toBe('thumbnail');
    expect(item?.thumbUrl).toBe(`https://media.example.com/${thumb?.sha256}.webp`);

    // A request routed by the runtime teaches the relay's real public URL.
    const res = await dispatchHttp(s.kernel, new Request(`https://internal:8080/${h}.jpg`), {
      relayId: 'main',
      publicUrl: 'https://cdn.example.org/media',
      ipHash: 'x',
    });
    expect(res.status).toBe(200);
    const again = await run();
    expect(again?.url).toBe(`https://cdn.example.org/media/${h}.jpg`);
    expect(again?.thumbUrl).toBe(`https://cdn.example.org/media/${thumb?.sha256}.webp`);

    const regen = s.kernel.actions.get('media.regenerate-variants')!;
    const out = (await regen.run({ sha256: h }, ctx)).output as { view: VariantsResponse };
    expect(out.view.url).toBe(`https://cdn.example.org/media/${h}.jpg`);
    for (const v of out.view.variants) expect(v.url).toStartWith('https://cdn.example.org/media/');
    expect(out.view.imeta.find((t) => t.startsWith('thumb '))).toBe(
      `thumb ${out.view.variants[0]?.url}`,
    );
  });

  test('variants route without a runtime route still answers absolute URLs', async () => {
    const s = await setup({ module: { processor: new FakeProcessor() } });
    const img = enc('another photo');
    const h = await sha(img);
    await s.upload(img, 'image/png');
    await s.kernel.use<MediaService>('media')!.queue.onIdle();
    const body = (await (await s.req(`/${h}/variants`)).json()) as VariantsResponse;
    expect(body.url).toMatch(/^https:\/\/media\.example\.com\//);
    for (const v of body.variants) expect(v.url).toMatch(/^https:\/\//);
  });
});
