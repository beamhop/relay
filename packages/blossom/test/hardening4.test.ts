import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { ConfigSchema } from "@beamhop/sdk";
import { createFsDriver, createS3Driver, optionsFromConfig, stripJpegMetadata } from "../src";
import { exifOrientation, pngHasPrivateText } from "../src/exif";
import { readLimited } from "../src/http";
import { pinnedFetch } from "../src/mirror";
import { PNG_1x1, authHeader, createHarness, newUser, sha256, type Harness, xOf } from "./fakes";

let h: Harness;
afterEach(() => h?.cleanup());
const alice = newUser();
const bob = newUser();

const upload = (body: Uint8Array, sk = alice.sk, headers: Record<string, string> = {}) =>
  h.request("/upload", { method: "PUT", body: body as BodyInit, headers: { authorization: authHeader(sk, "upload", { x: [xOf(body)] }), ...headers } });
/** distinct blobs that no stripping pass rewrites (stripped PNG variants would all collapse to one hash) */
const pdf = (n: number) => new TextEncoder().encode(`%PDF-1.4\n% ${n}\n%%EOF\n`);
const allowPdf = () => h.deps.settings.update({ blossom: { allowedMimeTypes: ["application/pdf", "image/*"] } } as never, "test");

/** Raw TCP server answering every request with `status` (and recording the request head). */
async function rawServer(status: number) {
  const heads: string[] = [];
  const srv = net.createServer((s) => {
    s.once("data", (d) => {
      heads.push(String(d));
      s.end(`HTTP/1.1 ${status} X\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi`);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return { url: new URL(`http://127.0.0.1:${port}/x`), heads, close: () => srv.close() };
}

describe("mirror client never throws inside socket callbacks", () => {
  // an exception there would be uncaught and kill the process; the IP literal skips the DNS check, as the caller's
  // own SSRF check already ran by then
  for (const status of [999, 600, 101]) {
    test(`upstream status ${status} is a 502, not a crash`, async () => {
      const s = await rawServer(status);
      try {
        await expect(pinnedFetch(s.url, { signal: AbortSignal.timeout(2000) })).rejects.toMatchObject({ status: 502 });
      } finally {
        s.close();
      }
    });
  }
  test("null-body statuses (205, 204) resolve without a body; requests carry a User-Agent", async () => {
    for (const status of [205, 204]) {
      const s = await rawServer(status);
      try {
        const res = await pinnedFetch(s.url, { signal: AbortSignal.timeout(2000) });
        expect(res.status).toBe(status);
        expect(res.body).toBeNull();
        expect(s.heads[0]).toMatch(/user-agent: beamhop\//i);
      } finally {
        s.close();
      }
    }
  });
});

describe("plugin upload hooks run outside the blob/owner locks", () => {
  test("a hook acting on the blob being uploaded doesn't deadlock, and the slots are released", async () => {
    h = await createHarness({ useSharp: false, maxConcurrentUploads: 1, maxQueuedUploads: 0 });
    expect((await upload(PNG_1x1)).status).toBe(201);
    const x = await sha256(PNG_1x1);
    let calls = 0;
    h.deps.hooks.onBlobUpload(async (info) => {
      if (!(await h.svc.get(info.sha256))) return undefined;
      calls++;
      await h.svc.setStatus(info.sha256, "pending", "plugin");
      await h.svc.setStatus(info.sha256, "approved", "plugin");
      return undefined;
    }, "test");
    const res = await Promise.race([upload(PNG_1x1, bob.sk), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000))]);
    expect(res).not.toBe("timeout");
    expect((res as Response).status).toBe(200);
    expect(calls).toBe(1);
    expect((await h.svc.get(x))?.owners.sort()).toEqual([alice.pubkey, bob.pubkey].sort());
    // the single ingest slot is free again: no 503
    await allowPdf();
    expect((await upload(pdf(9), bob.sk)).status).toBe(201);
  });

  test("a hook deleting the blob mid-upload: the upload stores it afresh", async () => {
    h = await createHarness({ useSharp: false });
    expect((await upload(PNG_1x1)).status).toBe(201);
    const x = await sha256(PNG_1x1);
    h.deps.hooks.onBlobUpload(async (info) => (await h.svc.delete(info.sha256, "plugin"), undefined), "test");
    const res = await Promise.race([upload(PNG_1x1, bob.sk), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000))]);
    expect((res as Response).status).toBe(201);
    expect((await h.svc.get(x))?.owners).toEqual([bob.pubkey]);
  });
});

describe("owner lock covers only quota → insert", () => {
  test("one client's uploads of different blobs store their bytes concurrently; the quota still holds", async () => {
    let active = 0;
    let peak = 0;
    const dir = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/bh-slow-`);
    const fsd = createFsDriver(dir);
    const driver = {
      ...fsd,
      async put(...args: Parameters<typeof fsd.put>) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 40));
        try {
          return await fsd.put(...args);
        } finally {
          active--;
        }
      },
    };
    h = await createHarness({ useSharp: false, driver });
    await allowPdf();
    const bodies = [1, 2, 3].map(pdf);
    const results = await Promise.all(bodies.map((b) => upload(b)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(peak).toBeGreaterThan(1);

    // quota: 2 more blobs of this size fit, 3 parallel uploads → exactly 2 succeed, the loser's bytes are removed
    const used = (await h.svc.usage(alice.pubkey)).bytes;
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: used + 2 * pdf(4).length });
    const more = [4, 5, 6].map(pdf);
    const statuses = (await Promise.all(more.map((b) => upload(b)))).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 413]);
    for (const b of more) {
      const x = await sha256(b);
      const row = await h.svc.get(x);
      expect(await fsd.has(x)).toBe(!!row);
    }
  });
});

describe("upload limits are configurable", () => {
  test("config.blossom.limits feed the service options", () => {
    const config = ConfigSchema.parse({ blossom: { limits: { maxConcurrentUploadsPerIp: 12, maxBufferedUploadBytes: 1 << 30, mirrorPorts: [443] } } });
    expect(optionsFromConfig(config)).toEqual({ maxConcurrentUploadsPerIp: 12, maxBufferedUploadBytes: 1 << 30, mirrorPorts: [443] });
    expect(optionsFromConfig(ConfigSchema.parse({}))).toEqual({});
  });

  test("an announced body that can't fit the budget is refused before it is read", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(100));
      },
    });
    await expect(readLimited(body, 10_000, 5000, { admit: (n) => n <= 1000, reserve: () => true })).rejects.toMatchObject({ status: 503 });
    expect(pulled).toBeLessThanOrEqual(1); // at most the stream's initial pull, never consumed
  });
});

describe("S3 with AWS semantics (403 for missing keys without s3:ListBucket)", () => {
  function awsLikeS3() {
    const objects = new Map<string, Uint8Array>();
    const deny = () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const fetchFn = (async (input: Request) => {
      const req = input instanceof Request ? input : new Request(input);
      const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/bucket\//, ""));
      const obj = objects.get(key);
      switch (req.method) {
        case "PUT": {
          const src = req.headers.get("x-amz-copy-source");
          if (src) {
            const from = objects.get(decodeURIComponent(src.replace(/^\/bucket\//, "")));
            if (!from) return deny();
            objects.set(key, from);
            return new Response("<CopyObjectResult/>", { status: 200 });
          }
          objects.set(key, new Uint8Array(await req.arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        case "HEAD":
          return obj ? new Response(null, { status: 200 }) : deny();
        case "DELETE":
          objects.delete(key);
          return new Response(null, { status: 204 });
        case "GET":
          return obj ? new Response(obj as BodyInit, { headers: { "content-length": String(obj.length) } }) : deny();
      }
      return new Response(null, { status: 405 });
    }) as unknown as typeof fetch;
    return { objects, fetchFn };
  }

  test("pending blob without a thumbnail: owner can read it, approval moves it, a retry is harmless", async () => {
    const s3 = awsLikeS3();
    const driver = createS3Driver({ endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", publicUrl: "https://cdn.test", fetch: s3.fetchFn });
    h = await createHarness({ useSharp: false, driver });
    await h.deps.settings.update({ blossom: { requireApproval: true, allowedMimeTypes: ["application/pdf"] } } as never, "test");
    const body = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    const x = await sha256(body);
    const up = await h.request("/upload", { method: "PUT", body: body as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { x: [x] }), "content-type": "application/pdf" } });
    expect(up.status).toBe(201);
    expect(s3.objects.has(x)).toBe(false);
    const own = await h.request(`/${x}`, { headers: { authorization: authHeader(alice.sk, "get", { x: [x] }) } });
    expect(own.status).toBe(200);

    await h.svc.setStatus(x, "approved", "admin");
    expect((await h.svc.get(x))?.status).toBe("approved");
    expect(s3.objects.has(x)).toBe(true);
    // a re-run after a move that already happened (e.g. db write failed afterwards) succeeds
    await driver.setHidden!(x, false, { hasThumbnail: false });
    expect(s3.objects.has(x)).toBe(true);
    expect([200, 307]).toContain((await h.request(`/${x}`)).status); // public: served or redirected to the CDN
  });
});

describe("HEIC/HEIF with metadata that can't be stripped", () => {
  test("is refused with an actionable 415", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { stripExif: true } } as never, "test");
    const box = (type: string, payload: number[]) => {
      const len = 8 + payload.length;
      return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...[...type].map((c) => c.charCodeAt(0)), ...payload];
    };
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const heic = Uint8Array.from([...box("ftyp", [...ascii("heic"), 0, 0, 0, 0, ...ascii("mif1heic")]), ...box("mdat", [...ascii("Exif"), 0, 0, ...ascii("MM GPS")])]);
    const res = await upload(heic);
    expect(res.status).toBe(415);
    expect(res.headers.get("x-reason")).toMatch(/convert it to JPEG, PNG or WebP/);
  });
});

describe("delete tokens", () => {
  test("one token listing several x tags deletes each blob once; a retry for a deleted blob is a 404", async () => {
    h = await createHarness({ useSharp: false });
    await allowPdf();
    const a = pdf(1);
    const b = pdf(2);
    expect((await upload(a)).status).toBe(201);
    expect((await upload(b)).status).toBe(201);
    const [xa, xb] = [await sha256(a), await sha256(b)];
    const token = authHeader(alice.sk, "delete", { x: [xa, xb] });
    const del = (x: string) => h.request(`/${x}`, { method: "DELETE", headers: { authorization: token } });
    expect((await del(xa)).status).toBe(200);
    expect((await del(xb)).status).toBe(200);
    expect((await del(xa)).status).toBe(404); // lost-response retry
    expect((await upload(a)).status).toBe(201);
    expect((await del(xa)).status).toBe(401); // replay against the re-uploaded blob
  });
});

describe("hash stability and orientation", () => {
  test("only PNG text chunks holding metadata profiles count as private", () => {
    const chunk = (type: string, body: number[]) => {
      const len = body.length;
      return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0];
    };
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const sig = [...PNG_1x1.subarray(0, 8)];
    const rest = [...PNG_1x1.subarray(8)];
    const withSoftware = Uint8Array.from([...sig, ...chunk("tEXt", [...ascii("Software"), 0, ...ascii("GIMP")]), ...rest]);
    const withProfile = Uint8Array.from([...sig, ...chunk("zTXt", [...ascii("Raw profile type exif"), 0, 0, 1, 2, 3]), ...rest]);
    expect(pngHasPrivateText(PNG_1x1)).toBe(false);
    expect(pngHasPrivateText(withSoftware)).toBe(false);
    expect(pngHasPrivateText(withProfile)).toBe(true);
  });

  test("pure-JS JPEG stripping keeps a non-default orientation (and nothing else from EXIF)", () => {
    const seg = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload];
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    // big-endian TIFF, IFD0 with Orientation=6 and a GPS-ish ASCII tag
    const tiff = [...ascii("MM"), 0, 42, 0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0x01, 0x0e, 0, 2, 0, 0, 0, 4, ...ascii("GPS!"), 0, 0, 0, 0];
    const app1 = seg(0xe1, [...ascii("Exif"), 0, 0, ...tiff]);
    expect(exifOrientation(Uint8Array.from(app1.slice(4)))).toBe(6);
    const jpeg = Uint8Array.from([0xff, 0xd8, ...app1, ...seg(0xdb, [0, ...new Array(64).fill(1)]), ...seg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0xd9]);
    const out = stripJpegMetadata(jpeg);
    expect(out.stripped).toBe(true);
    const text = new TextDecoder("latin1").decode(out.data);
    expect(text).not.toContain("GPS!");
    // the re-emitted APP1 carries orientation 6
    const i = out.data.indexOf(0xe1, 2);
    expect(out.data[i - 1]).toBe(0xff);
    const len = (out.data[i + 1] << 8) | out.data[i + 2];
    expect(exifOrientation(out.data.subarray(i + 3, i + 1 + len))).toBe(6);
  });
});

describe("downloads", () => {
  test("forced downloads are named with the type's extension", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { allowedMimeTypes: ["application/pdf"] } } as never, "test");
    const body = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    const up = await h.request("/upload", { method: "PUT", body: body as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(body)] }), "content-type": "application/pdf" } });
    const x = (await up.json()).sha256;
    const res = await h.request(`/${x}`);
    const cd = res.headers.get("content-disposition");
    if (cd) expect(cd).toBe(`attachment; filename="${x}.pdf"`);
  });
});
