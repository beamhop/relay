import { afterEach, describe, expect, test } from "bun:test";
import { createS3Driver, loadSharp } from "../src";
import { verifyAuthEvent, parseAuthHeader } from "../src/auth";
import { readLimited, sha256Hex } from "../src/http";
import { createImageProcessor } from "../src/image";
import { ipBucket, Semaphore, WindowLimiter } from "../src/limits";
import { blobCsp } from "../src/mime";
import { fetchRemote } from "../src/mirror";
import { PNG_1x1, authHeader, createHarness, newUser, sha256, type Harness, xOf } from "./fakes";

let h: Harness;
afterEach(() => h?.cleanup());
const alice = newUser();
const bob = newUser();
const now = () => Math.floor(Date.now() / 1000);

const upload = (data: Uint8Array, u = alice, init: { type?: string; body?: BodyInit } = {}) =>
  h.request("/upload", {
    method: "PUT",
    body: init.body ?? (data as BodyInit),
    headers: { authorization: authHeader(u.sk, "upload", { x: [xOf(data)] }), "content-type": init.type ?? "application/octet-stream" },
  });

/** RIFF/WAVE header + a few samples — sniffed as audio/wav */
const WAV = (() => {
  const data = new Uint8Array(8);
  const b = new Uint8Array(44 + data.length);
  const v = new DataView(b.buffer);
  const s = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  s(0, "RIFF"), v.setUint32(4, 36 + data.length, true), s(8, "WAVE"), s(12, "fmt "), v.setUint32(16, 16, true);
  v.setUint16(20, 1, true), v.setUint16(22, 1, true), v.setUint32(24, 8000, true), v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true), v.setUint16(34, 8, true), s(36, "data"), v.setUint32(40, data.length, true);
  return b;
})();

