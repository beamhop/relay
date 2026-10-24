import { createHmac } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { isInlineSafe } from "../mime";
import { assertSha256, streamToBytes, thumbnailKey, type BlobDriver, type BlobObject, type ByteRange, type LocateOptions } from "./types";

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
  /** warning sink (403s treated as "missing" are logged so real permission problems are visible) */
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * S3-compatible driver (AWS, R2, MinIO, …) using path-style URLs: `${endpoint}/${bucket}/${key}`.
 * Objects are stored flat under `<sha256>` and `<sha256>.thumb.webp`.
 *
 * With `publicUrl` the bucket is publicly readable and anyone can fetch `${publicUrl}/<sha256>` directly, so:
 * - types that aren't safe to render (SVG, HTML, …) are stored as `application/octet-stream` + attachment;
 * - pending/blocked blobs live under an unguessable key `quarantine-<hmac(secretAccessKey, sha256)>` and are
 *   moved to `<sha256>` only once approved. (Rotating the secret key orphans quarantined objects.)
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
  const hiddenKey = (sha256: string) => `quarantine-${createHmac("sha256", cfg.secretAccessKey).update(sha256).digest("hex")}`;
  /** [visible, hidden] keys of a blob; without a public URL nothing is publicly reachable, so both are the same */
  const keysOf = (sha256: string): [string, string] => [sha256, publicBase ? hiddenKey(sha256) : sha256];
  const thumbKeysOf = (sha256: string): [string, string] => keysOf(sha256).map(thumbnailKey) as [string, string];

  async function request(method: string, key: string, init: { headers?: Record<string, string>; body?: Uint8Array } = {}): Promise<Response> {
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
    const safe = !!type && isInlineSafe(type);
    const headers: Record<string, string> = { "content-type": safe ? type : "application/octet-stream", "content-length": String(body.byteLength) };
    if (!safe) headers["content-disposition"] = "attachment";
    const res = await request("PUT", key, { body, headers });
    if (!res.ok) await fail(res, "PUT", key);
    await res.body?.cancel();
  }

  /**
   * "Not there" for a probe. AWS answers 403 instead of 404 for a missing key when the credentials lack
   * s3:ListBucket, so both count as absent when we're only looking.
   */
  const absent = (status: number) => status === 404 || status === 403;
  // a 403 may also be a real permission/KMS/clock-skew problem: say so (at most once a minute)
  let warnedAt = 0;
  const note403 = (op: string, key: string) => {
    if (!cfg.warn || Date.now() - warnedAt < 60_000) return;
    warnedAt = Date.now();
    cfg.warn("s3 answered 403; treating the object as missing (normal on AWS without s3:ListBucket, otherwise check credentials/policy)", { op, key });
  };

  async function headKey(key: string): Promise<boolean> {
    const res = await request("HEAD", key);
    await res.body?.cancel();
    if (res.ok) return true;
    if (absent(res.status)) {
      if (res.status === 403) note403("HEAD", key);
      return false;
    }
    return fail(res, "HEAD", key);
  }

  /**
   * Server-side copy then delete. Idempotent: a missing source with the destination already present (a retry
   * after a move that copied but failed later) counts as done. Returns false when neither exists.
   */
  async function moveKey(from: string, to: string): Promise<boolean> {
    const res = await request("PUT", to, { headers: { "x-amz-copy-source": `/${encodeURIComponent(cfg.bucket)}/${encodeURIComponent(from)}` } });
    let missing = absent(res.status);
    let denied = res.status === 403;
    if (missing) await res.body?.cancel();
    else {
      if (!res.ok) await fail(res, "COPY", `${from} -> ${to}`);
      // S3 can answer 200 with an <Error> body for copies
      const text = await res.text().catch(() => "");
      if (/<Error>/.test(text)) {
        if (!/NoSuchKey|AccessDenied/.test(text)) throw new Error(`s3 COPY ${from} -> ${to} failed: ${text.slice(0, 200)}`);
        missing = true;
        denied = /AccessDenied/.test(text);
      }
    }
    if (missing) {
      // a denied copy of a source that *is* there (KMS key, bucket policy, signature/clock skew) is a failure,
      // not "already moved": the bytes would stay where they are while the caller flips the blob's status
      if (denied && (await headKey(from))) throw new Error(`s3 COPY ${from} -> ${to} denied (403) while the source exists`);
      return headKey(to);
    }
    await deleteKey(from);
    return true;
  }

  /** GET the first of `keys` that exists (missing = 404 or, on AWS without ListBucket, 403) */
  async function getFirst(keys: string[], range?: ByteRange): Promise<BlobObject | undefined> {
    for (const k of new Set(keys)) {
      const obj = await getKey(k, range);
      if (obj) return obj;
    }
    return undefined;
  }

  async function getKey(key: string, range?: ByteRange): Promise<BlobObject | undefined> {
    const res = await request("GET", key, range ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {});
    if (absent(res.status)) {
      if (res.status === 403) note403("GET", key);
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

  /** keys to try, the one the blob's status says first */
  const ordered = ([vis, hid]: [string, string], opts?: LocateOptions): string[] => (opts?.hidden ? [hid, vis] : [vis, hid]);

  async function deleteKey(key: string) {
    const res = await request("DELETE", key);
    if (!res.ok && res.status !== 404) await fail(res, "DELETE", key);
    await res.body?.cancel();
  }

  return {
    name: "s3",
    async put(sha256, data, type, opts) {
      assertSha256(sha256);
      await putKey(keysOf(sha256)[opts?.hidden ? 1 : 0], data instanceof Uint8Array ? data : await streamToBytes(data), type);
    },
    async get(sha256, range, opts) {
      assertSha256(sha256);
      return getFirst(ordered(keysOf(sha256), opts), range);
    },
    async has(sha256, opts) {
      assertSha256(sha256);
      for (const key of new Set(ordered(keysOf(sha256), opts))) if (await headKey(key)) return true;
      return false;
    },
    async delete(sha256) {
      assertSha256(sha256);
      for (const key of new Set([...keysOf(sha256), ...thumbKeysOf(sha256)])) await deleteKey(key);
    },
    async putThumbnail(sha256, data, opts) {
      assertSha256(sha256);
      await putKey(thumbKeysOf(sha256)[opts?.hidden ? 1 : 0], data, "image/webp");
    },
    async getThumbnail(sha256, opts) {
      assertSha256(sha256);
      return getFirst(ordered(thumbKeysOf(sha256), opts));
    },
    publicUrl: publicBase ? (sha256) => `${publicBase}/${sha256}` : undefined,
    setHidden: publicBase
      ? async (sha256, hidden, opts) => {
          assertSha256(sha256);
          const [vis, hid] = keysOf(sha256);
          const [tvis, thid] = thumbKeysOf(sha256);
          // the blob has a row, so its bytes must be at one of the two keys: not finding them is an error
          if (!(await moveKey(hidden ? vis : hid, hidden ? hid : vis))) throw new Error(`s3: blob ${sha256} not found under either key`);
          // no thumbnail recorded: nothing to move (probing a missing key is an error on some AWS policies)
          if (opts?.hasThumbnail !== false) await moveKey(hidden ? tvis : thid, hidden ? thid : tvis);
        }
      : undefined,
  };
}
