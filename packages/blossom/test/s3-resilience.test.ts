import { afterEach, describe, expect, test } from "bun:test";
import { createS3Driver, streamToBytes, type S3DriverConfig } from "../src";
import { authHeader, createHarness, newUser, PNG_1x1, sha256, xOf, type Harness } from "./fakes";

/**
 * In-memory S3 with fault injection: `faults` answers (or hangs) the next requests of a method before the store
 * sees them; every request is logged.
 */
function faultyS3() {
  const objects = new Map<string, Uint8Array>();
  const log: string[] = [];
  const faults: { method: string; fault: "hang" | "throw" | number }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let omitLength = false;
  const fetchFn = (async (input: Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input);
    const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/bucket\//, ""));
    log.push(`${req.method} ${key}`);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      const i = faults.findIndex((f) => f.method === req.method);
      if (i >= 0) {
        const { fault } = faults.splice(i, 1)[0];
        if (fault === "throw") throw new TypeError("fetch failed: connection reset");
        if (fault === "hang") {
          // like a provider that accepted the connection and never answers: only the abort signal ends it
          return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        }
        return new Response("<Error/>", { status: fault });
      }
      const obj = objects.get(key);
      switch (req.method) {
        case "PUT":
          objects.set(key, new Uint8Array(await req.arrayBuffer()));
          return new Response(null, { status: 200 });
        case "HEAD":
          return obj ? new Response(null, { status: 200, headers: { "content-length": String(obj.byteLength) } }) : new Response(null, { status: 404 });
        case "DELETE":
          objects.delete(key);
          return new Response(null, { status: 204 });
        case "GET": {
          if (!obj) return new Response(null, { status: 404 });
          if (omitLength) {
            // chunked: no Content-Length
            const body = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(obj), c.close()) });
            return new Response(body, { status: 200 });
          }
          return new Response(obj as BodyInit, { headers: { "content-length": String(obj.byteLength) } });
        }
      }
      return new Response(null, { status: 405 });
    } finally {
      inFlight--;
    }
  }) as unknown as typeof fetch;
  return {
    objects,
    log,
    faults,
    fetchFn,
    get maxInFlight() {
      return maxInFlight;
    },
    set omitLength(v: boolean) {
      omitLength = v;
    },
  };
}

