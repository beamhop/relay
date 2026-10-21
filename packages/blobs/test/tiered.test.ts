// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { MemoryBlobStore, blobStoreContract, collectStream } from '@beamhop/testkit';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { TieredBlobStore, tierInPlace } from '../src/index.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const meta = (s: string) => {
  const data = enc(s);
  return {
    data,
    meta: { sha256: bytesToHex(sha256(data)), size: data.length, type: 'text/plain' },
  };
};

blobStoreContract('tiered (no cold store)', async () => new TieredBlobStore(new MemoryBlobStore()));
blobStoreContract('tiered (hot + cold)', async () => {
  const cold = new MemoryBlobStore();
  return new TieredBlobStore(new MemoryBlobStore(), { cold: () => cold });
});
blobStoreContract('tiered (writes go cold)', async () => {
  const cold = new MemoryBlobStore();
  return new TieredBlobStore(new MemoryBlobStore(), { cold: () => cold, placement: () => 'cold' });
});

describe('TieredBlobStore', () => {
  test('moves to cold and keeps serving transparently', async () => {
    const hot = new MemoryBlobStore();
    const cold = new MemoryBlobStore();
    const reads: string[] = [];
    const t = new TieredBlobStore(hot, {
      cold: () => cold,
      onRead: (_s, tier) => reads.push(tier),
    });
    const { data, meta: m } = meta('cold bytes');
    await t.put(m, data);
    expect(await t.tierOf(m.sha256)).toBe('hot');
    expect(await t.move(m.sha256, 'cold')).toBe('moved');
    expect(await hot.head(m.sha256)).toBeNull();
    expect(await cold.head(m.sha256)).toEqual(m);
    expect(await t.tierOf(m.sha256)).toBe('cold');
    const got = await t.get(m.sha256, { start: 0, end: 3 });
    expect(new TextDecoder().decode(await collectStream(got!.body))).toBe('cold');
    expect(reads).toEqual(['cold']);
    // Idempotent: a second move finds it already there.
    expect(await t.move(m.sha256, 'cold')).toBe('already');
    // Promote back.
    expect(await t.move(m.sha256, 'hot')).toBe('moved');
    expect(await t.tierOf(m.sha256)).toBe('hot');
  });

  test('a half-finished move (copy in both tiers) is completed by the next move', async () => {
    const hot = new MemoryBlobStore();
    const cold = new MemoryBlobStore();
    const t = new TieredBlobStore(hot, { cold: () => cold });
    const { data, meta: m } = meta('both');
    await hot.put(m, data);
    await cold.put(m, data);
    expect((await t.list()).items.filter((i) => i.sha256 === m.sha256)).toHaveLength(2);
    expect(await t.move(m.sha256, 'cold')).toBe('moved');
    expect(await hot.head(m.sha256)).toBeNull();
    expect(await t.delete(m.sha256)).toBe(true);
    expect(await t.head(m.sha256)).toBeNull();
  });

  test('put never duplicates bytes that live in the other tier; placement can refuse', async () => {
    const hot = new MemoryBlobStore();
    const cold = new MemoryBlobStore();
    const changes: Array<[string, number]> = [];
    let full = false;
    const t = new TieredBlobStore(hot, {
      cold: () => cold,
      placement: () => {
        if (full) throw new Error('full');
        return 'hot';
      },
      onChange: (tier, bytes) => changes.push([tier, bytes]),
    });
    const { data, meta: m } = meta('dedupe');
    await cold.put(m, data);
    await t.put(m, data);
    expect(await hot.head(m.sha256)).toBeNull();
    full = true;
    const other = meta('other');
    await expect(t.put(other.meta, other.data)).rejects.toThrow('full');
    full = false;
    await t.put(other.meta, other.data);
    expect(changes).toEqual([['hot', other.meta.size]]);
  });

  test('list pages through hot then cold with prefixed cursors', async () => {
    const hot = new MemoryBlobStore();
    const cold = new MemoryBlobStore();
    const t = new TieredBlobStore(hot, { cold: () => cold });
    for (let i = 0; i < 5; i++) {
      const x = meta(`h${i}`);
      await hot.put(x.meta, x.data);
      const y = meta(`c${i}`);
      await cold.put(y.meta, y.data);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await t.list({ cursor, limit: 3 });
      seen.push(...p.items.map((i) => i.sha256));
      cursor = p.cursor;
      pages++;
    } while (cursor && pages < 20);
    expect(new Set(seen).size).toBe(10);
  });

  test('tierInPlace patches the shared object and restores it', async () => {
    const store = new MemoryBlobStore();
    const cold = new MemoryBlobStore();
    const { tiered, restore } = tierInPlace(store, { cold: () => cold });
    const { data, meta: m } = meta('in place');
    await store.put(m, data);
    await tiered.move(m.sha256, 'cold');
    // Calls through the original object read from cold now.
    expect(await store.head(m.sha256)).toEqual(m);
    restore();
    expect(await store.head(m.sha256)).toBeNull();
  });
});
