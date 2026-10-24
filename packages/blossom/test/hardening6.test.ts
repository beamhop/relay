import { afterEach, describe, expect, test } from "bun:test";
import { createImageProcessor, stripJpegMetadata, stripPngMetadata, stripWebpMetadata } from "../src";
import { blobCsp } from "../src/mime";
import { PNG_1x1, authHeader, createHarness, jpegWithExif, newUser, sha256, type Harness } from "./fakes";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const MiB = 1024 * 1024;
const alice = newUser();
const bob = newUser();
const upload = (body: Uint8Array, sk = alice.sk, type?: string) =>
  h!.request("/upload", {
    method: "PUT",
    body: body as BodyInit,
    headers: { authorization: authHeader(sk, "upload", { server: ["cdn.example.com"] }), ...(type ? { "content-type": type } : {}) },
  });
// delete tokens are single-use: vary the expiration so two deletes in the same second get different event ids
let tokens = 0;
const del = (x: string, sk = alice.sk) =>
  h!.request(`/${x}`, { method: "DELETE", headers: { authorization: authHeader(sk, "delete", { x: [x], expiration: Math.floor(Date.now() / 1000) + 600 + ++tokens }) } });

/** RSS growth and wall time of `fn` */
function measure<T>(fn: () => T): { result: T; mb: number; ms: number } {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  const t = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t, mb: (process.memoryUsage().rss - before) / MiB };
}

const seg = (marker: number, payload: number[]) => Uint8Array.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

