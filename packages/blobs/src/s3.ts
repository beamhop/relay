// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * S3-compatible BlobStore (AWS S3, Cloudflare R2 S3 API, GCS XML interop with
 * HMAC keys, MinIO, Garage…) signed with aws4fetch. Runs on Bun and Workers.
 *
 * - Blobs that fit in one part are buffered and sent in one PUT.
 * - Larger streams use multipart upload, holding at most one part in memory.
 * - Range GETs map to the HTTP `Range` header.
 */
import type { BlobBody, BlobMeta, BlobStore, ByteRange } from '@beamhop/core';
import { AwsClient } from 'aws4fetch';
import { DEFAULT_TYPE, assertSha256, chunked, toStream } from './util.ts';

export type FetchLike = (req: Request) => Promise<Response>;

export interface S3BlobStoreOptions {
  /** e.g. `https://s3.us-east-1.amazonaws.com`, `https://<acct>.r2.cloudflarestorage.com`, `https://storage.googleapis.com`, `http://minio:9000`. */
  endpoint: string;
  bucket: string;
  /** `auto` for R2 and GCS. Default `us-east-1`. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Key prefix inside the bucket, e.g. `blobs/`. */
  prefix?: string;
  /** Path-style URLs (`endpoint/bucket/key`). Default true (works for MinIO/R2/GCS). */
  pathStyle?: boolean;
  /**
   * Part size for multipart uploads (S3 minimum is 5 MiB). Blobs that fit in one
   * part use a single PUT. Default 8 MiB.
   */
  partSize?: number;
  /** Injected fetch (tests, custom agents). Default global fetch. */
  fetch?: FetchLike;
}

const MiB = 1024 * 1024;

export class S3BlobStore implements BlobStore {
  readonly kind = 's3';
  private readonly aws: AwsClient;
  private readonly fetchImpl: FetchLike;
  private readonly prefix: string;
  private readonly partSize: number;
  private readonly base: string;