/** PNG_1x1 with a `tEXt` "Raw profile type exif" chunk (ImageMagick/GIMP style GPS carrier) before IEND */
function pngWithTextExif(): Uint8Array {
  const text = new TextEncoder().encode("Raw profile type exif\0\nexif\n  24\n4578696600004d4d002a00000008GPS");
  const chunk = new Uint8Array(12 + text.length);
  new DataView(chunk.buffer).setUint32(0, text.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(text, 8); // CRC left zero: parsers we care about don't verify it
  const iend = PNG_1x1.length - 12;
  const out = new Uint8Array(PNG_1x1.length + chunk.length);
  out.set(PNG_1x1.subarray(0, iend));
  out.set(chunk, iend);
  out.set(PNG_1x1.subarray(iend), iend + chunk.length);
  return out;
}

describe("blob CSP", () => {
  test("audio/video can play when opened directly; everything else stays sandboxed", async () => {
    expect(blobCsp("audio/wav")).toBe("default-src 'none'; media-src 'self'");
    expect(blobCsp("video/mp4")).not.toContain("sandbox");
    expect(blobCsp("image/svg+xml")).toContain("sandbox");
    h = await createHarness({ useSharp: false });
    const desc = await (await upload(WAV)).json();
    expect(desc.type).toBe("audio/wav");
    const res = await h.request(`/${desc.sha256}`);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; media-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("upload auth scoping (B9)", () => {
  const x = "ab".repeat(32);
  const verify = (header: string, verb: "upload" | "get" | "delete" | "list" = "upload") =>
    verifyAuthEvent(parseAuthHeader(header)!, { verb, domains: ["cdn.example.com"] });

  test("an upload token must name the blob (a server tag alone isn't enough)", () => {
    expect(() => verify(authHeader(alice.sk, "upload", { server: [] }))).toThrow(/missing x tag/);
    expect(verify(authHeader(alice.sk, "upload", { x: [x] })).hashes).toEqual([x]);
    // every upload route required an x tag anyway; the server-only form was never accepted over HTTP
    expect(() => verify(authHeader(alice.sk, "upload", { server: ["cdn.example.com"] }))).toThrow(/missing x tag/);
  });

  test("no token lives longer than 24h, read tokens included", () => {
    const far = now() + 3 * 24 * 3600;
    expect(() => verify(authHeader(alice.sk, "upload", { x: [x], expiration: far }))).toThrow(/too far in the future/);
    expect(() => verify(authHeader(alice.sk, "delete", { x: [x], expiration: far }), "delete")).toThrow(/too far/);
    expect(() => verify(authHeader(alice.sk, "get", { expiration: far }), "get")).toThrow(/too far/);
    expect(() => verify(authHeader(alice.sk, "list", { expiration: far }), "list")).toThrow(/too far/);
  });

  test("PUT /upload with an unscoped token is a 401", async () => {
    h = await createHarness({ useSharp: false });
    const res = await h.request("/upload", { method: "PUT", body: PNG_1x1 as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { server: [] }) } });
    expect(res.status).toBe(401);
  });
});

describe("upload rate limits and concurrency (B3)", () => {
  test("per-IP and per-pubkey limits answer 429", async () => {
    h = await createHarness({ useSharp: false, uploadsPerMinutePerIp: 2, uploadsPerMinutePerPubkey: 0 });
    expect((await upload(PNG_1x1)).status).toBe(201);
    expect((await upload(PNG_1x1, bob)).status).toBe(200);
    expect((await upload(PNG_1x1, newUser())).status).toBe(429);

    await h.cleanup();
    h = await createHarness({ useSharp: false, uploadsPerMinutePerIp: 0, uploadsPerMinutePerPubkey: 1 });
    expect((await upload(PNG_1x1)).status).toBe(201);
    expect((await upload(PNG_1x1)).status).toBe(429);
    expect((await upload(PNG_1x1, bob)).status).toBe(200);
  });

  test("ingests beyond the concurrency + queue cap get 503; slow bodies don't hold ingest slots", async () => {
    h = await createHarness({ useSharp: false, maxConcurrentUploads: 1, maxQueuedUploads: 0 });
    // a body still arriving doesn't take the only ingest slot
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new ReadableStream<Uint8Array>({
      async start(ctl) {
        ctl.enqueue(PNG_1x1.subarray(0, 10));
        await gate;
        ctl.enqueue(PNG_1x1.subarray(10));
        ctl.close();
      },
    });
    const first = h.request("/upload", { method: "PUT", body: slow, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(PNG_1x1)] }) }, duplex: "half" } as RequestInit);
    await new Promise((r) => setTimeout(r, 20));
    expect((await upload(PNG_1x1, bob)).status).toBe(201);
    release();
    expect((await first).status).toBe(200);
    // an ingest in progress (slow storage) does
    let unblock!: () => void;
    const storing = new Promise<void>((r) => (unblock = r));
    const put = h.svc.driver.put.bind(h.svc.driver);
    h.svc.driver.put = async (...args) => (await storing, put(...args));
    const busy = upload(new TextEncoder().encode("%PDF-1.4\n%%EOF\n")); // a new blob, so it gets stored
    await new Promise((r) => setTimeout(r, 20));
    expect((await upload(PNG_1x1, bob)).status).toBe(503);
    unblock();
    expect((await busy).status).toBe(201);
  });

  test("helpers", async () => {
    let t = 0;
    const lim = new WindowLimiter(2, 1000, 3, () => t);
    expect([lim.take("a"), lim.take("a"), lim.take("a")]).toEqual([true, true, false]);
    t = 1001;
    expect(lim.take("a")).toBe(true);
    for (const k of ["b", "c", "d", "e"]) lim.take(k); // bounded map: no throw, no growth beyond maxKeys
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe(ipBucket("2001:db8:1:2:ffff:1:2:3"));
    expect(ipBucket("2001:db8:1:2::1")).not.toBe(ipBucket("2001:db8:1:3::1"));
    expect(ipBucket("203.0.113.5")).toBe("203.0.113.5");
    const sem = new Semaphore(1, 0);
    let releaseSem!: () => void;
    const held = sem.run(() => new Promise<void>((r) => (releaseSem = r)));
    expect(sem.canEnter()).toBe(false);
    releaseSem();
    await held;
    expect(sem.canEnter()).toBe(true);
  });
});

