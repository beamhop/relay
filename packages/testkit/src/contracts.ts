// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Port contract suites. Every adapter package runs these against its adapter:
 *
 *   import { eventStoreContract } from '@beamhop/testkit';
 *   eventStoreContract('sqlite', async () => new SqliteEventStore(':memory:'));
 */
import { describe, expect, test } from 'bun:test';
import type { BlobIndex, BlobStore, DocStore, EventStore, TimeSeriesStore } from '@beamhop/core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { makeEvent, makeKey } from './fixtures.ts';
import { collectStream } from './memory.ts';

const R = 'r1';

export function eventStoreContract(name: string, make: () => Promise<EventStore>): void {
  describe(`EventStore contract: ${name}`, () => {
    const fresh = async () => {
      const s = await make();
      await s.init();
      return s;
    };

    test('save, duplicate, getById', async () => {
      const s = await fresh();
      const k = makeKey();
      const e = makeEvent(k);
      expect((await s.save(R, e)).status).toBe('saved');
      expect((await s.save(R, e)).status).toBe('duplicate');
      expect(await s.getById(R, e.id)).toEqual(e);
      expect(await s.getById('other', e.id)).toBeNull();
    });

    test('query ordering, limit, filters', async () => {
      const s = await fresh();
      const k = makeKey();
      const k2 = makeKey();
      const a = makeEvent(k, { created_at: 100, kind: 1, tags: [['t', 'nostr']] });
      const b = makeEvent(k, { created_at: 200, kind: 7 });
      const c = makeEvent(k2, { created_at: 300, kind: 1, content: 'Find me please' });
      for (const e of [a, b, c]) await s.save(R, e);
      expect((await s.query(R, [{}])).map((e) => e.id)).toEqual([c.id, b.id, a.id]);
      expect((await s.query(R, [{ limit: 2 }])).map((e) => e.id)).toEqual([c.id, b.id]);
      expect((await s.query(R, [{ kinds: [1] }])).length).toBe(2);
      expect((await s.query(R, [{ authors: [k2.pk] }]))[0]?.id).toBe(c.id);
      expect((await s.query(R, [{ '#t': ['nostr'] }]))[0]?.id).toBe(a.id);
      expect((await s.query(R, [{ since: 150, until: 250 }]))[0]?.id).toBe(b.id);
      expect((await s.query(R, [{ ids: [a.id] }, { ids: [b.id] }])).length).toBe(2);
      expect(await s.count(R, [{ kinds: [1] }])).toBe(2);
      if (s.capabilities.search) {
        expect((await s.query(R, [{ search: 'find' }]))[0]?.id).toBe(c.id);
      }
    });

    test('tenancy isolation', async () => {
      const s = await fresh();
      const e = makeEvent(makeKey());
      await s.save('a', e);
      expect(await s.query('b', [{}])).toEqual([]);
      expect((await s.save('b', e)).status).toBe('saved');
    });

    test('replaceable and addressable semantics', async () => {
      const s = await fresh();
      const k = makeKey();
      const p1 = makeEvent(k, { kind: 0, created_at: 10 });
      const p2 = makeEvent(k, { kind: 0, created_at: 20 });
      expect((await s.save(R, p1)).status).toBe('saved');
      const r = await s.save(R, p2);
      expect(r.status).toBe('saved');
      expect(r.replaced).toEqual([p1.id]);
      expect((await s.save(R, p1)).status).toBe('superseded');
      expect((await s.query(R, [{ kinds: [0] }])).map((e) => e.id)).toEqual([p2.id]);

      const d1 = makeEvent(k, { kind: 30023, created_at: 10, tags: [['d', 'x']] });
      const d2 = makeEvent(k, { kind: 30023, created_at: 20, tags: [['d', 'y']] });
      const d3 = makeEvent(k, { kind: 30023, created_at: 30, tags: [['d', 'x']] });
      for (const e of [d1, d2, d3]) await s.save(R, e);
      expect((await s.query(R, [{ kinds: [30023] }])).map((e) => e.id).sort()).toEqual(
        [d2.id, d3.id].sort(),
      );
    });

    test('NIP-09 deletion by id and address, tombstones', async () => {
      const s = await fresh();
      const k = makeKey();
      const other = makeKey();
      const e = makeEvent(k);
      const foreign = makeEvent(other);
      const addr = makeEvent(k, { kind: 30000, tags: [['d', 'list']], created_at: 50 });
      for (const x of [e, foreign, addr]) await s.save(R, x);
      const del = makeEvent(k, {
        kind: 5,
        created_at: 100,
        tags: [
          ['e', e.id],
          ['e', foreign.id],
          ['a', `30000:${k.pk}:list`],
        ],
      });
      const deleted = await s.applyDeletion(R, del);
      expect(deleted.sort()).toEqual([e.id, addr.id].sort());
      expect(await s.getById(R, foreign.id)).not.toBeNull();
      expect((await s.save(R, e)).status).toBe('deleted');
      const oldAddr = makeEvent(k, { kind: 30000, tags: [['d', 'list']], created_at: 90 });
      expect((await s.save(R, oldAddr)).status).toBe('deleted');
      const newAddr = makeEvent(k, { kind: 30000, tags: [['d', 'list']], created_at: 150 });
      expect((await s.save(R, newAddr)).status).toBe('saved');
    });

    test('NIP-62 vanish', async () => {
      const s = await fresh();
      const k = makeKey();
      await s.save(R, makeEvent(k, { created_at: 10 }));
      await s.save(R, makeEvent(k, { created_at: 20 }));
      expect(await s.vanish(R, k.pk, 100)).toBe(2);
      expect((await s.save(R, makeEvent(k, { created_at: 50 }))).status).toBe('deleted');
      expect((await s.save(R, makeEvent(k, { created_at: 150 }))).status).toBe('saved');
    });

    test('expiry and deleteMatching', async () => {
      const s = await fresh();
      const k = makeKey();
      const exp = makeEvent(k, { tags: [['expiration', '500']] });
      const keep = makeEvent(k, { kind: 7 });
      await s.save(R, exp);
      await s.save(R, keep);
      expect(await s.deleteExpired(400)).toBe(0);
      expect(await s.deleteExpired(600)).toBe(1);
      expect(await s.deleteMatching(R, { kinds: [7] })).toBe(1);
      expect((await s.stats(R)).events).toBe(0);
    });

    test('deleteByIds with tombstone', async () => {
      const s = await fresh();
      const e = makeEvent(makeKey());
      await s.save(R, e);
      expect(await s.deleteByIds(R, [e.id], { tombstone: true })).toBe(1);
      expect((await s.save(R, e)).status).toBe('deleted');
    });
  });
}

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => bytesToHex(sha256(b));

