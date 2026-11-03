/**
 * Adversarial Blossom clients: path traversal in blob / list / thumb paths, active content (HTML, SVG, JS, XHTML,
 * polyglots) uploaded under lying Content-Types, mirror SSRF to loopback / link-local / private / reserved targets in
 * every literal spelling, and Range header abuse.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { sha256 } from "../harness/client";
import { api, bauth, upload, user } from "./admin-helpers";
import { looksLikeLeak, rawHttp } from "./adv-helpers";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay({ overrides: { blossom: { limits: { uploadsPerMinutePerIp: 0, uploadsPerMinutePerPubkey: 0 } } } });
});
afterAll(() => relay?.stop());

const setBlossom = async (patch: Record<string, unknown>) => {
  const r = await api(relay.http, relay.owner.sk, "PATCH", "/settings", { blossom: patch });
  expect(r.status).toBe(200);
};
const rawGet = (path: string) => rawHttp(relay.port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const bytes = (s: string | Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(typeof s === "string" ? Buffer.from(s) : s);
const uniq = () => `<!-- ${Math.random()} -->`;

describe("path traversal", () => {
  test("blob, list and thumb paths never resolve outside their namespace", async () => {
    const u = user();
    const up = await upload(relay.http, u.sk, new Uint8Array(Buffer.concat([PNG, Buffer.from(uniq())])));
    expect(up.status).toBe(201);
    const h = up.sha;
    const paths = [
      "/../e2e.db",
      "/%2e%2e/e2e.db",
      "/%2e%2e%2fe2e.db",
      "/..%2f..%2f..%2fetc%2fpasswd",
      "/..%5c..%5ce2e.db",
      "/..\\..\\e2e.db",
      `/${h}/../e2e.db`,
      `/${h}%2f..%2fe2e.db`,
      `/${h}.png/../../e2e.db`,
      `/${h}.%2e%2e%2fe2e`,
      `/${h}.png%00.html`,
      `/${h.toUpperCase()}`,
      `/list/${u.pubkey}/../../e2e.db`,
      `/list/..%2f..%2fe2e.db`,
      `/list/${"..%2f".repeat(10)}`,
      `/list/${u.pubkey}%2f..`,
      `/thumb/../e2e.db`,
      `/thumb/${h}.webp/../../e2e.db`,
      `/thumb/..%2f${h}.webp`,
      "/blobs/",
      `/blobs/${h.slice(0, 2)}/${h}`,
      "/e2e.db",
      "/e2e.db-wal",
    ];
    for (const p of paths) {
      const r = await rawGet(p);
      // never the database, never a directory listing, never a stack
      expect(r.body).not.toContain("SQLite format");
      expect(r.body).not.toContain("root:");
      expect(looksLikeLeak(r.body, [relay.dir])).toBeUndefined();
      expect(r.status === 404 || r.status === 400 || (r.status === 200 && r.body.startsWith("[]"))).toBe(true);
    }
    // the legitimate spellings still work
    expect((await rawGet(`/${h}`)).status).toBe(200);
    expect((await rawGet(`/${h}.png`)).status).toBe(200);
  });

  test("DELETE and list with traversal-shaped pubkeys or hashes are not routed", async () => {
    const u = user();
    for (const p of [`/..%2f${"a".repeat(64)}`, `/${"a".repeat(64)}/..`, `/${"a".repeat(63)}g`]) {
      const r = await fetch(`${relay.http}${p}`, { method: "DELETE", headers: { Authorization: bauth(u.sk, "delete", { hashes: ["a".repeat(64)] }) } });
      expect([400, 404]).toContain(r.status);
    }
    // malformed parameters are refused (BUD-12), never quietly read as "first page"
    for (const q of ["cursor=..%2f..", "since=-1", "until=1e999", "limit=abc"]) {
      expect((await fetch(`${relay.http}/list/${u.pubkey}?${q}`)).status).toBe(400);
    }
    // overlong digit strings are clamped, not passed through to the database
    const list = await fetch(`${relay.http}/list/${u.pubkey}?since=0&until=99999999999999999999&limit=99999999999999999999`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });
});

describe("active content is never served runnable", () => {
  beforeAll(() => setBlossom({ allowedMimeTypes: [] })); // allow everything: the serving headers must carry the defence
  afterAll(() => setBlossom({ allowedMimeTypes: ["image/*", "video/*", "audio/*", "application/pdf"] }));

  const cases: { name: string; body: Uint8Array<ArrayBuffer>; declared: string; stored: string; attachment: boolean }[] = [
    { name: "SVG with script", body: bytes(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>${uniq()}`), declared: "image/svg+xml", stored: "image/svg+xml", attachment: true },
    { name: "SVG labelled image/png", body: bytes(`<?xml version="1.0"?>${uniq()}<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), declared: "image/png", stored: "image/svg+xml", attachment: true },
    { name: "SVG labelled text/plain", body: bytes(`${uniq()}<svg><script>alert(1)</script></svg>`), declared: "text/plain", stored: "image/svg+xml", attachment: true },
    { name: "HTML", body: bytes(`<!doctype html><script>alert(document.cookie)</script>${uniq()}`), declared: "text/html", stored: "text/html", attachment: true },
    { name: "HTML labelled image/png", body: bytes(`<!doctype html><script>alert(1)</script>${uniq()}`), declared: "image/png", stored: "application/octet-stream", attachment: true },
    { name: "XHTML", body: bytes(`<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script>${uniq()}</html>`), declared: "application/xhtml+xml", stored: "application/octet-stream", attachment: true },
    { name: "JavaScript", body: bytes(`alert(1)//${uniq()}`), declared: "text/javascript", stored: "text/javascript", attachment: true },
    { name: "HTML labelled text/plain", body: bytes(`<html><script>alert(1)</script>${uniq()}</html>`), declared: "text/plain", stored: "text/plain", attachment: false },
    { name: "PNG/HTML polyglot", body: new Uint8Array(Buffer.concat([PNG, Buffer.from(`<html><script>alert(1)</script>${uniq()}</html>`)])), declared: "text/html", stored: "image/png", attachment: false },
  ];
  for (const c of cases) {
    test(`${c.name}: stored as ${c.stored}, served with nosniff + sandbox CSP${c.attachment ? " as an attachment" : ""}`, async () => {
      const r = await upload(relay.http, user().sk, c.body, { type: c.declared });
      expect(r.status).toBe(201);
      expect(r.body.type).toBe(c.stored);
      for (const suffix of ["", ".html", ".svg", ".js"]) {
        const g = await fetch(`${relay.http}/${r.sha}${suffix}`);
        expect(g.status).toBe(200);
        const ct = g.headers.get("content-type")!;
        // the URL extension never changes the type; JavaScript is never served with a script type
        expect(ct.startsWith(c.stored === "text/javascript" ? "text/plain" : c.stored)).toBe(true);
        expect(g.headers.get("x-content-type-options")).toBe("nosniff");
        expect(g.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
        const cd = g.headers.get("content-disposition")!;
        expect(cd.startsWith(c.attachment ? "attachment;" : "inline")).toBe(true);
        expect(cd).not.toMatch(/[\r\n"]{2}|\.\.\//);
        await g.arrayBuffer();
      }
      // and never loadable as a script / worker
      for (const dest of ["script", "worker", "serviceworker", "xslt", "SCRIPT"]) {
        expect((await fetch(`${relay.http}/${r.sha}`, { headers: { "Sec-Fetch-Dest": dest } })).status).toBe(403);
      }
    });
  }

  test("with the default allowlist, SVG (an image/* type) is admitted but still served as a sandboxed attachment", async () => {
    await setBlossom({ allowedMimeTypes: ["image/*", "video/*", "audio/*", "application/pdf"] });
    try {
      const r = await upload(relay.http, user().sk, bytes(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>${uniq()}</svg>`), { type: "image/svg+xml" });
      expect(r.status).toBe(201);
      const g = await fetch(`${relay.http}/${r.sha}`);
      expect(g.headers.get("content-disposition")).toStartWith("attachment;");
      expect(g.headers.get("content-security-policy")).toContain("sandbox");
      // HTML disguised as an image is octet-stream, which the default list refuses
      const h = await upload(relay.http, user().sk, bytes(`<!doctype html><script>1</script>${uniq()}`), { type: "image/png" });
      expect(h.status).toBe(415);
    } finally {
      await setBlossom({ allowedMimeTypes: [] });
    }
  });
});

describe("mirror SSRF", () => {
  const mirror = (sk: Uint8Array, url: string) =>
    fetch(`${relay.http}/mirror`, {
      method: "PUT",
      headers: { Authorization: bauth(sk, "upload", { hashes: [sha256(url)] }), "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

  test("loopback, link-local, private, CGNAT, reserved and multicast targets are refused in every literal spelling", async () => {
    const u = user();
    const targets = [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://0.0.0.0/",
      "http://localhost/",
      "http://LOCALHOST./",
      "http://foo.localhost/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[2002:7f00:1::]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://198.18.0.1/",
      "http://224.0.0.1/",
      "http://255.255.255.255/",
      "http://user:pass@127.0.0.1/",
      `http://127.0.0.1:${relay.port}/${"a".repeat(64)}`,
      "https://127.0.0.1:443/",
    ];
    for (const t of targets) {
      const r = await mirror(u.sk, t);
      expect(r.status).toBe(403);
      expect(r.headers.get("x-reason")).toBe("mirror target not allowed");
    }
  });

  test("public addresses on non-web ports and non-http schemes are refused before any connection", async () => {
    const u = user();
    for (const t of ["http://8.8.8.8:22/", "http://8.8.8.8:6379/", "https://1.1.1.1:8443/", "http://[2606:4700:4700::1111]:25/"]) {
      const r = await mirror(u.sk, t);
      expect(r.status).toBe(403);
    }
    for (const t of ["file:///etc/passwd", "gopher://127.0.0.1/", "ftp://8.8.8.8/", "data:text/plain,hi", "javascript:alert(1)", "not a url", "http://[::1"]) {
      const r = await mirror(u.sk, t);
      expect(r.status).toBe(400);
    }
  });

  test("refusals don't echo internal details (no upstream status, no resolver output)", async () => {
    const r = await mirror(user().sk, "http://169.254.169.254/latest/meta-data/iam/security-credentials/");
    const text = await r.text();
    expect(text).not.toContain("169.254");
    expect(looksLikeLeak(text)).toBeUndefined();
  });
});

describe("Range header abuse", () => {
  let sha = "";
  let size = 0;
  beforeAll(async () => {
    await setBlossom({ allowedMimeTypes: [] });
    const r = await upload(relay.http, user().sk, bytes(`range ${uniq()} ${"0123456789".repeat(100)}`), { type: "text/plain" });
    expect(r.status).toBe(201);
    sha = r.sha;
    size = r.bytes.byteLength;
  });
  const get = async (range: string) => {
    const r = await fetch(`${relay.http}/${sha}`, { headers: { Range: range } });
    const body = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, cr: r.headers.get("content-range"), len: Number(r.headers.get("content-length")), body };
  };

  test("multi-range, overlapping and thousands-of-ranges headers get the whole body once (no multipart amplification)", async () => {
    for (const range of ["bytes=0-0,0-0,0-0", "bytes=0-10,5-15", `bytes=${Array.from({ length: 2000 }, () => "0-").join(",")}`, `bytes=${Array.from({ length: 500 }, (_, i) => `${i}-${i}`).join(",")}`]) {
      const r = await get(range);
      expect(r.status).toBe(200);
      expect(r.body.byteLength).toBe(size);
      expect(r.len).toBe(size);
    }
  });

  test("huge, overflowing and malformed numbers are clamped, refused (416) or ignored — never a crash or a bogus length", async () => {
    const huge = "9".repeat(30);
    const a = await get(`bytes=0-${huge}`);
    expect(a.status).toBe(206);
    expect(a.cr).toBe(`bytes 0-${size - 1}/${size}`);
    expect(a.body.byteLength).toBe(size);
    const b = await get(`bytes=${huge}-`);
    expect(b.status).toBe(416);
    expect(b.cr).toBe(`bytes */${size}`);
    const c = await get(`bytes=-${huge}`);
    expect(c.status).toBe(206);
    expect(c.body.byteLength).toBe(size);
    expect((await get("bytes=-0")).status).toBe(416);
    for (const range of ["bytes=1e3-", "bytes=0x10-", "bytes=0--1", "bytes=-", "items=0-5", "bytes=5-3", "bytes=-1-2", `bytes=0-${"1".repeat(5000)}`, "bytes=\u00000-1"]) {
      const r = await get(range).catch(() => ({ status: 200, body: new Uint8Array(size), len: size, cr: null }));
      expect([200, 206, 416]).toContain(r.status);
      if (r.status === 200) expect(r.body.byteLength).toBe(size);
      if (r.status === 206) expect(r.body.byteLength).toBe(r.len);
    }
    // the blob still serves normally
    expect((await get("bytes=0-3")).body.byteLength).toBe(4);
  });
});

describe("slow and stalled upload bodies (slowloris on PUT /upload)", () => {
  let slow: Relay;
  beforeAll(async () => {
    slow = await startRelay({ overrides: { blossom: { limits: { uploadsPerMinutePerIp: 0, uploadsPerMinutePerPubkey: 0, maxConcurrentUploadsPerIp: 2, uploadStallMs: 1000 } } } });
  });
  afterAll(() => slow?.stop());

  /** Starts an authorised upload that sends one chunk and then nothing (until `release`). */
  function stalledUpload() {
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(new Uint8Array(PNG));
          return;
        }
        await hang;
        c.close();
      },
    });
    const res = fetch(`${slow.http}/upload`, {
      method: "PUT",
      headers: { "Content-Type": "image/png", Authorization: bauth(user().sk, "upload", { hashes: [sha256(`never-${Math.random()}`)] }) },
      body,
      duplex: "half",
    } as RequestInit).then(async (r) => ({ status: r.status, reason: r.headers.get("x-reason"), at: Date.now() }));
    return { res, release };
  }

  test("bodies in flight are capped per address, and a stalled body is cut off (408), freeing its slot", async () => {
    const t0 = Date.now();
    const a = stalledUpload();
    const b = stalledUpload();
    await Bun.sleep(150);
    // a third concurrent body from the same address is refused straight away
    const c = stalledUpload();
    const third = await c.res;
    expect(third.status).toBe(429);
    expect(third.at - t0).toBeLessThan(900);
    // the two stalled ones are cut off after uploadStallMs, without waiting for the client
    const [ra, rb] = await Promise.all([a.res, b.res]);
    for (const r of [ra, rb]) {
      expect(r.status).toBe(408);
      expect(r.at - t0).toBeLessThan(3000);
    }
    for (const x of [a, b, c]) x.release();
    // slots are free again: a normal upload goes through
    const ok = await upload(slow.http, user().sk, new Uint8Array(Buffer.concat([PNG, Buffer.from(uniq())])));
    expect(ok.status).toBe(201);
  });
});