describe("readLimited (no double buffering)", () => {
  const stream = (...parts: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    });
  test("exact hint, growth, short body and the size limit", async () => {
    const a = new Uint8Array(70_000).fill(1);
    const b = new Uint8Array(50_000).fill(2);
    const all = new Uint8Array([...a, ...b]);
    for (const hint of [all.length, undefined, 10, all.length + 5]) {
      const r = await readLimited(stream(a, b), 1_000_000, hint);
      expect(r.data.byteLength).toBe(all.length);
      expect(r.sha256).toBe(sha256Hex(all));
      expect(r.data[69_999]).toBe(1);
      expect(r.data[70_000]).toBe(2);
    }
    await expect(readLimited(stream(a, b), 100_000, 120_000)).rejects.toMatchObject({ status: 413 });
  });
});

describe("mirror hardening (B3/B8)", () => {
  const fakeFetch = (res: () => Response) => (async () => res()) as unknown as typeof fetch;

  test("only ports 80/443 (configurable) and no upstream status echo", async () => {
    const ok = fakeFetch(() => new Response("x"));
    await expect(fetchRemote("http://93.184.216.34:8080/x", { fetch: ok, allowPrivate: false, timeoutMs: 1000 })).rejects.toMatchObject({ status: 403 });
    await expect(fetchRemote("http://93.184.216.34:22/x", { fetch: ok, allowPrivate: false, timeoutMs: 1000 })).rejects.toMatchObject({ status: 403 });
    expect((await fetchRemote("http://93.184.216.34:8080/x", { fetch: ok, allowPrivate: false, timeoutMs: 1000, allowedPorts: [8080] })).status).toBe(200);
    const err = await fetchRemote("https://93.184.216.34/x", { fetch: fakeFetch(() => new Response("no", { status: 401 })), allowPrivate: false, timeoutMs: 1000 }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.reason).not.toContain("401");
  });

  test("oversized JSON body is refused; quota is checked from Content-Length before downloading", async () => {
    let pulled = false;
    const big = 5_000_000;
    h = await createHarness({
      useSharp: false,
      allowPrivateMirror: true,
      fetch: (async () =>
        new Response(
          new ReadableStream(
            {
              pull(c) {
                pulled = true;
                c.enqueue(new Uint8Array(1024));
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-length": String(big) } },
        )) as unknown as typeof fetch,
    });
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: 1000 });
    const x = "cd".repeat(32);
    const mirror = (body: string) =>
      h.request("/mirror", { method: "PUT", body, headers: { "content-type": "application/json", authorization: authHeader(alice.sk, "upload", { x: [x] }) } });
    expect((await mirror(JSON.stringify({ url: "https://example.com/a", pad: "y".repeat(20_000) }))).status).toBe(413);
    const res = await mirror(JSON.stringify({ url: "https://example.com/a" }));
    expect(res.status).toBe(413);
    expect(res.headers.get("x-reason")).toMatch(/quota/);
    expect(pulled).toBe(false);
  });
});

describe("metadata stripping with sharp (B2/B5)", () => {
  test("PNG text chunks are removed even when sharp sees a clean image", async () => {
    for (const useSharp of [true, false]) {
      const p = await createImageProcessor({ useSharp });
      const r = await p.stripMetadata(pngWithTextExif(), "image/png");
      expect(r.stripped).toBe(true);
      expect(new TextDecoder().decode(r.data)).not.toContain("Raw profile");
    }
  });

  test("images over the pixel limit are never decoded (no thumbnail, no re-encode)", async () => {
    const sharp = (await loadSharp()) as unknown as ((...a: unknown[]) => any) | undefined;
    if (!sharp) return;
    const img = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123" } }).png().toBuffer());
    const small = await createImageProcessor({ maxPixels: 1000 });
    expect(await small.thumbnail(img, "image/png")).toBeUndefined();
    const normal = await createImageProcessor({});
    expect(await normal.thumbnail(img, "image/png")).toBeInstanceOf(Uint8Array);
  });
});

describe("s3 with a public URL (B6)", () => {
  function mockS3() {
    const objects = new Map<string, { data: Uint8Array; headers: Record<string, string> }>();
    const fetchFn = (async (input: Request) => {
      const req = input instanceof Request ? input : new Request(input);
      const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/bucket\//, ""));
      const obj = objects.get(key);
      switch (req.method) {
        case "PUT": {
          const src = req.headers.get("x-amz-copy-source");
          if (src) {
            const from = objects.get(decodeURIComponent(src.replace(/^\/bucket\//, "")));
            if (!from) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
            objects.set(key, from);
            return new Response("<CopyObjectResult/>", { status: 200 });
          }
          objects.set(key, { data: new Uint8Array(await req.arrayBuffer()), headers: Object.fromEntries(req.headers) });
          return new Response(null, { status: 200 });
        }
        case "HEAD":
          return new Response(null, { status: obj ? 200 : 404 });
        case "DELETE":
          objects.delete(key);
          return new Response(null, { status: 204 });
        case "GET":
          return obj ? new Response(obj.data as BodyInit, { headers: { "content-length": String(obj.data.length) } }) : new Response("NoSuchKey", { status: 404 });
      }
      return new Response(null, { status: 405 });
    }) as unknown as typeof fetch;
    return { objects, fetchFn };
  }

  test("active types are stored as downloads; pending blobs live under an unguessable key until approved", async () => {
    const s3 = mockS3();
    const d = createS3Driver({ endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", publicUrl: "https://cdn.test", fetch: s3.fetchFn });
    const svg = new TextEncoder().encode("<svg/>");
    const sha = await sha256(svg);
    await d.put(sha, svg, "image/svg+xml");
    expect(s3.objects.get(sha)!.headers["content-type"]).toBe("application/octet-stream");
    expect(s3.objects.get(sha)!.headers["content-disposition"]).toBe("attachment");

    const png = await sha256(PNG_1x1);
    await d.put(png, PNG_1x1, "image/png", { hidden: true });
    await d.putThumbnail(png, PNG_1x1, { hidden: true });
    expect(s3.objects.has(png)).toBe(false);
    const hiddenKeys = [...s3.objects.keys()].filter((k) => k.startsWith("quarantine-"));
    expect(hiddenKeys).toHaveLength(2);
    expect(hiddenKeys.join()).not.toContain(png);
    expect(await d.has(png)).toBe(true);
    expect(await d.get(png)).toBeDefined();

    await d.setHidden!(png, false);
    expect(s3.objects.has(png)).toBe(true);
    expect(s3.objects.has(`${png}.thumb.webp`)).toBe(true);
    expect([...s3.objects.keys()].some((k) => k.startsWith("quarantine-"))).toBe(false);
    await d.setHidden!(png, true);
    expect(s3.objects.has(png)).toBe(false);
    await d.delete(png);
    expect([...s3.objects.keys()].filter((k) => k !== sha)).toEqual([]);
  });

  test("moderation moves bytes out of public reach", async () => {
    const s3 = mockS3();
    const driver = createS3Driver({ endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", publicUrl: "https://cdn.test", fetch: s3.fetchFn });
    h = await createHarness({ useSharp: false, driver });
    const desc = await (await upload(PNG_1x1)).json();
    expect(s3.objects.has(desc.sha256)).toBe(true);
    await h.svc.setStatus(desc.sha256, "blocked", "admin");
    expect(s3.objects.has(desc.sha256)).toBe(false);
    expect((await h.svc.read(desc.sha256))?.size).toBe(PNG_1x1.length);
    await h.svc.setStatus(desc.sha256, "approved", "admin");
    expect(s3.objects.has(desc.sha256)).toBe(true);
  });
});