export function blobStoreContract(name: string, make: () => Promise<BlobStore>): void {
  describe(`BlobStore contract: ${name}`, () => {
    test('put/get/head/range/delete/list', async () => {
      const s = await make();
      await s.init();
      const data = enc('hello blossom');
      const meta = { sha256: hex(data), size: data.length, type: 'text/plain' };
      await s.put(meta, data);
      await s.put(meta, data); // idempotent
      expect(await s.head(meta.sha256)).toEqual(meta);
      const got = await s.get(meta.sha256);
      expect(new TextDecoder().decode(await collectStream(got!.body))).toBe('hello blossom');
      const part = await s.get(meta.sha256, { start: 0, end: 4 });
      expect(new TextDecoder().decode(await collectStream(part!.body))).toBe('hello');
      expect((await s.list()).items.map((i) => i.sha256)).toContain(meta.sha256);
      expect(await s.delete(meta.sha256)).toBe(true);
      expect(await s.head(meta.sha256)).toBeNull();
      expect(await s.get(meta.sha256)).toBeNull();
    });

    test('streaming put', async () => {
      const s = await make();
      await s.init();
      const data = enc('streamed');
      const meta = { sha256: hex(data), size: data.length, type: 'text/plain' };
      await s.put(
        meta,
        new ReadableStream({
          start(c) {
            c.enqueue(data.slice(0, 3));
            c.enqueue(data.slice(3));
            c.close();
          },
        }),
      );
      expect((await s.head(meta.sha256))?.size).toBe(data.length);
    });
  });
}

