import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clientIp, parseRange } from "../src/http";
import { hasMetadataMarker } from "../src/image";
import { isInlineSafe } from "../src/mime";
import { fetchRemote, isPrivateAddress, parseIpv6 } from "../src/mirror";
import type { BlobDriver } from "../src/driver";
import { PNG_1x1, authHeader, createHarness, newUser, sha256, type Harness, xOf } from "./fakes";

let h: Harness;
const alice = newUser();
const bob = newUser();

const SVG = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/admin/api/me')</script></svg>`);
/** minimal ISO-BMFF with a `heic` brand and an EXIF payload */
const HEIC_WITH_EXIF = new Uint8Array([
  0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0, ...new TextEncoder().encode("mif1heic"),
  0, 0, 0, 0x14, ...new TextEncoder().encode("Exif"), 0, 0, ...new TextEncoder().encode("GPS-LAT-LON!"),
]);

function upload(data: Uint8Array, opts: { user?: typeof alice; type?: string } = {}) {
  const u = opts.user ?? alice;
  return h.request("/upload", { method: "PUT", body: data as BodyInit, headers: { authorization: authHeader(u.sk, "upload", { x: [xOf(data)] }), "content-type": opts.type ?? "application/octet-stream" } });
}

afterEach(() => h?.cleanup());

describe("SSRF guard", () => {
  test("IPv6 forms that embed private IPv4 are private", () => {
    for (const ip of [
      "::ffff:7f00:1", // ::ffff:127.0.0.1 as normalized by the URL parser
      "::ffff:a9fe:a9fe", // 169.254.169.254
      "::ffff:127.0.0.1",
      "::7f00:1", // IPv4-compatible
      "::127.0.0.1",
      "64:ff9b::7f00:1", // NAT64
      "64:ff9b::a00:1",
      "64:ff9b:1::1", // local-use NAT64
      "2002:7f00:1::", // 6to4 of 127.0.0.1
      "2002:c0a8:101::1", // 6to4 of 192.168.1.1
      "2001:0:4136:e378::1", // Teredo
      "::ffff:0:a00:1", // SIIT
      "fd00::1",
      "fe80::1%eth0",
      "febf::1",
      "fec0::1",
      "ff02::1",
      "::",
      "::1",
      "[::1]",
      "100::1",
      "2001:db8::1",
      "192.0.0.8",
      "198.51.100.3",
      "not-an-ip",
    ]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
  });

  test("public addresses pass", () => {
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1", "8.8.8.8", "1.1.1.1"]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    }
  });

  test("parseIpv6 expands every notation", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("1::2::3")).toBeUndefined();
    expect(parseIpv6("1:2:3")).toBeUndefined();
  });

  test("mirror to an IPv4-mapped metadata address is refused before any request", async () => {
    let called = false;
    const fetchFn = (async () => ((called = true), new Response("x"))) as unknown as typeof fetch;
    for (const url of ["http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[64:ff9b::a9fe:a9fe]/", "http://[2002:7f00:1::]/"]) {
      await expect(fetchRemote(url, { fetch: fetchFn, allowPrivate: false, timeoutMs: 1000 })).rejects.toMatchObject({ status: 403 });
    }
    expect(called).toBe(false);
  });

  test("redirects to private targets are re-checked", async () => {
    const fetchFn = (async () => new Response(null, { status: 302, headers: { location: "http://[::ffff:7f00:1]:8080/" } })) as unknown as typeof fetch;
    await expect(fetchRemote("http://93.184.215.14/x", { fetch: fetchFn, allowPrivate: false, timeoutMs: 1000 })).rejects.toMatchObject({ status: 403 });
  });

  test("built-in client refuses hosts that resolve to private addresses at connect time", async () => {
    // `localtest.me`-style names aren't reliable offline; an IP literal exercises the same pinned client path
    await expect(fetchRemote("http://127.0.0.1:9/", { allowPrivate: false, timeoutMs: 1000 })).rejects.toMatchObject({ status: 403 });
  });
});

