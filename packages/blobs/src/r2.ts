// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * BlobStore over a Cloudflare R2 bucket *binding* (Workers). The bucket is
 * typed structurally so this package carries no Cloudflare type dependency.
 */
import type { BlobBody, BlobMeta, BlobStore, ByteRange } from '@beamhop/core';
import { DEFAULT_TYPE, assertSha256 } from './util.ts';

export interface R2ObjectLike {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
}

/** The subset of the Workers `R2Bucket` API this adapter uses. */
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; sha256?: string },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    limit?: number;
    include?: Array<'httpMetadata' | 'customMetadata'>;
  }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}

type FixedLengthStreamCtor = new (
  length: number,
) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

export interface R2BindingBlobStoreOptions {
  /** Key prefix inside the bucket, e.g. `blobs/`. */
  prefix?: string;
}

export class R2BindingBlobStore implements BlobStore {
  readonly kind = 'r2';
  private readonly prefix: string;

  constructor(
    private readonly bucket: R2BucketLike,
    opts: R2BindingBlobStoreOptions = {},
  ) {
    this.prefix = opts.prefix ?? '';
  }

  private key(sha256: string): string {
    assertSha256(sha256);
    return `${this.prefix}${sha256}`;
  }

  async init(): Promise<void> {}

  async head(sha256: string): Promise<BlobMeta | null> {
    const o = await this.bucket.head(this.key(sha256));
    return o ? { sha256, size: o.size, type: o.httpMetadata?.contentType ?? DEFAULT_TYPE } : null;
  }

  async get(sha256: string, range?: ByteRange): Promise<BlobBody | null> {
    const o = await this.bucket.get(
      this.key(sha256),
      range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
    );
    if (!o) return null;
    return {
      sha256,
      size: o.size,
      type: o.httpMetadata?.contentType ?? DEFAULT_TYPE,
      body: o.body,
    };
  }

  async put(meta: BlobMeta, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const key = this.key(meta.sha256);
    if (await this.bucket.head(key)) {
      if (!(data instanceof Uint8Array)) await data.cancel().catch(() => {});
      return;
    }
    let value: ReadableStream<Uint8Array> | Uint8Array = data;
    // Workers R2 requires a known length for streamed bodies.
    const FLS = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
    if (!(data instanceof Uint8Array) && FLS) {
      const fixed = new FLS(meta.size);
      void data.pipeTo(fixed.writable).catch(() => {});
      value = fixed.readable;
    }
    // `sha256` makes R2 verify integrity server-side.
    await this.bucket.put(key, value, {
      httpMetadata: { contentType: meta.type || DEFAULT_TYPE },
      sha256: meta.sha256,
    });
  }

  async delete(sha256: string): Promise<boolean> {
    const key = this.key(sha256);
    if (!(await this.bucket.head(key))) return false;
    await this.bucket.delete(key);
    return true;
  }

  async list(opts?: { cursor?: string; limit?: number }): Promise<{
    items: BlobMeta[];
    cursor?: string;
  }> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const res = await this.bucket.list({
      prefix: this.prefix || undefined,
      startAfter: opts?.cursor ? `${this.prefix}${opts.cursor}` : undefined,
      limit,
      include: ['httpMetadata'],
    });
    const items: BlobMeta[] = [];
    for (const o of res.objects) {
      const sha = o.key.slice(this.prefix.length);
      if (!/^[0-9a-f]{64}$/.test(sha)) continue;
      items.push({ sha256: sha, size: o.size, type: o.httpMetadata?.contentType ?? DEFAULT_TYPE });
    }
    const last = items[items.length - 1];
    return { items, cursor: res.truncated && last ? last.sha256 : undefined };
  }
}
