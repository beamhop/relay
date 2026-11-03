/**
 * Blossom on both blob drivers: the same black-box checks against the filesystem driver and against S3 (a local MinIO
 * at BEAMHOP_E2E_S3_ENDPOINT, default http://127.0.0.1:9000, bucket BEAMHOP_E2E_S3_DRIVER_BUCKET or `blossom-tests`;
 * skipped when it isn't reachable).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBeamhop, loadConfig, serve } from "@beamhop/server";
import { createBlossomService, loadSharp, optionsFromConfig } from "@beamhop/blossom";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { ensureS3Bucket } from "../harness/backend";
import { freePort } from "../harness/relay";
import { sha256 } from "../harness/client";
import { api, bauth, upload, user } from "./admin-helpers";

// credentials as in harness/backend.ts; the bucket is this suite's own (BEAMHOP_E2E_S3_BUCKET is the harness's per-relay
// bucket prefix there), created here when missing
const S3 = {
  endpoint: process.env.BEAMHOP_E2E_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  bucket: process.env.BEAMHOP_E2E_S3_DRIVER_BUCKET ?? "blossom-tests",
  accessKeyId: process.env.BEAMHOP_E2E_S3_ACCESS_KEY_ID ?? process.env.BEAMHOP_E2E_S3_KEY ?? "beamhop",
  secretAccessKey: process.env.BEAMHOP_E2E_S3_SECRET_ACCESS_KEY ?? process.env.BEAMHOP_E2E_S3_SECRET ?? "beamhop-secret",
  region: process.env.BEAMHOP_E2E_S3_REGION ?? "us-east-1",
};
const s3 = new Bun.S3Client({ endpoint: S3.endpoint, bucket: S3.bucket, accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey, region: S3.region });
const s3Up = await fetch(`${S3.endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1000) })
  .then((r) => r.ok)
  .catch(() => false);
if (s3Up) await ensureS3Bucket(S3);

/** status of the raw object in the bucket (200 / 404) */
const s3Head = async (key: string) => ((await s3.exists(key)) ? 200 : 404);

interface Booted {
  http: string;
  dir: string;
  owner: Uint8Array;
  stop(): Promise<void>;
}

async function boot(driver: "fs" | "s3", overrides: Record<string, any> = {}, options: Record<string, unknown> = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), `beamhop-e2e-drv-${driver}-`));
  const port = await freePort();
  const sk = generateSecretKey();
  const http = `http://127.0.0.1:${port}`;
  const { s3: s3Over, ...blossomOver } = overrides.blossom ?? {};
  const config = loadConfig({
    cwd: dir,
    env: {},
    overrides: {
      logLevel: "error",
      server: { host: "127.0.0.1", port, publicUrl: http },
      database: { driver: "sqlite", sqlitePath: join(dir, "e2e.db") },
      blossom: {
        driver,
        fsPath: join(dir, "blobs"),
        ...(driver === "s3" ? { s3: { ...S3, ...s3Over } } : {}),
        limits: { uploadsPerMinutePerIp: 0, uploadsPerMinutePerPubkey: 0, maxConcurrentUploadsPerIp: 0 },
        ...blossomOver,
      },
      admin: { owners: [getPublicKey(sk)] },
      plugins: { dir: join(dir, "plugins") },
    } as never,
  }).config;
  const beamhop = await createBeamhop(config, {
    autoDiscoverNpm: false,
    // mirror sources in these tests are local servers
    factories: { createBlossom: (deps) => createBlossomService(deps, { ...optionsFromConfig(deps.config), allowPrivateMirror: true, ...options }) as never },
  });
  await beamhop.start();
  const server = await serve(beamhop, { runtime: "bun", port, host: "127.0.0.1" });
  return {
    http,
    dir,
    owner: sk,
    async stop() {
      server.stopAccepting();
      await beamhop.stop();
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** every file under the fs driver's root (blobs, thumbnails, temp files) */
function fsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(n);
    }
  };
  walk(join(dir, "blobs"));
  return out;
}

/** A real (decodable) image of the given format, distinct per call. */
async function image(format: "png" | "jpeg", exif = false): Promise<Uint8Array<ArrayBuffer>> {
  const sharp = (await loadSharp()) as any;
  const px = Buffer.alloc(32 * 32 * 3);
  for (let i = 0; i < px.length; i++) px[i] = Math.floor(Math.random() * 256);
  let img = sharp(px, { raw: { width: 32, height: 32, channels: 3 } });
  if (exif) img = img.withExif({ IFD0: { Make: "BeamhopCam", Model: "GPS-Leak" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "52/1 22/1 0/1" } });
  const buf = format === "png" ? await img.png().toBuffer() : await img.jpeg().toBuffer();
  return new Uint8Array(buf);
}