describe("serving user content safely", () => {
  beforeEach(async () => {
    h = await createHarness({ useSharp: false });
  });

  test("SVG is served with nosniff, a sandbox CSP and as a download", async () => {
    const res = await upload(SVG, { type: "image/svg+xml" });
    expect(res.status).toBe(201);
    const { sha256: hash, type } = await res.json();
    expect(type).toBe("image/svg+xml");
    const get = await h.request(`/${hash}.svg`);
    expect(get.status).toBe(200);
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-security-policy")).toContain("sandbox");
    expect(get.headers.get("content-disposition")).toStartWith("attachment");
  });

  test("passive media renders inline (but still nosniff + CSP)", async () => {
    const { sha256: hash } = await (await upload(PNG_1x1)).json();
    const get = await h.request(`/${hash}`);
    expect(get.headers.get("content-disposition")).toBe("inline");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("isInlineSafe", () => {
    for (const t of ["image/png", "image/jpeg", "video/mp4", "audio/ogg", "text/plain", "application/pdf"]) expect([t, isInlineSafe(t)]).toEqual([t, true]);
    for (const t of ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "text/javascript", "application/octet-stream", "application/json"]) {
      expect([t, isInlineSafe(t)]).toEqual([t, false]);
    }
  });

  test("CDN redirect is skipped for active types", async () => {
    await h.cleanup();
    const inner = (await createHarness({ useSharp: false })).svc.driver;
    const driver: BlobDriver = { ...inner, name: "cdn", publicUrl: (sha) => `https://media.test/${sha}` } as BlobDriver;
    h = await createHarness({ useSharp: false, driver });
    const png = (await (await upload(PNG_1x1)).json()).sha256;
    const svg = (await (await upload(SVG, { type: "image/svg+xml" })).json()).sha256;
    expect((await h.request(`/${png}`)).status).toBe(307);
    const res = await h.request(`/${svg}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toStartWith("attachment");
  });
});

describe("auth on read endpoints only widens access", () => {
  beforeEach(async () => {
    h = await createHarness({ useSharp: false });
  });

  test("malformed token on a pending blob is a 404, not a 401", async () => {
    await h.deps.settings.update({ blossom: { requireApproval: true } }, "test");
    const { sha256: hash } = await (await upload(PNG_1x1)).json();
    for (const authorization of ["Nostr !!!", authHeader(bob.sk, "get", { expiration: 1 })]) {
      const res = await h.request(`/${hash}`, { headers: { authorization } });
      expect(res.status).toBe(404);
    }
    // the owner still gets it
    expect((await h.request(`/${hash}`, { headers: { authorization: authHeader(alice.sk, "get") } })).status).toBe(200);
  });

  test("malformed token on /list falls back to the public listing", async () => {
    await upload(PNG_1x1);
    const res = await h.request(`/list/${alice.pubkey}`, { headers: { authorization: "Nostr garbage" } });
    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(1);
  });
});

describe("ranges", () => {
  test("invalid ranges are ignored, unsatisfiable ones are 416", () => {
    expect(parseRange("bytes=5-2", 10)).toBeUndefined();
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  });

  test("GET with an inverted range serves the full body; HEAD mirrors GET's 206", async () => {
    h = await createHarness({ useSharp: false });
    const { sha256: hash } = await (await upload(PNG_1x1)).json();
    const full = await h.request(`/${hash}`, { headers: { range: "bytes=5-2" } });
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(PNG_1x1);
    const head = await h.request(`/${hash}`, { method: "HEAD", headers: { range: "bytes=0-3" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-3/${PNG_1x1.length}`);
    expect(head.headers.get("content-length")).toBe("4");
  });
});

describe("client ip", () => {
  const req = (xff?: string) => new Request("https://x/", { headers: xff ? { "x-forwarded-for": xff } : {} });
  test("prefers the adapter-provided ip", () => {
    expect(clientIp(req("6.6.6.6"), true, { ip: "::ffff:203.0.113.4" })).toBe("203.0.113.4");
  });
  test("standalone: the rightmost forwarded hop wins (left entries are client-supplied)", () => {
    expect(clientIp(req("6.6.6.6, 203.0.113.4"), true)).toBe("203.0.113.4");
    expect(clientIp(req("6.6.6.6"), false, { remoteAddress: "10.0.0.2" })).toBe("10.0.0.2");
  });
});

describe("metadata the pure-JS stripper can't remove", () => {
  test("HEIC with EXIF is refused without sharp instead of being published", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { stripExif: true, allowedMimeTypes: ["image/*"] } }, "test");
    expect(hasMetadataMarker(HEIC_WITH_EXIF, "image/heic")).toBe(true);
    const res = await upload(HEIC_WITH_EXIF, { type: "image/heic" });
    expect(res.status).toBe(415);
  });
});

describe("ingest races", () => {
  beforeEach(async () => {
    h = await createHarness({ useSharp: false });
  });

  test("a delete racing a second owner's upload never leaves a dangling descriptor", async () => {
    const hash = await sha256(PNG_1x1);
    await upload(PNG_1x1, { user: alice });
    const del = h.request(`/${hash}`, { method: "DELETE", headers: { authorization: authHeader(alice.sk, "delete", { x: [hash] }) } });
    const up = upload(PNG_1x1, { user: bob });
    const [d, u] = await Promise.all([del, up]);
    expect(d.status).toBe(200);
    expect(u.status).toBe(201);
    expect((await h.request(`/${hash}`)).status).toBe(200);
    expect(await h.svc.driver.has(hash)).toBe(true);
  });

  test("parallel uploads can't jointly exceed the quota", async () => {
    await h.deps.settings.update({ blossom: { defaultQuotaBytes: 150, allowedMimeTypes: [] } }, "test");
    const blobs = [1, 2, 3].map((n) => new Uint8Array(100).fill(n));
    const res = await Promise.all(blobs.map((b) => upload(b)));
    expect(res.map((r) => r.status).sort()).toEqual([201, 413, 413]);
  });
});
