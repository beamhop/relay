import { AwsClient } from "aws4fetch";
import { assertSha256, streamToBytes, thumbnailKey, type BlobDriver, type BlobObject, type ByteRange } from "./types";

export interface S3DriverConfig {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** optional public base URL; GETs of approved blobs are redirected to `${publicUrl}/${sha256}` */
  publicUrl?: string;
  /** injectable fetch (tests / custom agents) */
  fetch?: typeof fetch;
}

/**
 * S3-compatible driver (AWS, R2, MinIO, …) using path-style URLs: `${endpoint}/${bucket}/${key}`.
 * Objects are stored flat under `<sha256>` and `<sha256>.thumb.webp`.
 */
export function createS3Driver(cfg: S3DriverConfig): BlobDriver {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region ?? "auto",
    service: "s3",
  });
  const doFetch = cfg.fetch ?? fetch;
  const base = `${cfg.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(cfg.bucket)}`;
  const publicBase = cfg.publicUrl?.replace(/\/+$/, "");

  async function request(method: string, key: string, init: { headers?: Record<string, string>; body?: Uint8Array } = {}) {
    const signed = await client.sign(`${base}/${encodeURIComponent(key)}`, {
      method,
      headers: init.headers,
      body: init.body as BodyInit | undefined,
    });
    return doFetch(signed);
  }

  async function fail(res: Response, op: string, key: string): Promise<never> {
    const text = await res.text().catch(() => "");
    throw new Error(`s3 ${op} ${key} failed: ${res.status} ${text.slice(0, 200)}`);
  }

  async function putKey(key: string, body: Uint8Array, type: string) {
    const res = await request("PUT", key, {
      body,
      headers: { "content-type": type || "application/octet-stream", "content-length": String(body.byteLength) },
    });
    if (!res.ok) await fail(res, "PUT", key);
    await res.body?.cancel();
  }

  async function getKey(key: string, range?: ByteRange): Promise<BlobObject | undefined> {
    const res = await request("GET", key, range ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {});
    if (res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    if (!res.ok || !res.body) await fail(res, "GET", key);
    let size = Number(res.headers.get("content-length") ?? 0);
    let served: ByteRange | undefined;
    if (res.status === 206) {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get("content-range") ?? "");
      if (m) {
        served = { start: Number(m[1]), end: Number(m[2]) };
        size = Number(m[3]);
      } else served = range;
    }
    return { body: res.body!, size, range: served };
  }

  async function deleteKey(key: string) {
    const res = await request("DELETE", key);
    if (!res.ok && res.status !== 404) await fail(res, "DELETE", key);
    await res.body?.cancel();
  }

  return {
    name: "s3",
    async put(sha256, data, type) {
      assertSha256(sha256);
      await putKey(sha256, data instanceof Uint8Array ? data : await streamToBytes(data), type);
    },
    async get(sha256, range) {
      assertSha256(sha256);
      return getKey(sha256, range);
    },
    async has(sha256) {
      assertSha256(sha256);
      const res = await request("HEAD", sha256);
      await res.body?.cancel();
      if (res.status === 404) return false;
      if (!res.ok) await fail(res, "HEAD", sha256);
      return true;
    },
    async delete(sha256) {
      assertSha256(sha256);
      await deleteKey(sha256);
      await deleteKey(thumbnailKey(sha256));
    },
    async putThumbnail(sha256, data) {
      assertSha256(sha256);
      await putKey(thumbnailKey(sha256), data, "image/webp");
    },
    async getThumbnail(sha256) {
      assertSha256(sha256);
      return getKey(thumbnailKey(sha256));
    },
    publicUrl: publicBase ? (sha256) => `${publicBase}/${sha256}` : undefined,
  };
}