/** Sends the head of a PUT /upload announcing `announced` bytes, writes `sent` of them, then drops the connection. */
function interruptedUpload(http: string, auth: string, announced: number, sent: number): Promise<void> {
  const { hostname, port } = new URL(http);
  return new Promise((resolve) => {
    const sock = connect(Number(port), hostname, () => {
      sock.write(
        `PUT /upload HTTP/1.1\r\nHost: ${hostname}:${port}\r\nAuthorization: ${auth}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${announced}\r\n\r\n`,
      );
      sock.write(Buffer.alloc(sent, 7), () => setTimeout(() => (sock.destroy(), resolve()), 200));
    });
    sock.on("error", () => resolve());
  });
}

for (const driver of ["fs", "s3"] as const) {
  describe.skipIf(driver === "s3" && !s3Up)(`blossom on the ${driver} driver`, () => {
    let relay: Booted;
    const setBlossom = async (patch: Record<string, unknown>) => {
      const r = await api(relay.http, relay.owner, "PATCH", "/settings", { blossom: patch });
      expect(r.status).toBe(200);
    };
    /** whether the blob's bytes are in storage */
    const stored = async (sha: string) => (driver === "fs" ? fsFiles(relay.dir).includes(sha) : (await s3Head(sha)) === 200);

    beforeAll(async () => {
      relay = await boot(driver);
    });
    afterAll(() => relay?.stop());

    test("upload, GET/HEAD with and without extension, exact bytes and headers", async () => {
      const bytes = await image("png");
      const r = await upload(relay.http, user().sk, bytes);
      expect(r.status).toBe(201);
      expect(r.body.type).toBe("image/png");
      expect(r.body.url).toBe(`${relay.http}/${r.sha}.png`);
      expect(await stored(r.sha)).toBe(true);
      for (const suffix of ["", ".png", ".jpg", ".bin"]) {
        const res = await fetch(`${relay.http}/${r.sha}${suffix}`);
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
        expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
        expect(res.headers.get("content-type")).toBe("image/png");
        const h = await fetch(`${relay.http}/${r.sha}${suffix}`, { method: "HEAD" });
        expect(h.status).toBe(200);
        expect(h.headers.get("content-length")).toBe(String(bytes.byteLength));
      }
    });

    test("ranges: single, open, suffix, clamped end, unsatisfiable (416 + Content-Range), multi-range served whole", async () => {
      const bytes = await image("png");
      const r = await upload(relay.http, user().sk, bytes);
      const n = bytes.byteLength;
      const get = (range: string, method = "GET") => fetch(`${relay.http}/${r.sha}`, { method, headers: { Range: range } });
      const cases: [string, number, number][] = [
        ["bytes=0-0", 0, 0],
        ["bytes=5-20", 5, 20],
        [`bytes=${n - 3}-`, n - 3, n - 1],
        ["bytes=-7", n - 7, n - 1],
        [`bytes=10-${n + 1000}`, 10, n - 1],
        [`bytes=-${n + 50}`, 0, n - 1],
      ];
      for (const [h, s, e] of cases) {
        const res = await get(h);
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe(`bytes ${s}-${e}/${n}`);
        expect(res.headers.get("content-length")).toBe(String(e - s + 1));
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.subarray(s, e + 1));
        const head = await get(h, "HEAD");
        expect(head.status).toBe(206);
        expect(head.headers.get("content-range")).toBe(`bytes ${s}-${e}/${n}`);
      }
      for (const h of [`bytes=${n}-`, `bytes=${n + 5}-${n + 10}`, "bytes=-0"]) {
        const res = await get(h);
        expect(res.status).toBe(416);
        expect(res.headers.get("content-range")).toBe(`bytes */${n}`);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      }
      const multi = await get("bytes=0-1,5-6");
      expect(multi.status).toBe(200);
      expect((await multi.arrayBuffer()).byteLength).toBe(n);
    });

    test("If-Range: a matching ETag gets the range, anything else the whole blob (RFC 9110 §13.1.5)", async () => {
      const bytes = await image("png");
      const r = await upload(relay.http, user().sk, bytes);
      const get = (ifRange: string) => fetch(`${relay.http}/${r.sha}`, { headers: { Range: "bytes=0-9", "If-Range": ifRange } });
      const match = await get(`"${r.sha}"`);
      expect(match.status).toBe(206);
      expect((await match.arrayBuffer()).byteLength).toBe(10);
      for (const other of [`"${"0".repeat(64)}"`, `W/"${r.sha}"`, "Tue, 01 Jan 2030 00:00:00 GMT"]) {
        const res = await get(other);
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
      }
      // a precondition that can't match the 416 either: the whole blob, not 416
      const past = await fetch(`${relay.http}/${r.sha}`, { headers: { Range: `bytes=${bytes.byteLength + 1}-`, "If-Range": '"nope"' } });
      expect(past.status).toBe(200);
    });

    test("conditional GET: If-None-Match with the ETag, a list, W/ and * is 304 with cache headers", async () => {
      const r = await upload(relay.http, user().sk, await image("png"));
      for (const inm of [`"${r.sha}"`, `"x", "${r.sha}"`, `W/"${r.sha}"`, "*"]) {
        const res = await fetch(`${relay.http}/${r.sha}`, { headers: { "If-None-Match": inm } });
        expect(res.status).toBe(304);
        expect(res.headers.get("etag")).toBe(`"${r.sha}"`);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      }
      expect((await fetch(`${relay.http}/${r.sha}`, { headers: { "If-None-Match": '"other"' } })).status).toBe(200);
    });

    test("concurrent uploads of the same blob by many users: one 201, the rest 200, one stored copy, all owners", async () => {
      const bytes = await image("png");
      const sha = sha256(bytes);
      const users = Array.from({ length: 8 }, () => user());
      const results = await Promise.all(users.map((u) => upload(relay.http, u.sk, bytes)));
      expect(results.map((x) => x.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      for (const x of results) expect(x.body.sha256).toBe(sha);
      if (driver === "fs") expect(fsFiles(relay.dir).filter((f) => f.includes(sha)).sort()).toEqual([sha, `${sha}.thumb.webp`]);
      for (const u of users) {
        const list = await (await fetch(`${relay.http}/list/${u.pubkey}`)).json();
        expect(list.map((d: { sha256: string }) => d.sha256)).toContain(sha);
      }
      // the same user uploading it many times at once: still one ownership, quota charged once
      const solo = user();
      const bytes2 = await image("png");
      const again = await Promise.all(Array.from({ length: 6 }, () => upload(relay.http, solo.sk, bytes2)));
      expect(again.filter((x) => x.status === 201)).toHaveLength(1);
      expect(again.every((x) => x.status === 200 || x.status === 201)).toBe(true);
      const usage = await api(relay.http, relay.owner, "GET", `/users/${solo.pubkey}`);
      if (usage.status === 200 && usage.body?.blossom?.bytes !== undefined) expect(usage.body.blossom.bytes).toBe(bytes2.byteLength);
      // every owner deletes: bytes go once the last one does
      for (const [i, u] of users.entries()) {
        const res = await fetch(`${relay.http}/${sha}`, { method: "DELETE", headers: { Authorization: bauth(u.sk, "delete", { hashes: [sha] }) } });
        expect(res.status).toBe(200);
        expect(await stored(sha)).toBe(i < users.length - 1);
      }
      expect((await fetch(`${relay.http}/${sha}`)).status).toBe(404);
      if (driver === "s3") expect(await s3Head(`${sha}.thumb.webp`)).toBe(404);
      else expect(fsFiles(relay.dir).some((f) => f.includes(sha))).toBe(false);
    });

    test("an upload cut off mid-body leaves no row, no bytes and no temp file", async () => {
      const before = driver === "fs" ? fsFiles(relay.dir).length : 0;
      const u = user();
      const fake = "ab".repeat(32);
      await interruptedUpload(relay.http, bauth(u.sk, "upload", { hashes: [fake] }), 512 * 1024, 64 * 1024);
      await Bun.sleep(300);
      if (driver === "fs") expect(fsFiles(relay.dir).length).toBe(before);
      const list = await (await fetch(`${relay.http}/list/${u.pubkey}`, { headers: { Authorization: bauth(u.sk, "list") } })).json();
      expect(list).toEqual([]);
      // the server is still fine
      expect((await upload(relay.http, u.sk, await image("png"))).status).toBe(201);
    });

    test("size limit: over maxUploadBytes is 413 with or without Content-Length; nothing stored; HEAD /upload agrees", async () => {
      await setBlossom({ maxUploadBytes: 64 * 1024 });
      try {
        const u = user();
        const big = new Uint8Array(64 * 1024 + 1);
        big.set(await image("png"));
        const sha = sha256(big);
        const res = await upload(relay.http, u.sk, big);
        expect(res.status).toBe(413);
        // chunked (no Content-Length)
        const chunked = new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < 5; i++) c.enqueue(big.subarray(i * 16 * 1024, (i + 1) * 16 * 1024));
            c.close();
          },
        });
        const res2 = await fetch(`${relay.http}/upload`, {
          method: "PUT",
          headers: { Authorization: bauth(u.sk, "upload", { hashes: [sha] }) },
          body: chunked,
          duplex: "half",
        } as RequestInit);
        expect(res2.status).toBe(413);
        expect(await stored(sha)).toBe(false);
        const pre = await fetch(`${relay.http}/upload`, {
          method: "HEAD",
          headers: { Authorization: bauth(u.sk, "upload", { hashes: [sha] }), "X-SHA-256": sha, "X-Content-Length": String(big.byteLength), "X-Content-Type": "image/png" },
        });
        expect(pre.status).toBe(413);
        expect(pre.headers.get("x-reason")).toContain("too large");
        // exactly the limit is fine
        const ok = await upload(relay.http, u.sk, big.subarray(0, 64 * 1024));
        expect(ok.status).toBe(201);
      } finally {
        await setBlossom({ maxUploadBytes: 100 * 1024 * 1024 });
      }
    });

    test("quotas: per-user 0 refuses every upload, 2^53-1 is effectively unlimited, null falls back to the default", async () => {
      const u = user();
      const setQuota = (q: number | null) => api(relay.http, relay.owner, "PATCH", `/users/${u.pubkey}`, { blossomQuota: q });
      expect((await setQuota(0)).status).toBe(200);
      const bytes = await image("png");
      const sha = sha256(bytes);
      expect((await upload(relay.http, u.sk, bytes)).status).toBe(413);
      const pre = await fetch(`${relay.http}/upload`, {
        method: "HEAD",
        headers: { Authorization: bauth(u.sk, "upload", { hashes: [sha] }), "X-SHA-256": sha, "X-Content-Length": "1" },
      });
      expect(pre.status).toBe(413);
      expect((await setQuota(Number.MAX_SAFE_INTEGER)).status).toBe(200);
      const pre2 = await fetch(`${relay.http}/upload`, {
        method: "HEAD",
        headers: { Authorization: bauth(u.sk, "upload", { hashes: [sha] }), "X-SHA-256": sha, "X-Content-Length": String(Number.MAX_SAFE_INTEGER - 10) },
      });
      // within the quota (the size limit answers instead)
      expect(pre2.headers.get("x-reason") ?? "").not.toContain("quota");
      await setBlossom({ defaultQuotaBytes: 10 });
      try {
        expect((await upload(relay.http, u.sk, bytes)).status).toBe(201);
        expect((await setQuota(null)).status).toBe(200);
        expect((await upload(relay.http, u.sk, await image("png"))).status).toBe(413);
      } finally {
        await setBlossom({ defaultQuotaBytes: 1024 * 1024 * 1024 });
      }
    });

    test("never runnable: JS as text/plain, wasm opaque, HTML/SVG sandboxed attachments, script destinations refused", async () => {
      await setBlossom({ allowedMimeTypes: ["*"] });
      try {
        const u = user();
        const js = await upload(relay.http, u.sk, new TextEncoder().encode(`alert(${Math.random()})\n`), { type: "text/javascript" });
        expect(js.status).toBe(201);
        const wasm = await upload(relay.http, u.sk, new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...crypto.getRandomValues(new Uint8Array(8))]), { type: "application/wasm" });
        expect(wasm.status).toBe(201);
        const html = await upload(relay.http, u.sk, new TextEncoder().encode(`<!doctype html><script>alert(${Math.random()})</script>`), { type: "text/html" });
        expect(html.status).toBe(201);
        const svg = await upload(relay.http, u.sk, new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(${Math.random()})</script></svg>`), { type: "image/svg+xml" });
        expect(svg.body.type).toBe("image/svg+xml");
        const expectations: [string, string, boolean][] = [
          [js.sha, "text/plain; charset=utf-8", false],
          [wasm.sha, "application/octet-stream", true],
          [html.sha, "text/html", true],
          [svg.sha, "image/svg+xml", true],
        ];
        for (const [sha, type, attachment] of expectations) {
          for (const method of ["GET", "HEAD"]) {
            const res = await fetch(`${relay.http}/${sha}`, { method });
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toBe(type);
            expect(res.headers.get("x-content-type-options")).toBe("nosniff");
            expect(res.headers.get("content-security-policy")).toContain("sandbox");
            if (attachment) expect(res.headers.get("content-disposition")).toStartWith("attachment");
          }
          for (const dest of ["script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet", "xslt", " Script "]) {
            const res = await fetch(`${relay.http}/${sha}`, { headers: { "Sec-Fetch-Dest": dest } });
            expect(res.status).toBe(403);
          }
          expect((await fetch(`${relay.http}/${sha}`, { headers: { "Sec-Fetch-Dest": "image" } })).status).toBe(200);
        }
        if (driver === "s3") {
          // the raw objects in the bucket aren't runnable either if the bucket is ever exposed
          for (const sha of [js.sha, html.sha, svg.sha, wasm.sha]) {
            expect((await s3.stat(sha)).type).toBe("application/octet-stream");
          }
        }
      } finally {
        await setBlossom({ allowedMimeTypes: ["image/*", "video/*", "audio/*", "application/pdf"] });
      }
    });

    test("thumbnails: made with sharp, served from /thumb, removed with the blob", async () => {
      const u = user();
      const r = await upload(relay.http, u.sk, await image("png"));
      expect(r.body.nip94.find((t: string[]) => t[0] === "thumb")?.[1]).toBe(`${relay.http}/thumb/${r.sha}.webp`);
      const t = await fetch(`${relay.http}/thumb/${r.sha}.webp`);
      expect(t.status).toBe(200);
      expect(t.headers.get("content-type")).toBe("image/webp");
      const body = new Uint8Array(await t.arrayBuffer());
      expect(new TextDecoder().decode(body.subarray(8, 12))).toBe("WEBP");
      expect((await fetch(`${relay.http}/thumb/${r.sha}.webp`, { method: "HEAD" })).headers.get("content-length")).toBe(String(body.byteLength));
      await fetch(`${relay.http}/${r.sha}`, { method: "DELETE", headers: { Authorization: bauth(u.sk, "delete", { hashes: [r.sha] }) } });
      expect((await fetch(`${relay.http}/thumb/${r.sha}.webp`)).status).toBe(404);
      if (driver === "s3") expect(await s3Head(`${r.sha}.thumb.webp`)).toBe(404);
    });

    test("EXIF stripping: off stores byte-identical; on stores a clean copy with an ox tag", async () => {
      const u = user();
      const jpeg = await image("jpeg", true);
      expect(Buffer.from(jpeg).includes("GPS-Leak")).toBe(true);
      const off = await upload(relay.http, u.sk, jpeg, { type: "image/jpeg" });
      expect(off.status).toBe(201);
      expect(off.body.sha256).toBe(off.sha);
      await setBlossom({ stripExif: true });
      try {
        const jpeg2 = await image("jpeg", true);
        const on = await upload(relay.http, u.sk, jpeg2, { type: "image/jpeg" });
        expect(on.status).toBe(201);
        expect(on.body.sha256).not.toBe(on.sha);
        expect(on.body.nip94).toContainEqual(["ox", on.sha]);
        const served = new Uint8Array(await (await fetch(`${relay.http}/${on.body.sha256}`)).arrayBuffer());
        expect(sha256(served)).toBe(on.body.sha256);
        expect(Buffer.from(served).includes("GPS-Leak")).toBe(false);
        expect((await fetch(`${relay.http}/${on.sha}`)).status).toBe(404);
        expect(await stored(on.sha)).toBe(false);
      } finally {
        await setBlossom({ stripExif: false });
      }
    });

    test("mirror (BUD-04): stores the remote blob, refuses a wrong hash and an oversized body", async () => {
      const u = user();
      const bytes = await image("png");
      const sha = sha256(bytes);
      let slowHits = 0;
      const origin = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const p = new URL(req.url).pathname;
          if (p === "/blob") return new Response(bytes, { headers: { "content-type": "image/png" } });
          if (p === "/redirect") return Response.redirect("/blob", 302);
          if (p === "/huge") return new Response(new Uint8Array(2 * 1024 * 1024), { headers: { "content-type": "image/png" } });
          if (p === "/slow") {
            slowHits++;
            return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "image/png" } });
          }
          return new Response("no", { status: 404 });
        },
      });
      try {
        const mirror = (url: string, hashes = [sha]) =>
          fetch(`${relay.http}/mirror`, { method: "PUT", headers: { Authorization: bauth(u.sk, "upload", { hashes }), "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        const base = `http://127.0.0.1:${origin.port}`;
        const ok = await mirror(`${base}/redirect`);
        expect(ok.status).toBe(201);
        const d = await ok.json();
        expect(d.sha256).toBe(sha);
        expect(d.type).toBe("image/png");
        expect(await stored(sha)).toBe(true);
        expect((await mirror(`${base}/blob`)).status).toBe(200);
        const wrong = await mirror(`${base}/blob`, ["cd".repeat(32)]);
        expect(wrong.status).toBe(409);
        expect((await mirror(`${base}/missing`, ["cd".repeat(32)])).status).toBe(502);
        await setBlossom({ maxUploadBytes: 1024 * 1024 });
        try {
          expect((await mirror(`${base}/huge`, ["ef".repeat(32)])).status).toBe(413);
        } finally {
          await setBlossom({ maxUploadBytes: 100 * 1024 * 1024 });
        }
        expect(await stored("ef".repeat(32))).toBe(false);
      } finally {
        origin.stop(true);
      }
    });

    test("a 40 MiB blob round-trips byte-exact, with ranges at its tail", async () => {
      const big = new Uint8Array(40 * 1024 * 1024);
      big.set(await image("png"));
      for (let i = 1024; i < big.length; i += 4096) big[i] = i & 255;
      const r = await upload(relay.http, user().sk, big);
      expect(r.status).toBe(201);
      const res = await fetch(`${relay.http}/${r.sha}`);
      // Bun sends a streamed (S3-proxied) body chunked, without the Content-Length the route sets
      if (driver === "fs") expect(res.headers.get("content-length")).toBe(String(big.byteLength));
      expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(r.sha);
      const tail = await fetch(`${relay.http}/${r.sha}`, { headers: { Range: "bytes=-100000" } });
      expect(tail.status).toBe(206);
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(big.subarray(big.length - 100000));
      // a client hanging up mid-download doesn't hurt the server
      const ctrl = new AbortController();
      const partial = await fetch(`${relay.http}/${r.sha}`, { signal: ctrl.signal });
      const reader = partial.body!.getReader();
      await reader.read();
      ctrl.abort();
      expect((await fetch(`${relay.http}/${r.sha}`, { method: "HEAD" })).status).toBe(200);
    });

    test("the last owner deleting while another user uploads the same blob never loses the bytes", async () => {
      for (let i = 0; i < 15; i++) {
        const a = user();
        const b = user();
        const bytes = await image("png");
        const sha = sha256(bytes);
        expect((await upload(relay.http, a.sk, bytes)).status).toBe(201);
        const [del, up] = await Promise.all([
          fetch(`${relay.http}/${sha}`, { method: "DELETE", headers: { Authorization: bauth(a.sk, "delete", { hashes: [sha] }) } }),
          upload(relay.http, b.sk, bytes),
        ]);
        expect(del.status).toBe(200);
        expect([200, 201]).toContain(up.status);
        const res = await fetch(`${relay.http}/${sha}`);
        expect(res.status).toBe(200);
        expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha);
        expect(await stored(sha)).toBe(true);
      }
    });

    test("a moderator's delete+block racing an upload: the blob is never left stored or servable", async () => {
      for (let i = 0; i < 10; i++) {
        const u = user();
        const bytes = await image("png");
        const sha = sha256(bytes);
        const [up, block] = await Promise.all([upload(relay.http, u.sk, bytes), api(relay.http, relay.owner, "DELETE", `/media/${sha}?block=true`)]);
        expect(block.status).toBe(200);
        expect([201, 403]).toContain(up.status);
        expect((await fetch(`${relay.http}/${sha}`)).status).toBe(404);
        expect(await stored(sha)).toBe(false);
        expect((await upload(relay.http, u.sk, bytes)).status).toBe(403);
      }
    });

    test("hash format: uppercase and malformed hashes in paths, headers and tags", async () => {
      const u = user();
      const bytes = await image("png");
      const sha = sha256(bytes);
      // uppercase X-SHA-256 and x tag are the same hash
      const up = await upload(relay.http, null, bytes, { auth: bauth(u.sk, "upload", { hashes: [sha.toUpperCase()] }), headers: { "X-SHA-256": sha.toUpperCase() } });
      expect(up.status).toBe(201);
      expect(up.body.sha256).toBe(sha);
      const bad = await upload(relay.http, u.sk, await image("png"), { headers: { "X-SHA-256": "zz" } });
      expect(bad.status).toBe(400);
      for (const p of [sha.slice(0, 63), `${sha}0`, `${sha}.`, `${sha}..png`]) {
        expect((await fetch(`${relay.http}/${p}`)).status).toBe(404);
      }
    });

    test("CORS on every blossom response", async () => {
      const u = user();
      const r = await upload(relay.http, u.sk, await image("png"));
      const responses = [
        await fetch(`${relay.http}/${r.sha}`),
        await fetch(`${relay.http}/${r.sha}`, { headers: { Range: "bytes=0-1" } }),
        await fetch(`${relay.http}/${r.sha}`, { headers: { Range: "bytes=99999999-" } }),
        await fetch(`${relay.http}/${r.sha}`, { headers: { "If-None-Match": `"${r.sha}"` } }),
        await fetch(`${relay.http}/${"0".repeat(64)}`),
        await fetch(`${relay.http}/list/${u.pubkey}`),
        await fetch(`${relay.http}/upload`, { method: "PUT", body: "x" }),
        await fetch(`${relay.http}/upload`, { method: "HEAD" }),
        await fetch(`${relay.http}/mirror`, { method: "PUT", body: "{}" }),
        await fetch(`${relay.http}/${r.sha}`, { method: "DELETE" }),
        await fetch(`${relay.http}/upload`, { method: "OPTIONS", headers: { Origin: "https://x.example", "Access-Control-Request-Method": "PUT" } }),
      ];
      for (const res of responses) {
        expect([res.url, res.headers.get("access-control-allow-origin")]).toEqual([res.url, "*"]);
      }
      // endpoints this server doesn't implement (BUD-05 /media, BUD-09 /report): a preflight that passes, then a
      // 404 the browser can read, so clients see "not supported" instead of a network error
      for (const p of ["/media", "/report"]) {
        const pre = await fetch(`${relay.http}${p}`, { method: "OPTIONS", headers: { Origin: "https://x.example", "Access-Control-Request-Method": "PUT" } });
        expect(pre.status).toBe(204);
        expect(pre.headers.get("access-control-allow-origin")).toBe("*");
        for (const method of ["HEAD", "PUT", "GET"]) {
          const res = await fetch(`${relay.http}${p}`, { method, headers: { Authorization: bauth(u.sk, "media", { hashes: [r.sha] }) }, body: method === "PUT" ? "x" : undefined });
          expect([p, method, res.status, res.headers.get("access-control-allow-origin")]).toEqual([p, method, 404, "*"]);
        }
      }
    });
  });
}

