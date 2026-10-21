// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Encryption at rest for blobs (§12.7): a BlobStore wrapper that encrypts every
 * blob with its own random 256-bit data key (AES-GCM), wrapped by `ports.keyWrapper`
 * (local master key / KMS / Vault — same KEK providers as managed keys, §12.3).
 *
 * Content addressing stays on the PLAINTEXT sha256 (Blossom semantics unchanged);
 * the inner store holds ciphertext under that name. Stored object layout:
 *
 *   "BHE1" | u32 header length | header JSON | chunk 0 | chunk 1 | …
 *
 * Each 64 KiB plaintext chunk is sealed separately (IV = 8-byte random prefix ‖ u32
 * chunk index; AAD = `<sha256>:<index>:<last?1:0>`), so ranged reads decrypt only the
 * chunks they touch and chunks cannot be reordered, swapped between blobs or truncated.
 *
 * Database encryption: bun:sqlite has no SQLCipher. Use encrypted volumes (LUKS,
 * cloud disk encryption with CMEK), Postgres TDE / encrypted managed Postgres, or D1
 * (encrypted at rest by Cloudflare). See README "Encryption at rest".
 */
import type { BlobBody, BlobMeta, BlobStore, ByteRange, KeyWrapper } from '@beamhop/core';
import { b64decode, b64encode, buf, fromUtf8, utf8 } from './util.ts';

const MAGIC = utf8('BHE1');
const TAG = 16;
export const ENCRYPTED_CHUNK = 64 * 1024;

interface Header {
  v: 1;
  provider: string;
  /** Wrapped data key (base64). */
  dek: string;
  /** 8-byte IV prefix (base64). */
  iv: string;
  chunk: number;
  size: number;
  type: string;
}

interface Parsed {
  header: Header;
  dataOffset: number;
}

class Lru<V> {
  private m = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
  delete(k: string): void {
    this.m.delete(k);
  }
}

function chunkCount(size: number, chunk: number): number {
  return Math.max(1, Math.ceil(size / chunk));
}

function ivFor(prefix: Uint8Array, index: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  const r = stream.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Re-chunk a byte source into exact `size`-byte pieces (last may be shorter). */
async function* rechunk(
  data: Uint8Array | ReadableStream<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  if (data instanceof Uint8Array) {
    for (let o = 0; o < data.length; o += size) yield data.subarray(o, o + size);
    return;
  }
  const reader = data.getReader();
  let pending = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(pending.length + value.length);
    merged.set(pending, 0);
    merged.set(value, pending.length);
    pending = merged;
    while (pending.length >= size) {
      yield pending.slice(0, size);
      pending = pending.slice(size);
    }
  }
  if (pending.length) yield pending;
}

/**
 * Turn on encryption for an existing BlobStore instance in place (its methods are
 * replaced, so modules holding a reference are covered). Pre-existing plaintext blobs
 * stay readable. Returns an uninstall function.
 */
export function encryptInPlace(store: BlobStore, wrapper: KeyWrapper): () => void {
  const target = store as unknown as Record<string, unknown>;
  const names = ['init', 'put', 'get', 'head', 'delete', 'list'] as const;
  const saved = names.map((n) => [n, Object.hasOwn(target, n), target[n]] as const);
  const inner: BlobStore = {
    kind: store.kind,
    init: store.init.bind(store),
    put: store.put.bind(store),
    get: store.get.bind(store),
    head: store.head.bind(store),
    delete: store.delete.bind(store),
    list: store.list.bind(store),
  };
  const enc = new EncryptedBlobStore(inner, wrapper, { allowPlaintext: true });
  for (const n of names) target[n] = (enc[n] as (...a: unknown[]) => unknown).bind(enc);
  return () => {
    for (const [n, own, v] of saved) {
      if (own) target[n] = v;
      else delete target[n];
    }
  };
}

export class EncryptedBlobStore implements BlobStore {
  readonly kind: string;
  private headers = new Lru<Parsed>(2048);
  private keys = new Lru<CryptoKey>(256);

