// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobStoreContract, collectStream } from '@beamhop/testkit';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { FsBlobStore } from '../src/fs.ts';
import {
  R2BindingBlobStore,
  type R2BucketLike,
  type R2ObjectBodyLike,
  S3BlobStore,
} from '../src/index.ts';
import { mockS3 } from './mock-s3.ts';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'beamhop-blobs-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function s3(partSize?: number, m = mockS3()) {
  return {
    mock: m,
    store: new S3BlobStore({
      endpoint: 'https://s3.example.test',
      bucket: 'test-bucket',
      region: 'auto',
      accessKeyId: 'AKIDTEST',
      secretAccessKey: 'secret',
      prefix: 'blobs/',
      partSize,
      fetch: m.fetch,
    }),
  };
}

/** Structural in-memory R2 bucket (same shape as the Workers binding). */
function fakeR2(): R2BucketLike & { objects: Map<string, { data: Uint8Array; type?: string }> } {
  const objects = new Map<string, { data: Uint8Array; type?: string }>();
  return {
    objects,
    async head(key) {
      const o = objects.get(key);
      return o ? { key, size: o.data.length, httpMetadata: { contentType: o.type } } : null;
    },
    async get(key, options) {
      const o = objects.get(key);
      if (!o) return null;
      const r = options?.range;
      const bytes = r ? o.data.slice(r.offset, r.offset + r.length) : o.data;
      const res: R2ObjectBodyLike = {
        key,
        size: o.data.length,
        httpMetadata: { contentType: o.type },
        body: new Response(bytes as BodyInit).body as ReadableStream<Uint8Array>,
      };
      return res;
    },
    async put(key, value, options) {
      const data =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      if (options?.sha256 && bytesToHex(sha256(data)) !== options.sha256) {
        throw new Error('sha256 mismatch');
      }
      objects.set(key, { data, type: options?.httpMetadata?.contentType });
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(options) {
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(options?.prefix ?? '') && k > (options?.startAfter ?? ''))
        .sort();
      const limit = options?.limit ?? 1000;
      const page = keys.slice(0, limit);
      return {
        objects: page.map((key) => ({
          key,
          size: objects.get(key)!.data.length,
          httpMetadata: { contentType: objects.get(key)!.type },
        })),
        truncated: keys.length > limit,
      };
    },
  };
}

blobStoreContract('fs', async () => new FsBlobStore(await tmp()));
blobStoreContract('s3 (mock)', async () => s3().store);
blobStoreContract('s3 multipart (mock)', async () => s3(4).store);
blobStoreContract(
  'r2 binding (fake)',
  async () => new R2BindingBlobStore(fakeR2(), { prefix: 'b/' }),
);

const enc = (s: string) => new TextEncoder().encode(s);
const meta = (data: Uint8Array, type = 'text/plain') => ({
  sha256: bytesToHex(sha256(data)),
  size: data.length,
  type,
});
function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}
function failingStream(first: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(first);
    },
    pull(c) {
      c.error(new Error('boom'));
    },
  });
}

describe('FsBlobStore', () => {
  test('shards by hash prefix, keeps type, failed write leaves nothing', async () => {
    const root = await tmp();
    const s = new FsBlobStore({ root });
    await s.init();
    const data = enc('sharded content');
    const m = meta(data, 'image/png');
    await s.put(m, data);
    expect(await readdir(join(root, m.sha256.slice(0, 2), m.sha256.slice(2, 4)))).toContain(
      m.sha256,
    );
    expect((await s.head(m.sha256))?.type).toBe('image/png');
    const range = await s.get(m.sha256, { start: 8, end: 14 });
    expect(new TextDecoder().decode(await collectStream(range!.body))).toBe('content');

    const bad = enc('never stored');
    await expect(s.put(meta(bad), failingStream(bad.slice(0, 3)))).rejects.toThrow();
    expect(await s.head(meta(bad).sha256)).toBeNull();
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
  });

  test('list pagination with cursor', async () => {
    const s = new FsBlobStore(await tmp());
    await s.init();
    const all: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = enc(`blob ${i}`);
      all.push(meta(d).sha256);
      await s.put(meta(d), d);
    }
    all.sort();
    const p1 = await s.list({ limit: 3 });
    expect(p1.items.map((i) => i.sha256)).toEqual(all.slice(0, 3));
    const p2 = await s.list({ limit: 3, cursor: p1.cursor });
    expect(p2.items.map((i) => i.sha256)).toEqual(all.slice(3));
    expect(p2.cursor).toBeUndefined();
  });
});

describe('S3BlobStore', () => {
  test('signs requests, single PUT below part size, keeps content-type', async () => {
    const { store, mock } = s3(1024);
    const data = enc('small');
    await store.put(meta(data, 'image/webp'), data);
    expect(mock.calls.filter((c) => c.method === 'PUT').length).toBe(1);
    expect(mock.objects.get(`blobs/${meta(data).sha256}`)?.type).toBe('image/webp');
    expect((await store.head(meta(data).sha256))?.type).toBe('image/webp');
  });

  test('streams large uploads as multipart and reports total size on range GET', async () => {
    const { store, mock } = s3(5);
    const data = enc('abcdefghijklmnopqrstuvwxyz');
    const m = meta(data);
    await store.put(m, streamOf(data.slice(0, 7), data.slice(7, 9), data.slice(9)));
    const partPuts = mock.calls.filter((c) => c.method === 'PUT' && c.query.includes('partNumber'));
    expect(partPuts.length).toBe(6);
    expect(new TextDecoder().decode(mock.objects.get(`blobs/${m.sha256}`)!.data)).toBe(
      'abcdefghijklmnopqrstuvwxyz',
    );
    const part = await store.get(m.sha256, { start: 10, end: 12 });
    expect(part?.size).toBe(26);
    expect(new TextDecoder().decode(await collectStream(part!.body))).toBe('klm');
  });

  test('aborts multipart upload when the source stream fails', async () => {
    const { store, mock } = s3(4);
    const big = enc('0123456789abcdef');
    let n = 0;
    const s = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ < 3) c.enqueue(big.slice(0, 4));
        else c.error(new Error('boom'));
      },
    });
    await expect(store.put(meta(big), s)).rejects.toThrow();
    expect(mock.aborted.length).toBe(1);
    expect(mock.objects.size).toBe(0);
  });

  test('rejects unsigned/foreign requests at the mock (sanity)', async () => {
    const m = mockS3();
    const res = await m.fetch(new Request('https://s3.example.test/test-bucket/x'));
    expect(res.status).toBe(403);
  });
});

describe('R2BindingBlobStore', () => {
  test('range maps to offset/length and type is preserved', async () => {
    const bucket = fakeR2();
    const s = new R2BindingBlobStore(bucket);
    const data = enc('hello r2 world');
    await s.put(meta(data, 'text/markdown'), streamOf(data));
    const g = await s.get(meta(data).sha256, { start: 6, end: 7 });
    expect(new TextDecoder().decode(await collectStream(g!.body))).toBe('r2');
    expect(g?.type).toBe('text/markdown');
    expect(await s.delete(meta(data).sha256)).toBe(true);
    expect(await s.delete(meta(data).sha256)).toBe(false);
  });
});