describe.skipIf(!s3Up)("s3 with a public URL", () => {
  let relay: Booted;
  beforeAll(async () => {
    relay = await boot("s3", { blossom: { s3: { publicUrl: `${S3.endpoint}/${S3.bucket}` } } });
  });
  afterAll(() => relay?.stop());

  test("inline-safe blobs redirect to the bucket, ranges and HEAD too; active types are proxied", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, await image("png"));
    const res = await fetch(`${relay.http}/${r.sha}.png`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${S3.endpoint}/${S3.bucket}/${r.sha}`);
    const ranged = await fetch(`${relay.http}/${r.sha}`, { redirect: "manual", headers: { Range: "bytes=0-3" } });
    expect(ranged.status).toBe(307);
  });

  test("requireApproval: pending blobs are quarantined in the bucket and moved on approval", async () => {
    await api(relay.http, relay.owner, "PATCH", "/settings", { blossom: { requireApproval: true } });
    try {
      const u = user();
      const r = await upload(relay.http, u.sk, await image("png"));
      expect(r.status).toBe(201);
      expect(await s3Head(r.sha)).toBe(404);
      expect((await fetch(`${relay.http}/${r.sha}`)).status).toBe(404);
      const owner = await fetch(`${relay.http}/${r.sha}`, { redirect: "manual", headers: { Authorization: bauth(u.sk, "get", { hashes: [r.sha] }) } });
      expect(owner.status).toBe(200);
      expect(owner.headers.get("cache-control")).toContain("no-store");
      expect((await fetch(`${relay.http}/thumb/${r.sha}.webp`, { headers: { Authorization: bauth(u.sk, "get", { hashes: [r.sha] }) } })).status).toBe(200);
      expect((await api(relay.http, relay.owner, "POST", `/media/${r.sha}/status`, { status: "approved" })).status).toBe(200);
      expect(await s3Head(r.sha)).toBe(200);
      expect(await s3Head(`${r.sha}.thumb.webp`)).toBe(200);
      expect((await fetch(`${relay.http}/${r.sha}`, { redirect: "manual" })).status).toBe(307);
    } finally {
      await api(relay.http, relay.owner, "PATCH", "/settings", { blossom: { requireApproval: false } });
    }
  });
});

describe.skipIf(!s3Up)("s3 failures", () => {
  test("an unreachable or refusing bucket: uploads fail cleanly (5xx), nothing is recorded, the relay keeps serving", async () => {
    const closed = await freePort();
    for (const s3 of [{ endpoint: `http://127.0.0.1:${closed}` }, { secretAccessKey: "wrong-secret" }, { bucket: "blossom-tests-missing" }]) {
      const relay = await boot("s3", { blossom: { s3 } });
      try {
        const u = user();
        const r = await upload(relay.http, u.sk, await image("png"));
        expect(r.status).toBeGreaterThanOrEqual(500);
        expect(r.headers.get("x-reason")).toBe("internal error");
        expect(await (await fetch(`${relay.http}/list/${u.pubkey}`, { headers: { Authorization: bauth(u.sk, "list") } })).json()).toEqual([]);
        expect((await fetch(`${relay.http}/${r.sha}`)).status).toBe(404);
        expect((await fetch(`${relay.http}/`)).status).toBeLessThan(500);
      } finally {
        await relay.stop();
      }
    }
  }, 30_000);

  test("a blob whose object vanished from the bucket: GET is an error, re-uploading restores it", async () => {
    const relay = await boot("s3");
    try {
      const u = user();
      const bytes = await image("png");
      const r = await upload(relay.http, u.sk, bytes);
      await s3.delete(r.sha);
      const res = await fetch(`${relay.http}/${r.sha}`);
      expect(res.status).toBe(404);
      // a re-upload puts the bytes back (the driver's "known to be stored" cache doesn't vouch for them any more)
      const again = await upload(relay.http, user().sk, bytes);
      expect(again.status).toBe(200);
      const back = await fetch(`${relay.http}/${r.sha}`);
      expect(back.status).toBe(200);
      expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);
      expect(await s3.exists(r.sha)).toBe(true);
    } finally {
      await relay.stop();
    }
  });
});