  /**
   * @param opts.allowPlaintext read blobs stored before encryption was turned on
   *   as-is (migration); new writes are always encrypted.
   */
  constructor(
    private readonly inner: BlobStore,
    private readonly wrapper: KeyWrapper,
    private readonly opts: { allowPlaintext?: boolean } = {},
  ) {
    this.kind = `encrypted(${inner.kind})`;
  }

  init(): Promise<void> {
    return this.inner.init();
  }

  private aad(sha: string, index: number, last: boolean): Uint8Array {
    return utf8(`${sha}:${index}:${last ? 1 : 0}`);
  }

  async put(meta: BlobMeta, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    if (await this.inner.head(meta.sha256)) {
      if (data instanceof ReadableStream) await data.cancel().catch(() => {});
      return;
    }
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const prefix = crypto.getRandomValues(new Uint8Array(8));
    const header: Header = {
      v: 1,
      provider: this.wrapper.provider,
      dek: b64encode(await this.wrapper.wrap(dek)),
      iv: b64encode(prefix),
      chunk: ENCRYPTED_CHUNK,
      size: meta.size,
      type: meta.type,
    };
    const key = await crypto.subtle.importKey('raw', buf(dek), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    dek.fill(0);
    const hb = utf8(JSON.stringify(header));
    const lead = new Uint8Array(8 + hb.length);
    lead.set(MAGIC, 0);
    new DataView(lead.buffer).setUint32(4, hb.length);
    lead.set(hb, 8);
    const total = chunkCount(meta.size, ENCRYPTED_CHUNK);
    const parts: Uint8Array[] = [lead];
    let index = 0;
    let seen = 0;
    for await (const piece of rechunk(data, ENCRYPTED_CHUNK)) {
      seen += piece.length;
      if (seen > meta.size) throw new Error('blob is larger than its declared size');
      parts.push(await this.seal(key, prefix, meta.sha256, index, index === total - 1, piece));
      index++;
    }
    if (seen !== meta.size) throw new Error('blob size does not match its declared size');
    if (index === 0)
      parts.push(await this.seal(key, prefix, meta.sha256, 0, true, new Uint8Array()));
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    await this.inner.put({ sha256: meta.sha256, size: n, type: 'application/octet-stream' }, out);
    this.headers.set(meta.sha256, { header, dataOffset: lead.length });
    this.keys.set(meta.sha256, key);
  }

  private async seal(
    key: CryptoKey,
    prefix: Uint8Array,
    sha: string,
    index: number,
    last: boolean,
    plain: Uint8Array,
  ): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: buf(ivFor(prefix, index)),
          additionalData: buf(this.aad(sha, index, last)),
        },
        key,
        buf(plain),
      ),
    );
  }

  private async open(
    key: CryptoKey,
    prefix: Uint8Array,
    sha: string,
    index: number,
    last: boolean,
    sealed: Uint8Array,
  ): Promise<Uint8Array> {
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: buf(ivFor(prefix, index)),
            additionalData: buf(this.aad(sha, index, last)),
          },
          key,
          buf(sealed),
        ),
      );
    } catch {
      throw new Error(`encrypted blob ${sha} failed integrity check (chunk ${index})`);
    }
  }

  /** Header of a stored blob; `'plain'` for blobs stored before encryption was enabled. */
  private async parsed(sha: string): Promise<Parsed | 'plain' | null> {
    const cached = this.headers.get(sha);
    if (cached) return cached;
    const first = await this.inner.get(sha, { start: 0, end: 7 });
    if (!first) return null;
    const lead = await readAll(first.body);
    if (lead.length < 8 || fromUtf8(lead.subarray(0, 4)) !== 'BHE1') {
      if (this.opts.allowPlaintext) return 'plain';
      throw new Error(`blob ${sha} is not encrypted by Beamhop`);
    }
    const len = new DataView(lead.buffer, lead.byteOffset).getUint32(4);
    const hb = await this.inner.get(sha, { start: 8, end: 8 + len - 1 });
    if (!hb) return null;
    const header = JSON.parse(fromUtf8(await readAll(hb.body))) as Header;
    const p = { header, dataOffset: 8 + len };
    this.headers.set(sha, p);
    return p;
  }

  private async keyFor(sha: string, h: Header): Promise<CryptoKey> {
    const cached = this.keys.get(sha);
    if (cached) return cached;
    const dek = await this.wrapper.unwrap(b64decode(h.dek));
    const key = await crypto.subtle.importKey('raw', buf(dek), 'AES-GCM', false, ['decrypt']);
    dek.fill(0);
    this.keys.set(sha, key);
    return key;
  }

  async head(sha256: string): Promise<BlobMeta | null> {
    if (!(await this.inner.head(sha256))) {
      this.headers.delete(sha256);
      return null;
    }
    const p = await this.parsed(sha256);
    if (p === 'plain') return this.inner.head(sha256);
    return p ? { sha256, size: p.header.size, type: p.header.type } : null;
  }

  async get(sha256: string, range?: ByteRange): Promise<BlobBody | null> {
    if (!(await this.inner.head(sha256))) return null;
    const p = await this.parsed(sha256);
    if (!p) return null;
    if (p === 'plain') return this.inner.get(sha256, range);
    const { header: h, dataOffset } = p;
    const meta = { sha256, size: h.size, type: h.type };
    if (h.size === 0) {
      return { ...meta, body: new ReadableStream({ start: (c) => c.close() }) };
    }
    const start = Math.max(0, range?.start ?? 0);
    const end = Math.min(h.size - 1, range?.end ?? h.size - 1);
    if (start > end) {
      return { ...meta, body: new ReadableStream({ start: (c) => c.close() }) };
    }
    const key = await this.keyFor(sha256, h);
    const prefix = b64decode(h.iv);
    const total = chunkCount(h.size, h.chunk);
    const first = Math.floor(start / h.chunk);
    const last = Math.floor(end / h.chunk);
    const sealedSize = h.chunk + TAG;
    const cStart = dataOffset + first * sealedSize;
    const cEnd = dataOffset + Math.min((last + 1) * sealedSize, h.size + total * TAG) - 1;
    const body = await this.inner.get(sha256, { start: cStart, end: cEnd });
    if (!body) return null;
    const reader = body.body.getReader();
    let buffered = new Uint8Array(0);
    let index = first;
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (index <= last) {
            const isLast = index === total - 1;
            const want = isLast ? h.size - index * h.chunk + TAG : sealedSize;
            while (buffered.length < want) {
              const { done, value } = await reader.read();
              if (done) break;
              const merged = new Uint8Array(buffered.length + value.length);
              merged.set(buffered, 0);
              merged.set(value, buffered.length);
              buffered = merged;
            }
            if (buffered.length < want) throw new Error(`encrypted blob ${sha256} is truncated`);
            const sealed = buffered.slice(0, want);
            buffered = buffered.slice(want);
            const plain = await self.open(key, prefix, sha256, index, isLast, sealed);
            const base = index * h.chunk;
            const from = Math.max(0, start - base);
            const to = Math.min(plain.length, end - base + 1);
            index++;
            if (to > from) {
              controller.enqueue(plain.subarray(from, to));
              return;
            }
          }
          await reader.cancel().catch(() => {});
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        void reader.cancel().catch(() => {});
      },
    });
    return { ...meta, body: stream };
  }

  async delete(sha256: string): Promise<boolean> {
    this.headers.delete(sha256);
    this.keys.delete(sha256);
    return this.inner.delete(sha256);
  }

  async list(opts?: { cursor?: string; limit?: number }) {
    const page = await this.inner.list(opts);
    const items: BlobMeta[] = [];
    for (const it of page.items) {
      const p = await this.parsed(it.sha256).catch(() => null);
      items.push(
        p && p !== 'plain' ? { sha256: it.sha256, size: p.header.size, type: p.header.type } : it,
      );
    }
    return page.cursor ? { items, cursor: page.cursor } : { items };
  }
}
