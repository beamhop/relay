// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeKey } from '@beamhop/testkit';
import { BLOSSOM_GC_JOB, type BlossomService, HELD } from '../src/index.ts';
import { authHeader, enc, hashOf, setup } from './helpers.ts';

type S = Awaited<ReturnType<typeof setup>>;

async function put(s: S, key: ReturnType<typeof makeKey>, data: Uint8Array) {
  const res = await s.req('/upload', {
    method: 'PUT',
    body: data as BodyInit,
    headers: {
      authorization: authHeader(key, 'upload', { x: [hashOf(data)] }),
      'content-type': 'image/png',
    },
  });
  expect(res.status).toBe(200);
  return hashOf(data);
}

async function vanish(s: S, pubkey: string, until = s.ports.clock.now()) {
  s.kernel.bus.emit('user.vanished', { relayId: 'main', pubkey, until, scope: 'relay' });
  await s.kernel.use<BlossomService>('blossom')!.settled();
}

const status = async (s: S, sha: string) => (await s.req(`/${sha}`)).status;

describe('right to vanish (user.vanished)', () => {
  test("removes the person's files and quota; shared files stay for others", async () => {
    const s = await setup();
    const a = makeKey();
    const b = makeKey();
    const own = await put(s, a, enc('alice only'));
    const shared = await put(s, a, enc('shared picture'));
    expect(await put(s, b, enc('shared picture'))).toBe(shared);
    const bobOnly = await put(s, b, enc('bob only'));
    expect(await s.ports.blobIndex.usage('main', a.pk)).toBeGreaterThan(0);
    const deleted: string[] = [];
    s.kernel.bus.on('blob.deleted', (e) => deleted.push(`${e.sha256}:${e.cause}`));

    await vanish(s, a.pk);

    expect(await status(s, own)).toBe(404);
    expect(await s.ports.blobs.head(own)).toBeNull();
    expect(await s.ports.blobIndex.usage('main', a.pk)).toBe(0);
    expect(await s.ports.blobIndex.listByOwner('main', a.pk)).toEqual([]);
    // Bob still has his copy of the shared hash, and his own file.
    expect(await status(s, shared)).toBe(200);
    expect(await s.ports.blobs.head(shared)).not.toBeNull();
    expect((await s.ports.blobIndex.owners('main', shared)).map((o) => o.pubkey)).toEqual([b.pk]);
    expect(await status(s, bobOnly)).toBe(200);
    expect(deleted.sort()).toEqual([`${own}:vanish`, `${shared}:vanish`].sort());
  });

  test('only files uploaded at or before `until` go', async () => {
    const s = await setup();
    const a = makeKey();
    const old = await put(s, a, enc('old file'));
    const until = s.ports.clock.now();
    s.ports.clock.advance(60);
    const fresh = await put(s, a, enc('newer file'));
    await vanish(s, a.pk, until);
    expect(await status(s, old)).toBe(404);
    expect(await status(s, fresh)).toBe(200);
  });

  test('other relays keep their own copy', async () => {
    const s = await setup();
    const a = makeKey();
    const sha = await put(s, a, enc('on two relays'));
    await s.ports.blobIndex.addOwner({
      ...(await s.ports.blobIndex.owners('main', sha))[0]!,
      relayId: 'other',
    });
    await vanish(s, a.pk);
    expect(await status(s, sha)).toBe(404);
    expect(await s.ports.blobs.head(sha)).not.toBeNull();
    expect((await s.ports.blobIndex.owners('other', sha)).length).toBe(1);
  });

  test('held files stop being served but their bytes are kept until the hold is lifted', async () => {
    const s = await setup();
    const a = makeKey();
    let held = true;
    s.kernel.provide('lifecycle.holds', {
      active: () => true,
      isHeld: async (_r: string, subj: { pubkey?: string }) => held && subj.pubkey === a.pk,
    });
    const sha = await put(s, a, enc('evidence'));
    await vanish(s, a.pk);
    expect(await status(s, sha)).toBe(404);
    expect(await s.ports.blobIndex.usage('main', a.pk)).toBe(0);
    expect(await s.ports.blobs.head(sha)).not.toBeNull();
    const rec = (await s.ports.docs.list(HELD, { prefix: `${sha}:` })).items[0];
    expect(rec?.value).toMatchObject({
      sha256: sha,
      pubkey: a.pk,
      relayId: 'main',
      cause: 'vanish',
    });
    // The orphan sweep does not touch held bytes.
    await s.ports.scheduler.tick(BLOSSOM_GC_JOB);
    expect(await s.ports.blobs.head(sha)).not.toBeNull();

    held = false;
    await s.ports.scheduler.tick(BLOSSOM_GC_JOB);
    expect(await s.ports.blobs.head(sha)).toBeNull();
    expect((await s.ports.docs.list(HELD, { prefix: `${sha}:` })).items).toEqual([]);
  });
});