  constructor(private readonly opts: S3BlobStoreOptions) {
    this.aws = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      sessionToken: opts.sessionToken,
      service: 's3',
      region: opts.region ?? 'us-east-1',
      retries: 0,
    });
    this.fetchImpl = opts.fetch ?? ((req) => fetch(req));
    this.prefix = opts.prefix ?? '';
    this.partSize = Math.max(opts.partSize ?? 8 * MiB, 1);
    const ep = new URL(opts.endpoint);
    const path = ep.pathname.replace(/\/+$/, '');
    this.base =
      opts.pathStyle === false
        ? `${ep.protocol}//${opts.bucket}.${ep.host}${path}`
        : `${ep.protocol}//${ep.host}${path}/${opts.bucket}`;
  }

  private url(key = '', query?: Record<string, string>): string {
    const u = new URL(`${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`);
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  private key(sha256: string): string {
    assertSha256(sha256);
    return `${this.prefix}${sha256}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const req = await this.aws.sign(url, init);
    return this.fetchImpl(req);
  }

  private async fail(op: string, res: Response): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(`s3 ${op} failed: ${res.status}${code ? ` ${code}` : ''}`);
  }

  async init(): Promise<void> {}

  async head(sha256: string): Promise<BlobMeta | null> {
    const res = await this.send(this.url(this.key(sha256)), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) return this.fail('head', res);
    return {
      sha256,
      size: Number(res.headers.get('content-length') ?? 0),
      type: res.headers.get('content-type') ?? DEFAULT_TYPE,
    };
  }

  async get(sha256: string, range?: ByteRange): Promise<BlobBody | null> {
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end}`;
    const res = await this.send(this.url(this.key(sha256)), { method: 'GET', headers });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) return this.fail('get', res);
    // Total size: Content-Range "bytes s-e/total" on 206, Content-Length otherwise.
    const cr = res.headers.get('content-range');
    const total = cr ? Number(cr.split('/')[1]) : Number(res.headers.get('content-length') ?? 0);
    return {
      sha256,
      size: total,
      type: res.headers.get('content-type') ?? DEFAULT_TYPE,
      body: res.body,
    };
  }

  async put(meta: BlobMeta, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const key = this.key(meta.sha256);
    if (await this.head(meta.sha256)) {
      if (!(data instanceof Uint8Array)) await data.cancel().catch(() => {});
      return;
    }
    const type = meta.type || DEFAULT_TYPE;
    // Anything that fits in one part is sent as a single PUT; otherwise multipart,
    // holding at most one part in memory.
    const parts = chunked(toStream(data), this.partSize);
    const first = await parts.next();
    if (first.done) return this.putSingle(key, new Uint8Array(0), type);
    const second = await parts.next();
    if (second.done) return this.putSingle(key, first.value, type);
    return this.multipart(
      key,
      type,
      (async function* () {
        yield first.value;
        yield second.value;
        yield* parts;
      })(),
    );
  }

  private async putSingle(key: string, body: Uint8Array, type: string): Promise<void> {
    const res = await this.send(this.url(key), {
      method: 'PUT',
      body: body as BodyInit,
      headers: { 'content-type': type },
    });
    if (!res.ok) return this.fail('put', res);
    await res.body?.cancel();
  }

  private async multipart(
    key: string,
    type: string,
    parts: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const init = await this.send(this.url(key, { uploads: '' }), {
      method: 'POST',
      headers: { 'content-type': type },
    });
    if (!init.ok) return this.fail('create-multipart', init);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await init.text())?.[1];
    if (!uploadId) throw new Error('s3 create-multipart: missing UploadId');
    const etags: string[] = [];
    try {
      let n = 0;
      for await (const part of parts) {
        n++;
        const res = await this.send(
          this.url(key, { partNumber: String(n), uploadId: xmlUnescape(uploadId) }),
          { method: 'PUT', body: part as BodyInit },
        );
        if (!res.ok) await this.fail('upload-part', res);
        await res.body?.cancel();
        etags.push(res.headers.get('etag') ?? '');
      }
      const xml = `<CompleteMultipartUpload>${etags
        .map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${xmlEscape(e)}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`;
      const done = await this.send(this.url(key, { uploadId: xmlUnescape(uploadId) }), {
        method: 'POST',
        body: xml,
        headers: { 'content-type': 'application/xml' },
      });
      const text = await done.text();
      // S3 may return 200 with an <Error> body for CompleteMultipartUpload.
      if (!done.ok || /<Error>/.test(text))
        throw new Error(`s3 complete-multipart failed: ${done.status}`);
    } catch (err) {
      await this.send(this.url(key, { uploadId: xmlUnescape(uploadId) }), { method: 'DELETE' })
        .then((r) => r.body?.cancel())
        .catch(() => {});
      throw err;
    }
  }

  async delete(sha256: string): Promise<boolean> {
    if (!(await this.head(sha256))) return false;
    const res = await this.send(this.url(this.key(sha256)), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) return this.fail('delete', res);
    await res.body?.cancel();
    return true;
  }

  async list(opts?: { cursor?: string; limit?: number }): Promise<{
    items: BlobMeta[];
    cursor?: string;
  }> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const q: Record<string, string> = { 'list-type': '2', 'max-keys': String(limit) };
    if (this.prefix) q.prefix = this.prefix;
    if (opts?.cursor) q['start-after'] = `${this.prefix}${opts.cursor}`;
    const res = await this.send(this.url('', q), { method: 'GET' });
    if (!res.ok) return this.fail('list', res);
    const xml = await res.text();
    const items: BlobMeta[] = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1] ?? '';
      const key = xmlUnescape(/<Key>([^<]*)<\/Key>/.exec(body)?.[1] ?? '');
      const sha = key.slice(this.prefix.length);
      if (!/^[0-9a-f]{64}$/.test(sha)) continue;
      items.push({
        sha256: sha,
        size: Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0),
        // ListObjectsV2 does not return Content-Type; use head() when the type matters.
        type: DEFAULT_TYPE,
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const last = items[items.length - 1];
    return { items, cursor: truncated && last ? last.sha256 : undefined };
  }
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