describe("pure-JS strippers on pathological input", () => {
  test("tens of MB of standalone FF D0 markers: rejected as malformed in O(1) memory (was ~1.8 GB RSS for 40 MiB)", async () => {
    const body = new Uint8Array(Buffer.alloc(32 * MiB, Uint8Array.from([0xff, 0xd0])));
    body[1] = 0xd8; // SOI, so it sniffs as image/jpeg
    const { result, mb, ms } = measure(() => stripJpegMetadata(body));
    expect(result.stripped).toBe(false);
    expect(result.data).toBe(body); // returned as is, no copy
    expect(mb).toBeLessThan(64);
    expect(ms).toBeLessThan(500);
    // the upload path: sharp (if installed) can't parse it either and falls back to the pure-JS stripper
    const p = await createImageProcessor();
    const t = performance.now();
    expect((await p.stripMetadata(body, "image/jpeg")).stripped).toBe(false);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  test("a large valid JPEG (markers inside the scan) is still stripped, byte-exact, with the orientation kept", () => {
    const soi = Uint8Array.from([0xff, 0xd8]);
    const app0 = seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    // big-endian Exif IFD0: orientation 6 (rotate 90°), followed by "GPS" junk
    const tiff = [...ascii("MM"), 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
    const app1 = seg(0xe1, [...ascii("Exif"), 0, 0, ...tiff, ...ascii("GPS 52.5200N 13.4050E")]);
    const com = seg(0xfe, ascii("secret comment"));
    const dqt = seg(0xdb, [0, ...new Array(64).fill(1)]);
    const sos = seg(0xda, [1, 1, 0, 0, 63, 0]);
    // entropy-coded data full of RST markers and stuffed bytes: copied verbatim, never walked
    const scan = new Uint8Array(Buffer.alloc(24 * MiB, Uint8Array.from([0x12, 0xff, 0xd0, 0x34, 0xff, 0x00])));
    const eoi = Uint8Array.from([0xff, 0xd9]);
    const input = cat(soi, app0, app1, com, dqt, sos, scan, eoi);
    // the minimal little-endian APP1 holding only the orientation tag
    const orientation = Uint8Array.from([
      0xff, 0xe1, 0, 34, ...ascii("Exif"), 0, 0, ...ascii("II"), 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const { result, ms } = measure(() => stripJpegMetadata(input));
    expect(result.stripped).toBe(true);
    expect(ms).toBeLessThan(500);
    expect(Buffer.from(result.data).equals(Buffer.from(cat(soi, app0, orientation, dqt, sos, scan, eoi)))).toBe(true);
  });

  test("more header segments than any real JPEG has is treated as malformed", () => {
    const pair = cat(seg(0xfe, []), seg(0xe0, [])); // dropped COM, kept APP0, 4 bytes each
    const many = (n: number) => cat(Uint8Array.from([0xff, 0xd8]), ...new Array(n).fill(pair), Uint8Array.from([0xff, 0xd9]));
    const ok = stripJpegMetadata(many(1000));
    expect(ok.stripped).toBe(true);
    expect(ok.data.length).toBe(2 + 1000 * 4 + 2);
    const capped = many(10_000);
    const { result, ms } = measure(() => stripJpegMetadata(capped));
    expect(result).toEqual({ data: capped, stripped: false });
    expect(ms).toBeLessThan(100);
  });

  test("PNG with tens of thousands of interleaved text chunks: stripped exactly; past the chunk cap left alone", () => {
    const chunk = (type: string, payload: number[]) => {
      const c = new Uint8Array(12 + payload.length);
      new DataView(c.buffer).setUint32(0, payload.length);
      c.set(ascii(type), 4);
      c.set(payload, 8);
      return c;
    };
    const ihdr = PNG_1x1.subarray(8, 33);
    const iend = PNG_1x1.subarray(PNG_1x1.length - 12);
    const text = chunk("tEXt", ascii("k\0v"));
    const idat = chunk("IDAT", [1, 2, 3]);
    const png = (n: number, withText: boolean) =>
      cat(PNG_1x1.subarray(0, 8), ihdr, ...new Array(n).fill(withText ? cat(text, idat) : idat), iend);
    const { result, ms } = measure(() => stripPngMetadata(png(40_000, true)));
    expect(result.stripped).toBe(true);
    expect(ms).toBeLessThan(500);
    expect(Buffer.from(result.data).equals(Buffer.from(png(40_000, false)))).toBe(true);
    const capped = png(60_000, true); // 120k chunks
    expect(stripPngMetadata(capped)).toEqual({ data: capped, stripped: false });
  });

  test("WebP with tens of thousands of interleaved EXIF chunks: stripped, header and VP8X flags fixed", () => {
    const chunk = (fourcc: string, payload: number[]) => {
      const c = new Uint8Array(8 + payload.length + (payload.length & 1));
      c.set(ascii(fourcc));
      new DataView(c.buffer).setUint32(4, payload.length, true);
      c.set(payload, 8);
      return c;
    };
    const n = 30_000;
    const vp8x = chunk("VP8X", [0x08 | 0x04 | 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const frame = chunk("ANMF", [1, 2, 3, 4]);
    const exif = chunk("EXIF", ascii("GPS"));
    const body = cat(Uint8Array.from(ascii("WEBP")), vp8x, ...new Array(n).fill(cat(frame, exif)));
    const riff = cat(Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0]), body);
    new DataView(riff.buffer).setUint32(4, riff.length - 8, true);
    const { result, ms } = measure(() => stripWebpMetadata(riff));
    expect(result.stripped).toBe(true);
    expect(ms).toBeLessThan(500);
    const out = Buffer.from(result.data);
    expect(out.length).toBe(riff.length - n * exif.length);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]).toBe(0x02); // EXIF + XMP flags cleared, animation flag kept
    expect(out.includes("EXIF")).toBe(false);
    expect(out.includes("GPS")).toBe(false);
  });
});

describe("moderation survives the owner deleting and re-uploading", () => {
  test("a blocked blob's hash goes on the blocklist when its last owner deletes it", async () => {
    h = await createHarness({ useSharp: false });
    const x = await sha256(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(200);
    expect((await upload(PNG_1x1, bob.sk)).status).toBe(200);
    await h.svc.setStatus(x, "blocked", "admin");
    // another owner remains: the blocked row is all that's needed
    expect((await del(x, bob.sk)).status).toBe(200);
    expect(await h.svc.blocklist()).toEqual([]);
    expect((await del(x)).status).toBe(200);
    expect(await h.svc.get(x)).toBeUndefined();
    expect((await h.svc.blocklist()).map((b) => b.sha256)).toEqual([x]);
    expect((await upload(PNG_1x1)).status).toBe(403);
    expect((await upload(PNG_1x1, bob.sk)).status).toBe(403);
    expect((await h.request(`/${x}`)).status).toBe(404);
    const preflight = await h.request("/upload", {
      method: "HEAD",
      headers: { authorization: authHeader(alice.sk, "upload", { x: [x] }), "x-sha-256": x, "x-content-length": String(PNG_1x1.length) },
    });
    expect(preflight.status).toBe(403);
    // lifting it is the admin's call
    expect(await h.svc.unblock(x, "admin")).toBe(true);
    expect((await upload(PNG_1x1)).status).toBe(200);
    expect((await h.svc.get(x))?.status).toBe("approved");
  });

  test("a blocked stripped upload stays blocked for the original EXIF-carrying bytes", async () => {
    h = await createHarness({ useSharp: false });
    const { withExif, withoutExif } = jpegWithExif();
    const desc = await (await upload(withExif)).json();
    expect(desc.sha256).toBe(await sha256(withoutExif));
    await h.svc.setStatus(desc.sha256, "blocked", "admin");
    expect((await del(desc.sha256)).status).toBe(200);
    expect((await upload(withExif)).status).toBe(403);
    expect((await upload(withoutExif)).status).toBe(403);
  });

  test("a pending blob deleted by its owner comes back pending, not auto-approved", async () => {
    h = await createHarness({ useSharp: false });
    const x = await sha256(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(200);
    await h.svc.setStatus(x, "pending", "admin"); // hidden for review while requireApproval is off
    expect((await del(x)).status).toBe(200);
    expect(await h.svc.get(x)).toBeUndefined();
    expect((await upload(PNG_1x1)).status).toBe(200);
    expect((await h.svc.get(x))?.status).toBe("pending");
    expect((await h.request(`/${x}`)).status).toBe(404);
    expect(await h.deps.stores.kv.get("blossom-held-status", x)).toBeUndefined(); // the row carries it again
    // once approved, delete + re-upload is an ordinary upload again
    await h.svc.setStatus(x, "approved", "admin");
    expect((await del(x)).status).toBe(200);
    expect((await upload(PNG_1x1)).status).toBe(200);
    expect((await h.svc.get(x))?.status).toBe("approved");
  });

  test("received bytes that are a blocked blob are refused even when stripping would change the hash", async () => {
    h = await createHarness({ useSharp: false });
    const { withExif, withoutExif } = jpegWithExif();
    await h.deps.settings.update({ blossom: { stripExif: false } } as never, "test");
    const x = await sha256(withExif);
    expect((await (await upload(withExif)).json()).sha256).toBe(x); // stored byte-identical
    await h.svc.setStatus(x, "blocked", "admin");
    await h.deps.settings.update({ blossom: { stripExif: true } } as never, "test");
    expect((await upload(withExif, bob.sk)).status).toBe(403);
    expect(await h.svc.get(await sha256(withoutExif))).toBeUndefined();
  });
});

describe("blob CSP for XML-based media types", () => {
  test("audio/video types that render as XML documents stay sandboxed and download", async () => {
    expect(blobCsp("video/x+xml")).toBe("default-src 'none'; sandbox");
    expect(blobCsp("audio/xml")).toBe("default-src 'none'; sandbox");
    expect(blobCsp("video/mp4")).toBe("default-src 'none'; media-src 'self'");
    expect(blobCsp("audio/ogg")).toBe("default-src 'none'; media-src 'self'");
    h = await createHarness({ useSharp: false });
    const doc = new TextEncoder().encode(`<x:doc xmlns:x="urn:x"><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script></x:doc>`);
    // a declared media type on bytes file-type doesn't recognise isn't believed: stored as octet-stream, refused here
    expect((await upload(doc, alice.sk, "video/x+xml")).status).toBe(415);
  });
});

describe("mirror stops early when the quota can't hold the blob", () => {
  /** remote that streams `chunk`-byte pieces forever, counting what it hands out */
  const endless = (pulled: { bytes: number }, chunk: number, length?: number) =>
    (async () =>
      new Response(
        new ReadableStream(
          {
            pull(c) {
              pulled.bytes += chunk;
              c.enqueue(new Uint8Array(chunk));
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: length !== undefined ? { "content-length": String(length) } : {} },
      )) as unknown as typeof fetch;
  const mirror = (x: string[]) =>
    h!.request("/mirror", {
      method: "PUT",
      body: JSON.stringify({ url: "https://example.com/a" }),
      headers: { "content-type": "application/json", authorization: authHeader(alice.sk, "upload", { x }) },
    });

  test("owning one of the token's hashes no longer skips the Content-Length quota check", async () => {
    const pulled = { bytes: 0 };
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: endless(pulled, 1024, 5_000_000) });
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: 1000 } as never);
    expect((await upload(PNG_1x1)).status).toBe(200);
    const res = await mirror([await sha256(PNG_1x1), "cd".repeat(32)]);
    expect(res.status).toBe(413);
    expect(res.headers.get("x-reason")).toMatch(/quota/);
    expect(pulled.bytes).toBe(0);
  });

  test("without a Content-Length the download is cut off once it outgrows the remaining quota", async () => {
    const pulled = { bytes: 0 };
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: endless(pulled, 256) });
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: 4096 } as never);
    const res = await mirror(["cd".repeat(32)]);
    expect(res.status).toBe(413);
    expect(res.headers.get("x-reason")).toMatch(/quota/);
    expect(pulled.bytes).toBeLessThan(16 * 1024);
  });

  test("a remote Content-Length over the size limit is refused before reading", async () => {
    const pulled = { bytes: 0 };
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: endless(pulled, 1024, 2048) });
    await h.deps.settings.update({ blossom: { maxUploadBytes: 1024 } } as never, "test");
    const res = await mirror(["cd".repeat(32)]);
    expect(res.status).toBe(413);
    expect(res.headers.get("x-reason")).toMatch(/too large/);
    expect(pulled.bytes).toBe(0);
  });

  test("re-mirroring a blob the signer already owns still works with a full quota", async () => {
    h = await createHarness({
      useSharp: false,
      allowPrivateMirror: true,
      fetch: (async () =>
        new Response(PNG_1x1 as BodyInit, { headers: { "content-type": "image/png", "content-length": String(PNG_1x1.length) } })) as unknown as typeof fetch,
    });
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: PNG_1x1.length } as never);
    expect((await upload(PNG_1x1)).status).toBe(200);
    expect((await mirror([await sha256(PNG_1x1)])).status).toBe(200);
    // a token that also allows a hash they don't own is held to the quota
    expect((await mirror([await sha256(PNG_1x1), "cd".repeat(32)])).status).toBe(413);
  });
});
