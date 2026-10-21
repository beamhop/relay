// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * End to end: a NIP-62 request to vanish on the relay removes the person's
 * files (blossom) and their derived variants (media), on memory adapters.
 */
import { describe, expect, test } from 'bun:test';
import { type BlossomService, createBlossomModule } from '@beamhop/blossom';
import {
  type Connection,
  type NostrEvent,
  createKernel,
  defineModule,
  finalizeEvent,
  parseConfig,
} from '@beamhop/core';
import { RELAY_ENGINE_SERVICE, type RelayEngine, relayModule } from '@beamhop/relay';
import { FakeClock, type TestKey, makeKey, memoryPorts } from '@beamhop/testkit';
import {
  type MediaService,
  VARIANTS,
  type VariantRecord,
  createMediaModule,
} from '../src/index.ts';
import { BASE, FakeProcessor, HOST, sha } from './helpers.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function conn(relayId: string, openedAt: number): Connection & { frames: unknown[][] } {
  const frames: unknown[][] = [];
  return {
    id: `c${Math.random()}`,
    relayId,
    ipHash: 'iphash',
    host: HOST,
    openedAt,
    authed: new Set(),
    challenge: '',
    state: new Map(),
    frames,
    send: (f) => frames.push(JSON.parse(f)),
    bufferedAmount: () => 0,
    close: () => {},
  };
}

async function setup(held?: (pubkey?: string) => boolean) {
  const ports = memoryPorts({ clock: new FakeClock(Date.now()) });
  const modules = [
    relayModule,
    createBlossomModule(),
    createMediaModule({ processor: new FakeProcessor() }),
  ];
  if (held) {
    modules.push(
      defineModule({
        id: 'fake-holds',
        register(kernel) {
          kernel.provide('lifecycle.holds', {
            active: () => true,
            isHeld: async (_r: string, s: { pubkey?: string }) => held(s.pubkey),
          });
        },
      }),
    );
  }
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config: parseConfig({ relays: [{ id: 'main', hosts: [HOST] }], modules: { media: {} } }),
    modules,
  });
  const engine = kernel.use<RelayEngine>(RELAY_ENGINE_SERVICE)!;
  const blossom = kernel.use<BlossomService>('blossom')!;
  const media = kernel.use<MediaService>('media')!;
  const sign = (key: TestKey, kind: number, tags: string[][]): NostrEvent =>
    finalizeEvent({ kind, tags, content: '', created_at: ports.clock.now() }, key.sk);
  const upload = async (key: TestKey, data: Uint8Array) => {
    const h = await sha(data);
    const auth = sign(key, 24242, [
      ['t', 'upload'],
      ['x', h],
      ['expiration', String(ports.clock.now() + 600)],
    ]);
    const res = await kernel.http.request(`${BASE}/upload`, {
      method: 'PUT',
      body: data as BodyInit,
      headers: {
        authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
        'content-type': 'image/png',
      },
    });
    expect(res.status).toBe(200);
    await media.queue.onIdle();
    return h;
  };
  const publish = async (ev: NostrEvent) => {
    const c = conn('main', ports.clock.nowMs());
    await engine.open(c);
    await engine.handle(c, JSON.stringify(['EVENT', ev]));
    return c.frames.find((f) => f[0] === 'OK');
  };
  const vanish = async (key: TestKey) => {
    const ok = await publish(sign(key, 62, [['relay', 'ALL_RELAYS']]));
    expect(ok?.[2]).toBe(true);
    await blossom.settled();
    await media.cleanupsSettled();
  };
  const status = async (h: string) => (await kernel.http.request(`${BASE}/${h}`)).status;
  const variants = (h: string) => ports.docs.get<VariantRecord>(VARIANTS, h);
  return { kernel, ports, sign, upload, publish, vanish, status, variants };
}

describe('right to vanish removes files and media variants', () => {
  test("A vanishes: A's files and variants go, the shared file stays for B", async () => {
    const s = await setup();
    const a = makeKey();
    const b = makeKey();
    const vanished: unknown[] = [];
    s.kernel.bus.on('user.vanished', (e) => vanished.push(e));
    expect((await s.publish(s.sign(a, 1, [])))?.[2]).toBe(true);
    const own = await s.upload(a, enc('alice picture'));
    const shared = await s.upload(a, enc('shared picture'));
    await s.upload(b, enc('shared picture'));
    const ownVariants = (await s.variants(own))?.variants ?? [];
    expect(ownVariants.length).toBeGreaterThan(0);
    for (const v of ownVariants) expect(await s.status(v.sha256)).toBe(200);
    expect(await s.ports.blobIndex.usage('main', a.pk)).toBeGreaterThan(0);

    await s.vanish(a);

    expect(vanished).toEqual([
      { relayId: 'main', pubkey: a.pk, until: s.ports.clock.now(), scope: 'all' },
    ]);
    expect(await s.ports.events.query('main', [{ authors: [a.pk] }])).toEqual([]);
    expect(await s.status(own)).toBe(404);
    expect(await s.ports.blobs.head(own)).toBeNull();
    expect(await s.ports.blobIndex.usage('main', a.pk)).toBe(0);
    expect(await s.variants(own)).toBeNull();
    for (const v of ownVariants) {
      expect(await s.status(v.sha256)).toBe(404);
      expect(await s.ports.blobs.head(v.sha256)).toBeNull();
    }
    // B still owns the shared picture, so it and its variants are still served.
    expect(await s.status(shared)).toBe(200);
    const sharedVariants = (await s.variants(shared))?.variants ?? [];
    expect(sharedVariants.length).toBeGreaterThan(0);
    for (const v of sharedVariants) expect(await s.status(v.sha256)).toBe(200);
  });

  test('held files stop being served but are not destroyed', async () => {
    const a = makeKey();
    const s = await setup((pk) => pk === a.pk);
    const h = await s.upload(a, enc('held picture'));
    await s.vanish(a);
    expect(await s.status(h)).toBe(404);
    expect(await s.ports.blobIndex.usage('main', a.pk)).toBe(0);
    expect(await s.ports.blobs.head(h)).not.toBeNull();
  });
});