describe("without sharp", () => {
  let relay: Booted;
  beforeAll(async () => {
    relay = await boot("fs", {}, { useSharp: false });
  });
  afterAll(() => relay?.stop());

  test("no thumbnails, and EXIF stripping (when on) falls back to the lossless pure-JS stripper", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, await image("png"));
    expect(r.status).toBe(201);
    expect(r.body.nip94.some((t: string[]) => t[0] === "thumb")).toBe(false);
    expect((await fetch(`${relay.http}/thumb/${r.sha}.webp`)).status).toBe(404);
    await api(relay.http, relay.owner, "PATCH", "/settings", { blossom: { stripExif: true } });
    const jpeg = await image("jpeg", true);
    const s = await upload(relay.http, u.sk, jpeg, { type: "image/jpeg" });
    expect(s.status).toBe(201);
    expect(s.body.sha256).not.toBe(s.sha);
    const served = Buffer.from(await (await fetch(`${relay.http}/${s.body.sha256}`)).arrayBuffer());
    expect(served.includes("GPS-Leak")).toBe(false);
    expect(served.includes("BeamhopCam")).toBe(false);
    // still a JPEG
    expect([...served.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });
});

describe("mirror sources that misbehave", () => {
  let relay: Booted;
  let origin: ReturnType<typeof Bun.serve>;
  const u = user();
  beforeAll(async () => {
    relay = await boot("fs", { blossom: { limits: { mirrorTimeoutMs: 1500, uploadStallMs: 1000 } } });
    await api(relay.http, relay.owner, "PATCH", "/settings", { blossom: { maxUploadBytes: 256 * 1024 } });
    origin = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const p = new URL(req.url).pathname;
        // headers, then nothing
        if (p === "/stall") return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "image/png" } });
        // a trickle that never ends
        if (p === "/trickle") {
          let n = 0;
          return new Response(
            new ReadableStream({
              async pull(c) {
                await Bun.sleep(200);
                c.enqueue(new Uint8Array([n++ & 255]));
              },
            }),
            { headers: { "content-type": "image/png" } },
          );
        }
        // chunked, bigger than the limit, no Content-Length
        if (p === "/endless") {
          return new Response(
            new ReadableStream({
              pull(c) {
                c.enqueue(new Uint8Array(64 * 1024));
              },
            }),
            { headers: { "content-type": "image/png" } },
          );
        }
        // lies about its length
        if (p === "/short") return new Response(new Uint8Array(10), { headers: { "content-type": "image/png", "content-length": "10" } });
        if (p === "/loop") return Response.redirect("/loop", 302);
        if (p === "/headers-never") return new Promise<Response>(() => {});
        return new Response("no", { status: 404 });
      },
    });
  });
  afterAll(async () => {
    origin?.stop(true);
    await relay?.stop();
  });
  const mirror = (path: string, hash = "ab".repeat(32)) =>
    fetch(`${relay.http}/mirror`, {
      method: "PUT",
      headers: { Authorization: bauth(u.sk, "upload", { hashes: [hash] }), "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${origin.port}${path}` }),
    });

  test("stalled, trickling and header-less origins time out (504) within the mirror timeout", async () => {
    for (const p of ["/stall", "/trickle", "/headers-never"]) {
      const t = Date.now();
      const res = await mirror(p);
      expect([p, res.status]).toEqual([p, 504]);
      expect(Date.now() - t).toBeLessThan(5000);
    }
  });

  test("an endless chunked body is cut off at the size limit (413); redirect loops are a 502", async () => {
    expect((await mirror("/endless")).status).toBe(413);
    expect((await mirror("/loop")).status).toBe(502);
    expect((await mirror("/short")).status).toBe(409);
    expect(fsFiles(relay.dir)).toEqual([]);
  });
});
