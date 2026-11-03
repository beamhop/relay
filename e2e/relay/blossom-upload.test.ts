/** Blossom BUD-02/04/06/11 upload side: auth rules, preflight, size + mime limits, quotas, CORS. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { now, pngBytes, sha256 } from "../harness/client";
import { api, bauth, pdfBytes, textBytes, upload, user } from "./admin-helpers";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay({ overrides: { blossom: { limits: { uploadsPerMinutePerIp: 0, uploadsPerMinutePerPubkey: 0 } } } });
});
afterAll(() => relay?.stop());

const setBlossom = async (patch: Record<string, unknown>) => {
  const r = await api(relay.http, relay.owner.sk, "PATCH", "/settings", { blossom: patch });
  expect(r.status).toBe(200);
  return r.body.settings.blossom;
};

describe("PUT /upload auth (BUD-02/11)", () => {
  test("valid token: 201 with a BUD-02 descriptor; same upload again is 200", async () => {
    const u = user();
    const bytes = pngBytes();
    const r = await upload(relay.http, u.sk, bytes);
    expect(r.status).toBe(201);
    expect(r.body.sha256).toBe(r.sha);
    expect(r.body.size).toBe(bytes.byteLength);
    expect(r.body.type).toBe("image/png");
    expect(r.body.url).toBe(`${relay.http}/${r.sha}.png`);
    expect(typeof r.body.uploaded).toBe("number");
    expect(r.body.nip94).toContainEqual(["x", r.sha]);
    const again = await upload(relay.http, u.sk, bytes);
    expect(again.status).toBe(200);
    expect(again.body.sha256).toBe(r.sha);
  });

  test("missing Authorization: 401 with X-Reason", async () => {
    const r = await upload(relay.http, null, pngBytes());
    expect(r.status).toBe(401);
    expect(r.headers.get("x-reason")).toContain("authorization required");
  });

  test("expired token: 401", async () => {
    const u = user();
    const bytes = pngBytes();
    const auth = bauth(u.sk, "upload", { hashes: [sha256(bytes)], createdAt: now() - 120, expiresIn: 60 });
    const r = await upload(relay.http, u.sk, bytes, { auth });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-reason")).toBe("auth expired");
  });

  test("token without expiration: 401", async () => {
    const u = user();
    const bytes = pngBytes();
    const r = await upload(relay.http, u.sk, bytes, { auth: bauth(u.sk, "upload", { hashes: [sha256(bytes)], noExpiration: true }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-reason")).toBe("auth missing expiration");
  });

  test("expiration beyond 24h: 401", async () => {
    const u = user();
    const bytes = pngBytes();
    const r = await upload(relay.http, u.sk, bytes, { auth: bauth(u.sk, "upload", { hashes: [sha256(bytes)], expiresIn: 3 * 86400 }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-reason")).toContain("too far in the future");
  });

  test("created_at in the future: 401", async () => {
    const u = user();
    const bytes = pngBytes();
    const r = await upload(relay.http, u.sk, bytes, { auth: bauth(u.sk, "upload", { hashes: [sha256(bytes)], createdAt: now() + 600 }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-reason")).toContain("future");
  });

  test("wrong verb (t=get / t=delete): 401", async () => {
    const u = user();
    const bytes = pngBytes();
    for (const verb of ["get", "delete"]) {
      const r = await upload(relay.http, u.sk, bytes, { auth: bauth(u.sk, verb, { hashes: [sha256(bytes)] }) });
      expect(r.status).toBe(401);
      expect(r.headers.get("x-reason")).toBe("auth t tag must be 'upload'");
    }
  });

  test("wrong event kind: 401", async () => {
    const u = user();
    const bytes = pngBytes();
    const r = await upload(relay.http, u.sk, bytes, { auth: bauth(u.sk, "upload", { hashes: [sha256(bytes)], kind: 27235 }) });
    expect(r.status).toBe(401);
  });

  test("upload token without x tag: 401", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, pngBytes(), { auth: bauth(u.sk, "upload") });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-reason")).toBe("auth missing x tag");
  });

  test("x tag naming another blob: 401 and nothing stored", async () => {
    const u = user();
    const bytes = pngBytes();
    const r = await upload(relay.http, u.sk, bytes, { auth: bauth(u.sk, "upload", { hashes: [sha256(pngBytes())] }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-reason")).toBe("auth x tag does not match blob");
    expect((await fetch(`${relay.http}/${r.sha}`, { method: "HEAD" })).status).toBe(404);
  });

  test("X-SHA-256 header disagreeing with the body: 409", async () => {
    const u = user();
    const bytes = pngBytes();
    const other = sha256(pngBytes());
    const r = await upload(relay.http, u.sk, bytes, {
      auth: bauth(u.sk, "upload", { hashes: [sha256(bytes), other] }),
      headers: { "X-SHA-256": other },
    });
    expect(r.status).toBe(409);
  });

  test("server tag: own host accepted, foreign host refused", async () => {
    const u = user();
    const a = pngBytes();
    const host = new URL(relay.http).host;
    expect((await upload(relay.http, u.sk, a, { auth: bauth(u.sk, "upload", { hashes: [sha256(a)], server: host }) })).status).toBe(201);
    const b = pngBytes();
    const r = await upload(relay.http, u.sk, b, { auth: bauth(u.sk, "upload", { hashes: [sha256(b)], server: "other.example.com" }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-reason")).toBe("auth not valid for this server");
  });

  test("tampered signature: 401", async () => {
    const u = user();
    const bytes = pngBytes();
    const token = bauth(u.sk, "upload", { hashes: [sha256(bytes)] });
    const ev = JSON.parse(Buffer.from(token.slice(6), "base64").toString());
    ev.content = "tampered";
    const r = await upload(relay.http, u.sk, bytes, { auth: `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}` });
    expect(r.status).toBe(401);
  });

  test("empty body: 400", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, new Uint8Array(0), { auth: bauth(u.sk, "upload", { hashes: [sha256(new Uint8Array(0))] }) });
    expect(r.status).toBe(400);
  });
});

describe("HEAD /upload preflight (BUD-06)", () => {
  const preflight = (headers: Record<string, string>) => fetch(`${relay.http}/upload`, { method: "HEAD", headers });

  test("accepts a valid request and checks headers in order", async () => {
    const u = user();
    const sha = sha256(pngBytes());
    const auth = bauth(u.sk, "upload", { hashes: [sha] });
    const ok = await preflight({ Authorization: auth, "X-SHA-256": sha, "X-Content-Length": "100", "X-Content-Type": "image/png" });
    expect(ok.status).toBe(200);
    expect((await preflight({ Authorization: auth, "X-Content-Length": "100" })).status).toBe(400);
    expect((await preflight({ Authorization: auth, "X-SHA-256": "zz", "X-Content-Length": "100" })).status).toBe(400);
    expect((await preflight({ Authorization: auth, "X-SHA-256": sha })).status).toBe(411);
    expect((await preflight({ Authorization: auth, "X-SHA-256": sha, "X-Content-Length": "abc" })).status).toBe(400);
    // PUT refuses an empty body, so the preflight does too (regression: it answered 200)
    expect((await preflight({ Authorization: auth, "X-SHA-256": sha, "X-Content-Length": "0" })).status).toBe(400);
    expect((await preflight({ "X-SHA-256": sha, "X-Content-Length": "100" })).status).toBe(401);
  });

  test("token x tag must name X-SHA-256", async () => {
    const u = user();
    const sha = sha256(pngBytes());
    const r = await preflight({ Authorization: bauth(u.sk, "upload", { hashes: [sha256(pngBytes())] }), "X-SHA-256": sha, "X-Content-Length": "10" });
    expect(r.status).toBe(401);
  });

  test("refuses a too-large size (413) and a disallowed type (415)", async () => {
    const u = user();
    const sha = sha256(pngBytes());
    const auth = bauth(u.sk, "upload", { hashes: [sha] });
    const big = await preflight({ Authorization: auth, "X-SHA-256": sha, "X-Content-Length": String(200 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const html = await preflight({ Authorization: auth, "X-SHA-256": sha, "X-Content-Length": "10", "X-Content-Type": "text/html" });
    expect(html.status).toBe(415);
    expect(html.headers.get("x-reason")).toContain("text/html");
  });

  test("GET /upload is 405", async () => {
    expect((await fetch(`${relay.http}/upload`)).status).toBe(405);
  });
});

describe("size, mime and access settings", () => {
  test("maxUploadBytes: a body over the limit is 413 on PUT and HEAD", async () => {
    await setBlossom({ maxUploadBytes: 2048 });
    try {
      const u = user();
      const bytes = new Uint8Array(Buffer.concat([Buffer.from(pngBytes()), Buffer.alloc(4096, 7)]));
      const r = await upload(relay.http, u.sk, bytes);
      expect(r.status).toBe(413);
      const small = await upload(relay.http, u.sk, pngBytes());
      expect(small.status).toBe(201);
    } finally {
      await setBlossom({ maxUploadBytes: 100 * 1024 * 1024 });
    }
  });

  test("default allowlist refuses text and HTML, accepts PDF; widening the list admits text", async () => {
    const u = user();
    const txt = await upload(relay.http, u.sk, textBytes(), { type: "text/plain" });
    expect(txt.status).toBe(415);
    const html = await upload(relay.http, u.sk, new Uint8Array(Buffer.from(`<!doctype html><p>${Math.random()}</p>`)), { type: "text/html" });
    expect(html.status).toBe(415);
    const pdf = await upload(relay.http, u.sk, pdfBytes(), { type: "application/pdf" });
    expect(pdf.status).toBe(201);
    expect(pdf.body.type).toBe("application/pdf");
    await setBlossom({ allowedMimeTypes: ["image/*", "text/plain"] });
    try {
      const t2 = await upload(relay.http, u.sk, textBytes(), { type: "text/plain" });
      expect(t2.status).toBe(201);
      expect(t2.body.type).toBe("text/plain");
      const pdf2 = await upload(relay.http, u.sk, pdfBytes(), { type: "application/pdf" });
      expect(pdf2.status).toBe(415);
    } finally {
      await setBlossom({ allowedMimeTypes: ["image/*", "video/*", "audio/*", "application/pdf"] });
    }
  });

  test("declared type is not trusted: PNG bytes labelled as PDF are stored as image/png", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, pngBytes(), { type: "application/pdf" });
    expect(r.status).toBe(201);
    expect(r.body.type).toBe("image/png");
  });

  test("unrecognised bytes labelled image/png become octet-stream and are refused", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, new Uint8Array(Buffer.from(`\x00\x01\x02junk${Math.random()}`)), { type: "image/png" });
    expect(r.status).toBe(415);
    expect(r.headers.get("x-reason")).toContain("application/octet-stream");
  });

  test("uploadAccess=admins: strangers 403, owner allowed", async () => {
    await setBlossom({ uploadAccess: "admins" });
    try {
      const u = user();
      const r = await upload(relay.http, u.sk, pngBytes());
      expect(r.status).toBe(403);
      expect(r.headers.get("x-reason")).toBe("uploads are restricted to admins");
      expect((await upload(relay.http, relay.owner.sk, pngBytes())).status).toBe(201);
    } finally {
      await setBlossom({ uploadAccess: "members" });
    }
  });

  test("uploadAccess=members on a whitelist relay: only allowed users upload", async () => {
    const r1 = await api(relay.http, relay.owner.sk, "PATCH", "/settings", { access: { mode: "whitelist" } });
    expect(r1.status).toBe(200);
    try {
      const stranger = user();
      expect((await upload(relay.http, stranger.sk, pngBytes())).status).toBe(403);
      const member = user();
      expect((await api(relay.http, relay.owner.sk, "POST", "/users", { pubkey: member.pubkey, allowed: true })).status).toBe(201);
      expect((await upload(relay.http, member.sk, pngBytes())).status).toBe(201);
    } finally {
      await api(relay.http, relay.owner.sk, "PATCH", "/settings", { access: { mode: "public" } });
    }
  });

  test("banned user can't upload or preflight", async () => {
    const u = user();
    expect((await api(relay.http, relay.owner.sk, "POST", `/users/${u.pubkey}/ban`, { reason: "e2e" })).status).toBe(200);
    const bytes = pngBytes();
    const r = await upload(relay.http, u.sk, bytes);
    expect(r.status).toBe(403);
    expect(r.headers.get("x-reason")).toBe("pubkey is banned");
    const h = await fetch(`${relay.http}/upload`, {
      method: "HEAD",
      headers: { Authorization: bauth(u.sk, "upload", { hashes: [r.sha] }), "X-SHA-256": r.sha, "X-Content-Length": "10" },
    });
    expect(h.status).toBe(403);
  });
});

describe("quotas", () => {
  test("per-user quota via admin API: upload over it is 413, re-upload of an owned blob is free", async () => {
    const u = user();
    const first = pngBytes();
    expect((await upload(relay.http, u.sk, first)).status).toBe(201);
    const quota = first.byteLength + 10;
    expect((await api(relay.http, relay.owner.sk, "PATCH", `/users/${u.pubkey}`, { blossomQuota: quota })).status).toBe(200);
    const second = await upload(relay.http, u.sk, pngBytes());
    expect(second.status).toBe(413);
    expect(second.headers.get("x-reason")).toContain("quota");
    // already owned: no extra charge
    expect((await upload(relay.http, u.sk, first)).status).toBe(200);
    // preflight agrees
    const h = await fetch(`${relay.http}/upload`, {
      method: "HEAD",
      headers: { Authorization: bauth(u.sk, "upload", { hashes: [second.sha] }), "X-SHA-256": second.sha, "X-Content-Length": String(second.bytes.byteLength) },
    });
    expect(h.status).toBe(413);
    // usage is visible to admins
    const detail = await api(relay.http, relay.owner.sk, "GET", `/users/${u.pubkey}`);
    expect(detail.body.stats.blobCount).toBe(1);
    expect(detail.body.stats.blobBytes).toBe(first.byteLength);
  });

  test("quota 0 means no storage; null falls back to the default", async () => {
    const u = user();
    expect((await api(relay.http, relay.owner.sk, "PATCH", `/users/${u.pubkey}`, { blossomQuota: 0 })).status).toBe(200);
    expect((await upload(relay.http, u.sk, pngBytes())).status).toBe(413);
    expect((await api(relay.http, relay.owner.sk, "PATCH", `/users/${u.pubkey}`, { blossomQuota: null })).status).toBe(200);
    expect((await upload(relay.http, u.sk, pngBytes())).status).toBe(201);
  });

  test("defaultQuotaBytes applies to users without their own quota", async () => {
    await setBlossom({ defaultQuotaBytes: 50 });
    try {
      const u = user();
      expect((await upload(relay.http, u.sk, pngBytes())).status).toBe(413);
    } finally {
      await setBlossom({ defaultQuotaBytes: 1024 * 1024 * 1024 });
    }
  });
});

describe("BUD-04 mirror", () => {
  const mirror = (auth: string | undefined, body: string) =>
    fetch(`${relay.http}/mirror`, { method: "PUT", headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" }, body });

  test("requires auth with an x tag", async () => {
    const u = user();
    expect((await mirror(undefined, JSON.stringify({ url: "https://example.com/a.png" }))).status).toBe(401);
    expect((await mirror(bauth(u.sk, "upload"), JSON.stringify({ url: "https://example.com/a.png" }))).status).toBe(401);
  });

  test("bad bodies are 400", async () => {
    const u = user();
    const auth = () => bauth(u.sk, "upload", { hashes: [sha256(pngBytes())] });
    expect((await mirror(auth(), "not json")).status).toBe(400);
    expect((await mirror(auth(), JSON.stringify({}))).status).toBe(400);
    expect((await mirror(auth(), JSON.stringify({ url: "ftp://example.com/x" }))).status).toBe(400);
  });

  test("refuses private/loopback sources (SSRF)", async () => {
    const u = user();
    const bytes = pngBytes();
    const r = await mirror(bauth(u.sk, "upload", { hashes: [sha256(bytes)] }), JSON.stringify({ url: `${relay.http}/${sha256(bytes)}` }));
    expect(r.status).toBe(403);
  });
});

describe("CORS", () => {
  test("OPTIONS preflight on blossom paths returns 204 with CORS headers", async () => {
    for (const p of ["/upload", "/mirror", `/${"a".repeat(64)}`, `/list/${"b".repeat(64)}`]) {
      const r = await fetch(`${relay.http}${p}`, { method: "OPTIONS", headers: { Origin: "https://client.example", "Access-Control-Request-Method": "PUT" } });
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(r.headers.get("access-control-allow-methods")).toContain("PUT");
      expect(r.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    }
  });

  test("error and success responses carry CORS and expose X-Reason", async () => {
    const err = await upload(relay.http, null, pngBytes());
    expect(err.headers.get("access-control-allow-origin")).toBe("*");
    expect(err.headers.get("access-control-expose-headers")).toContain("X-Reason");
    const ok = await upload(relay.http, user().sk, pngBytes());
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
  });
});