const sha = "b".repeat(64);
const driverFor = (s: ReturnType<typeof faultyS3>, cfg: Partial<S3DriverConfig> = {}) =>
  createS3Driver({ endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", fetch: s.fetchFn, retryBaseMs: 1, ...cfg });

describe("s3 request timeouts and retries", () => {
  test("a request that never answers is cut off and retried", async () => {
    const s = faultyS3();
    const d = driverFor(s, { timeoutMs: 30 });
    s.faults.push({ method: "PUT", fault: "hang" });
    await d.put(sha, new Uint8Array([1, 2, 3]), "image/png");
    expect(s.log.filter((l) => l.startsWith("PUT"))).toHaveLength(2);
    expect(s.objects.get(sha)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("gives up after maxAttempts and reports the timeout", async () => {
    const s = faultyS3();
    const d = driverFor(s, { timeoutMs: 20, maxAttempts: 2 });
    s.faults.push({ method: "HEAD", fault: "hang" }, { method: "HEAD", fault: "hang" });
    await expect(d.has(sha)).rejects.toThrow(/timed out/);
    expect(s.log).toHaveLength(2);
  });

  test("network errors, 429 and 5xx are retried; 4xx are not", async () => {
    const s = faultyS3();
    const d = driverFor(s);
    s.faults.push({ method: "PUT", fault: "throw" }, { method: "PUT", fault: 503 });
    await d.put(sha, new Uint8Array([7]), "image/png");
    expect(s.log.filter((l) => l.startsWith("PUT"))).toHaveLength(3);

    s.faults.push({ method: "DELETE", fault: 429 });
    await d.delete(sha);
    expect(s.objects.has(sha)).toBe(false);

    s.log.length = 0;
    s.faults.push({ method: "PUT", fault: 400 });
    await expect(d.put(sha, new Uint8Array([7]), "image/png")).rejects.toThrow(/400/);
    expect(s.log).toHaveLength(1);
  });

  test("the PUT timeout grows with the body size", async () => {
    const s = faultyS3();
    // 40 ms base, 1 KiB/s: a 1 KiB body gets ~1 s; without the scaling the 100 ms answer would be cut off at 40 ms
    const slow = s.fetchFn;
    let seenTimeout = 0;
    const d2 = createS3Driver({
      endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", timeoutMs: 40, putBytesPerSec: 1024, maxAttempts: 1,
      fetch: (async (req: Request, init?: RequestInit) => {
        const started = Date.now();
        // answer after 100 ms unless aborted first
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 100);
          init?.signal?.addEventListener("abort", () => (clearTimeout(t), (seenTimeout = Date.now() - started), reject(init.signal!.reason)));
        });
        return slow(req, init);
      }) as unknown as typeof fetch,
    });
    await d2.put(sha, new Uint8Array(1024), "image/png");
    expect(seenTimeout).toBe(0);
    // a tiny body keeps (about) the base timeout
    await expect(d2.put(sha, new Uint8Array(1), "image/png")).rejects.toThrow(/timed out/);
  });

  test("a GET body keeps streaming after the headers arrived", async () => {
    const d = createS3Driver({
      endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", timeoutMs: 20,
      fetch: (async (_req: Request, init?: RequestInit) => {
        let aborted = false;
        init?.signal?.addEventListener("abort", () => (aborted = true));
        const body = new ReadableStream<Uint8Array>({
          async pull(c) {
            // the body takes longer than the timeout
            await new Promise((r) => setTimeout(r, 60));
            if (aborted) c.error(new Error("aborted"));
            else (c.enqueue(new Uint8Array([1, 2, 3])), c.close());
          },
        });
        return new Response(body, { headers: { "content-length": "3" } });
      }) as unknown as typeof fetch,
    });
    const obj = (await d.get(sha))!;
    expect(await streamToBytes(obj.body)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("s3 presence and sizes", () => {
  test("has() trusts a recent put instead of a HEAD, and a size mismatch counts as missing", async () => {
    const s = faultyS3();
    const d = driverFor(s);
    await d.put(sha, new Uint8Array([1, 2, 3]), "image/png");
    s.log.length = 0;
    expect(await d.has(sha, { size: 3 })).toBe(true);
    expect(s.log).toEqual([]);
    // the cache only vouches for the size it saw
    expect(await d.has(sha, { size: 4 })).toBe(false);
    expect(s.log).toEqual([`HEAD ${sha}`]);
    // a delete forgets it
    await d.delete(sha);
    s.log.length = 0;
    expect(await d.has(sha)).toBe(false);
    expect(s.log).toEqual([`HEAD ${sha}`]);
  });

  test("presenceCacheMs 0 always asks the bucket", async () => {
    const s = faultyS3();
    const d = driverFor(s, { presenceCacheMs: 0 });
    await d.put(sha, new Uint8Array([1]), "image/png");
    s.log.length = 0;
    expect(await d.has(sha)).toBe(true);
    expect(s.log).toEqual([`HEAD ${sha}`]);
  });

  // regression: an object removed from the bucket behind our back stayed "known" for presenceCacheMs, so a
  // re-upload in that window skipped the PUT and the blob kept answering 404
  test("a GET that finds the object gone drops it from the presence cache", async () => {
    const s = faultyS3();
    const d = driverFor(s);
    await d.put(sha, new Uint8Array([1]), "image/png");
    s.objects.delete(sha);
    expect(await d.get(sha)).toBeUndefined();
    expect(await d.has(sha, { size: 1 })).toBe(false);
  });

  test("a GET without Content-Length reports an unknown size, not 0", async () => {
    const s = faultyS3();
    const d = driverFor(s);
    await d.put(sha, new Uint8Array([1, 2, 3]), "image/png");
    s.omitLength = true;
    const obj = (await d.get(sha))!;
    expect(obj.size).toBeUndefined();
    expect(await streamToBytes(obj.body)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("delete removes the blob's keys in parallel", async () => {
    const s = faultyS3();
    const d = driverFor(s, { publicUrl: "https://cdn.test" });
    await d.put(sha, new Uint8Array([1]), "image/png");
    await d.delete(sha);
    expect(s.log.filter((l) => l.startsWith("DELETE"))).toHaveLength(4);
    expect(s.maxInFlight).toBeGreaterThan(1);
  });
});

describe("blossom over s3", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  test("GET serves the row's size when the bucket sends no Content-Length", async () => {
    const s = faultyS3();
    h = await createHarness({ useSharp: false, driver: driverFor(s) });
    const alice = newUser();
    const res = await h.request("/upload", { method: "PUT", body: PNG_1x1 as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(PNG_1x1)] }) } });
    expect(res.status).toBe(201);
    s.omitLength = true;
    const x = await sha256(PNG_1x1);
    const got = await h.request(`/${x}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-length")).toBe(String(PNG_1x1.length));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG_1x1);
    expect((await h.svc.read(x))?.size).toBe(PNG_1x1.length);
  });

  test("re-uploading a stored blob doesn't HEAD the bucket again", async () => {
    const s = faultyS3();
    h = await createHarness({ useSharp: false, driver: driverFor(s) });
    const alice = newUser();
    const bob = newUser();
    const put = (u: ReturnType<typeof newUser>) =>
      h!.request("/upload", { method: "PUT", body: PNG_1x1 as BodyInit, headers: { authorization: authHeader(u.sk, "upload", { x: [xOf(PNG_1x1)] }) } });
    expect((await put(alice)).status).toBe(201);
    s.log.length = 0;
    expect((await put(bob)).status).toBe(200);
    expect(s.log).toEqual([]);
  });

  test("a re-upload rewrites bytes that went missing from the bucket", async () => {
    const s = faultyS3();
    h = await createHarness({ useSharp: false, driver: driverFor(s, { presenceCacheMs: 0 }) });
    const alice = newUser();
    const put = () =>
      h!.request("/upload", { method: "PUT", body: PNG_1x1 as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(PNG_1x1)] }) } });
    expect((await put()).status).toBe(201);
    const x = await sha256(PNG_1x1);
    s.objects.delete(x);
    expect((await put()).status).toBe(200);
    expect(s.objects.get(x)).toEqual(PNG_1x1);
  });
});