export function blobIndexContract(name: string, make: () => Promise<BlobIndex>): void {
  describe(`BlobIndex contract: ${name}`, () => {
    test('ownership, usage, refCount, expiry', async () => {
      const s = await make();
      await s.init();
      const base = { sha256: 'a'.repeat(64), size: 10, type: 'image/png', uploadedAt: 100 };
      await s.addOwner({ ...base, relayId: 'r1', pubkey: 'p1' });
      await s.addOwner({ ...base, relayId: 'r1', pubkey: 'p2', expiresAt: 200 });
      await s.addOwner({ ...base, relayId: 'r2', pubkey: 'p1' });
      expect((await s.owners('r1', base.sha256)).length).toBe(2);
      expect(await s.usage('r1', 'p1')).toBe(10);
      expect(await s.refCount(base.sha256)).toBe(3);
      expect((await s.listByOwner('r1', 'p1')).length).toBe(1);
      expect((await s.expired(300, 10)).length).toBe(1);
      expect(await s.removeOwner('r1', base.sha256, 'p2')).toBe(true);
      expect(await s.refCount(base.sha256)).toBe(2);
      expect((await s.list('r1')).items.length).toBe(1);
    });
  });
}

export function docStoreContract(name: string, make: () => Promise<DocStore>): void {
  describe(`DocStore contract: ${name}`, () => {
    test('crud, list, prefix, pagination, cas', async () => {
      const s = await make();
      await s.init();
      await s.put('c', 'a1', { n: 1 });
      await s.put('c', 'a2', { n: 2 });
      await s.put('c', 'b1', { n: 3 });
      await s.put('other', 'a1', { n: 9 });
      expect(await s.get('c', 'a1')).toEqual({ n: 1 });
      expect((await s.list('c', { prefix: 'a' })).items.map((i) => i.key)).toEqual(['a1', 'a2']);
      const p1 = await s.list('c', { limit: 2 });
      expect(p1.items.length).toBe(2);
      const p2 = await s.list('c', { limit: 2, cursor: p1.cursor });
      expect(p2.items.map((i) => i.key)).toEqual(['b1']);
      expect((await s.list('c', { reverse: true, limit: 1 })).items[0]?.key).toBe('b1');
      expect(await s.cas('c', 'a1', { n: 1 }, { n: 10 })).toBe(true);
      expect(await s.cas('c', 'a1', { n: 1 }, { n: 11 })).toBe(false);
      expect(await s.cas('c', 'new', null, { n: 0 })).toBe(true);
      expect(await s.delete('c', 'a1')).toBe(true);
      expect(await s.get('c', 'a1')).toBeNull();
    });
  });
}

export function timeSeriesContract(name: string, make: () => Promise<TimeSeriesStore>): void {
  describe(`TimeSeriesStore contract: ${name}`, () => {
    test('record, bucketed aggregation, label filter, prune', async () => {
      const s = await make();
      await s.init();
      const a = { relay: 'r1', kind: 'note' };
      const b = { relay: 'r2', kind: 'note' };
      await s.record([
        { metric: 'events', labels: a, t: 100, v: 1 },
        { metric: 'events', labels: a, t: 110, v: 3 },
        { metric: 'events', labels: b, t: 115, v: 10 },
        { metric: 'events', labels: a, t: 160, v: 5 },
        { metric: 'other', labels: a, t: 120, v: 99 },
      ]);
      const q = { metric: 'events', from: 0, to: 1000, stepSeconds: 60 };
      expect(await s.range({ ...q, agg: 'sum' })).toEqual([
        { t: 60, v: 14 },
        { t: 120, v: 5 },
      ]);
      expect(await s.range({ ...q, agg: 'max' })).toEqual([
        { t: 60, v: 10 },
        { t: 120, v: 5 },
      ]);
      expect(await s.range({ ...q, agg: 'min', labels: { relay: 'r1' } })).toEqual([
        { t: 60, v: 1 },
        { t: 120, v: 5 },
      ]);
      expect(await s.range({ ...q, agg: 'avg', labels: { relay: 'r1' } })).toEqual([
        { t: 60, v: 2 },
        { t: 120, v: 5 },
      ]);
      expect(await s.range({ ...q, agg: 'last', labels: { relay: 'r1', kind: 'note' } })).toEqual([
        { t: 60, v: 3 },
        { t: 120, v: 5 },
      ]);
      expect(await s.range({ ...q, from: 150, agg: 'sum' })).toEqual([{ t: 120, v: 5 }]);
      expect(await s.prune(115)).toBe(2);
      expect(await s.range({ ...q, agg: 'sum' })).toEqual([
        { t: 60, v: 10 },
        { t: 120, v: 5 },
      ]);
    });
  });
}
