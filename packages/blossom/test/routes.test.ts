import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BusEvents } from "@beamhop/sdk";
import { PNG_1x1, authHeader, createHarness, jpegWithExif, newUser, sha256, type Harness } from "./fakes";

let h: Harness;
const alice = newUser();
const bob = newUser();
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

/** `x` defaults to the hash of `data` (BUD-11 requires a matching `x` tag on uploads). */
async function upload(data: Uint8Array, opts: { user?: typeof alice; type?: string; x?: string[]; headers?: Record<string, string> } = {}) {
  const u = opts.user ?? alice;
  const x = opts.x ?? [await sha256(data)];
  return h.request("/upload", {
    method: "PUT",
    body: data as BodyInit,
    headers: { authorization: authHeader(u.sk, "upload", { x }), "content-type": opts.type ?? "application/octet-stream", ...opts.headers },
  });
}

function events<K extends keyof BusEvents>(name: K) {
  const list: BusEvents[K][] = [];
  h.bus.on(name, (p) => list.push(p));
  return list;
}

beforeEach(async () => {
  h = await createHarness({ useSharp: false });
});
afterEach(() => h.cleanup());

describe("upload + retrieval (BUD-01/02)", () => {
  test("PUT /upload returns descriptor; GET/HEAD serve blob with headers", async () => {
    const uploaded = events("blob.uploaded");
    const served = events("blob.served");
    const hash = await sha256(PNG_1x1);
    const res = await upload(PNG_1x1, { x: [hash] });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const desc = await res.json();
    expect(desc).toMatchObject({ sha256: hash, size: PNG_1x1.length, type: "image/png", url: `https://cdn.example.com/${hash}.png` });
    expect(typeof desc.uploaded).toBe("number");
    expect(desc.nip94).toContainEqual(["x", hash]);
    expect(uploaded).toEqual([{ sha256: hash, size: PNG_1x1.length, type: "image/png", pubkey: alice.pubkey }]);

    // BUD-01: any extension (case-insensitive) returns the blob itself
    for (const path of [`/${hash}`, `/${hash}.png`, `/${hash}.jpg`, `/${hash}.PNG`, `/${hash}.thumb.webp`, `/${hash}?thumb=1`]) {
      const get = await h.request(path);
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe("image/png");
      expect(get.headers.get("content-length")).toBe(String(PNG_1x1.length));
      expect(get.headers.get("accept-ranges")).toBe("bytes");
      expect(get.headers.get("etag")).toBe(`"${hash}"`);
      expect(get.headers.get("cache-control")).toContain("immutable");
      expect(get.headers.get("access-control-allow-origin")).toBe("*");
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG_1x1);
    }
    expect(served.length).toBe(6);
    expect(served[0]).toMatchObject({ sha256: hash, size: PNG_1x1.length });

    const head = await h.request(`/${hash}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PNG_1x1.length));
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(served.length).toBe(6);
    expect((await h.request(`/${hash}.Jpeg`, { method: "HEAD" })).status).toBe(200);

    const cached = await h.request(`/${hash}`, { headers: { "if-none-match": `"${hash}"` } });
    expect(cached.status).toBe(304);
  });

  test("range requests", async () => {
    const hash = await sha256(PDF);
    expect((await upload(PDF, { type: "application/pdf" })).status).toBe(201);
    const r = await h.request(`/${hash}.pdf`, { headers: { range: "bytes=1-3" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 1-3/${PDF.length}`);
    expect(r.headers.get("content-length")).toBe("3");
    expect(await r.text()).toBe("PDF");
    const suffix = await h.request(`/${hash}`, { headers: { range: "bytes=-6" } });
    expect(await suffix.text()).toBe("%%EOF\n");
    const bad = await h.request(`/${hash}`, { headers: { range: `bytes=${PDF.length + 5}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${PDF.length}`);
  });

  test("unknown blob → 404 with X-Reason; other paths are not swallowed", async () => {
    const r = await h.request(`/${"0".repeat(64)}`);
    expect(r.status).toBe(404);
    expect(r.headers.get("x-reason")).toBeTruthy();
    expect((await h.request("/admin")).status).toBe(404);
    expect((await h.request(`/${"0".repeat(63)}`)).headers.get("x-reason")).toBeNull();
    expect((await h.request(`/${"0".repeat(64)}/foo`)).headers.get("x-reason")).toBeNull();
  });

  test("re-upload of same blob is idempotent (201 then 200) and adds owners", async () => {
    const hash = await sha256(PDF);
    expect((await upload(PDF)).status).toBe(201);
    expect((await upload(PDF)).status).toBe(200);
    expect((await upload(PDF, { user: bob })).status).toBe(200);
    expect((await h.svc.get(hash))!.owners.sort()).toEqual([alice.pubkey, bob.pubkey].sort());
  });

  test("OPTIONS preflight", async () => {
    const r = await h.request("/upload", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(r.headers.get("access-control-allow-headers")).toContain("X-SHA-256");
  });
});

describe("upload validation", () => {
  test("requires valid auth", async () => {
    expect((await h.request("/upload", { method: "PUT", body: PDF })).status).toBe(401);
    const wrongVerb = await h.request("/upload", { method: "PUT", body: PDF, headers: { authorization: authHeader(alice.sk, "get") } });
    expect(wrongVerb.status).toBe(401);
    const xMismatch = await upload(PDF, { x: ["ab".repeat(32)] });
    expect(xMismatch.status).toBe(401);
    expect(xMismatch.headers.get("x-reason")).toContain("x tag");
    // BUD-11: an x tag is required on PUT /upload
    const noX = await upload(PDF, { x: [] });
    expect(noX.status).toBe(401);
    expect(noX.headers.get("x-reason")).toContain("x tag");
    // x tag must also match X-SHA-256 when sent
    const hash = await sha256(PDF);
    expect((await upload(PDF, { x: ["ab".repeat(32)], headers: { "x-sha-256": hash } })).status).toBe(401);
    expect((await upload(PDF, { headers: { "x-sha-256": hash } })).status).toBe(201);
  });

  test("X-SHA-256 header must match body", async () => {
    const r = await upload(PDF, { x: ["ab".repeat(32), await sha256(PDF)], headers: { "x-sha-256": "ab".repeat(32) } });
    expect(r.status).toBe(409);
  });

  test("size limit", async () => {
    await h.deps.settings.update({ blossom: { maxUploadBytes: 10 } }, "test");
    const r = await upload(PDF);
    expect(r.status).toBe(413);
  });

  test("mime allowlist (sniffed, falling back to header)", async () => {
    const text = new TextEncoder().encode("just some text");
    const r = await upload(text, { type: "text/plain" });
    expect(r.status).toBe(415);
    await h.deps.settings.update({ blossom: { allowedMimeTypes: ["text/*"] } }, "test");
    const ok = await upload(text, { type: "text/plain; charset=utf-8" });
    expect(ok.status).toBe(201);
    expect((await ok.json()).type).toBe("text/plain");
    // PNG bytes declared as text are sniffed as image/png → rejected
    expect((await upload(PNG_1x1, { type: "text/plain" })).status).toBe(415);
  });

  test("upload access: members / admins / banned", async () => {
    await h.deps.settings.update({ access: { mode: "whitelist" } }, "test");
    expect((await upload(PDF)).status).toBe(403);
    await h.deps.stores.users.upsert(alice.pubkey, { allowed: true });
    expect((await upload(PDF)).status).toBe(201);
    await h.deps.settings.update({ blossom: { uploadAccess: "admins" } }, "test");
    expect((await upload(PNG_1x1)).status).toBe(403);
    await h.deps.stores.users.upsert(alice.pubkey, { role: "admin" });
    expect((await upload(PNG_1x1)).status).toBe(201);
    await h.deps.settings.update({ blossom: { uploadAccess: "anyone" } }, "test");
    await h.deps.stores.users.upsert(bob.pubkey, { status: "banned" });
    expect((await upload(PNG_1x1, { user: bob })).status).toBe(403);
  });

  test("per-user quota", async () => {
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: PDF.length + 10 });
    expect((await upload(PDF)).status).toBe(201);
    const r = await upload(PNG_1x1);
    expect(r.status).toBe(413);
    expect(r.headers.get("x-reason")).toContain("quota");
    // re-uploading an owned blob doesn't count twice
    expect((await upload(PDF)).status).toBe(200);
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: 0 });
    expect((await upload(PNG_1x1)).status).toBe(201);
  });

  test("blocklist", async () => {
    const hash = await sha256(PDF);
    await h.svc.delete(hash, "admin", { block: true });
    const r = await upload(PDF);
    expect(r.status).toBe(403);
    const pre = await h.request("/upload", {
      method: "HEAD",
      headers: { authorization: authHeader(alice.sk, "upload", { x: [hash] }), "x-sha-256": hash, "x-content-length": String(PDF.length), "x-content-type": "application/pdf" },
    });
    expect(pre.status).toBe(403);
    expect(await h.svc.unblock(hash, "admin")).toBe(true);
    expect((await upload(PDF)).status).toBe(201);
  });

  test("plugin blob hook can reject", async () => {
    h.deps.hooks.onBlobUpload((info) => (info.type === "application/pdf" ? { action: "reject", reason: "no pdfs" } : undefined), "test");
    const r = await upload(PDF);
    expect(r.status).toBe(403);
    expect(r.headers.get("x-reason")).toBe("no pdfs");
    expect((await upload(PNG_1x1)).status).toBe(201);
  });
});

describe("EXIF stripping", () => {
  test("opt-in: JPEG EXIF is stripped; descriptor reflects stored blob; original x tag accepted", async () => {
    await h.deps.settings.update({ blossom: { stripExif: true } }, "test");
    const { withExif, withoutExif } = jpegWithExif();
    const original = await sha256(withExif);
    const stripped = await sha256(withoutExif);
    const res = await upload(withExif, { x: [original], type: "image/jpeg" });
    expect(res.status).toBe(201);
    const desc = await res.json();
    expect(desc.sha256).toBe(stripped);
    expect(desc.size).toBe(withoutExif.length);
    expect(desc.type).toBe("image/jpeg");
    expect(desc.nip94).toContainEqual(["ox", original]);
    const body = new Uint8Array(await (await h.request(`/${stripped}.jpg`)).arrayBuffer());
    expect([...body]).toEqual([...withoutExif]);
    expect((await h.request(`/${original}`)).status).toBe(404);
  });

  test("off by default (BUD-02): uploads are stored byte-identical", async () => {
    expect(h.deps.settings.get().blossom.stripExif).toBe(false);
    const { withExif } = jpegWithExif();
    const desc = await (await upload(withExif)).json();
    expect(desc.sha256).toBe(await sha256(withExif));
    expect(desc.nip94.find((t: string[]) => t[0] === "ox")).toBeUndefined();
    expect([...new Uint8Array(await (await h.request(`/${desc.sha256}`)).arrayBuffer())]).toEqual([...withExif]);
  });
});

describe("BUD-06 HEAD /upload", () => {
  const head = (headers: Record<string, string>, user = alice, x = headers["x-sha-256"] ? [headers["x-sha-256"]] : []) =>
    h.request("/upload", { method: "HEAD", headers: { authorization: authHeader(user.sk, "upload", { x }), ...headers } });

  test("preflight checks", async () => {
    const hash = "ab".repeat(32);
    expect((await head({ "x-sha-256": hash, "x-content-length": "100", "x-content-type": "image/png" })).status).toBe(200);
    expect((await head({ "x-sha-256": hash, "x-content-type": "image/png" })).status).toBe(411);
    expect((await head({ "x-sha-256": "zz", "x-content-length": "1" })).status).toBe(400);
    const tooBig = await head({ "x-sha-256": hash, "x-content-length": String(1e12) });
    expect(tooBig.status).toBe(413);
    expect(tooBig.headers.get("x-reason")).toBeTruthy();
    expect((await head({ "x-sha-256": hash, "x-content-length": "1", "x-content-type": "text/html" })).status).toBe(415);
    expect((await h.request("/upload", { method: "HEAD", headers: { "x-sha-256": hash, "x-content-length": "1" } })).status).toBe(401);
  });

  test("BUD-11: X-SHA-256 and a matching x tag are required", async () => {
    const hash = "ab".repeat(32);
    const missing = await head({ "x-content-length": "1" }, alice, [hash]);
    expect(missing.status).toBe(400);
    expect(missing.headers.get("x-reason")).toContain("X-SHA-256");
    const noX = await head({ "x-sha-256": hash, "x-content-length": "1" }, alice, []);
    expect(noX.status).toBe(401);
    expect(noX.headers.get("x-reason")).toContain("x tag");
    expect((await head({ "x-sha-256": hash, "x-content-length": "1" }, alice, ["cd".repeat(32)])).status).toBe(401);
  });
});

describe("list + delete", () => {
  test("GET /list/:pubkey with since/until and pending visibility", async () => {
    await upload(PDF);
    await h.deps.settings.update({ blossom: { requireApproval: true } }, "test");
    await upload(PNG_1x1);
    const pub = await (await h.request(`/list/${alice.pubkey}`)).json();
    expect(pub.map((d: { type: string }) => d.type)).toEqual(["application/pdf"]);
    const own = await (await h.request(`/list/${alice.pubkey}`, { headers: { authorization: authHeader(alice.sk, "list") } })).json();
    expect(own.length).toBe(2);
    const future = Math.floor(Date.now() / 1000) + 100;
    expect(await (await h.request(`/list/${alice.pubkey}?since=${future}`)).json()).toEqual([]);
    expect((await (await h.request(`/list/${alice.pubkey}?until=${future}`)).json()).length).toBe(1);
    expect(await (await h.request(`/list/${bob.pubkey}`)).json()).toEqual([]);
  });

  test("DELETE removes ownership; data deleted when no owners remain", async () => {
    const deleted = events("blob.deleted");
    const hash = await sha256(PDF);
    await upload(PDF);
    await upload(PDF, { user: bob });
    const del = (u: typeof alice, x?: string[]) =>
      h.request(`/${hash}`, { method: "DELETE", headers: { authorization: authHeader(u.sk, "delete", { x }) } });
    expect((await del(alice)).status).toBe(401); // x tag required
    expect((await del(alice, ["cd".repeat(32)])).status).toBe(401);
    expect((await del(alice, [hash])).status).toBe(200);
    expect((await h.request(`/${hash}`)).status).toBe(200);
    expect((await del(alice, [hash])).status).toBe(403);
    expect((await del(bob, [hash])).status).toBe(200);
    expect((await h.request(`/${hash}`)).status).toBe(404);
    expect(await h.svc.driver.has(hash)).toBe(false);
    expect(deleted).toEqual([{ sha256: hash, actor: bob.pubkey }]);
  });
});

describe("moderation status", () => {
  test("pending blobs are hidden from public but visible to owner and admins", async () => {
    await h.deps.settings.update({ blossom: { requireApproval: true } }, "test");
    const desc = await (await upload(PDF)).json();
    expect((await h.svc.get(desc.sha256))!.status).toBe("pending");
    expect((await h.request(`/${desc.sha256}`)).status).toBe(404);
    const asOwner = await h.request(`/${desc.sha256}`, { headers: { authorization: authHeader(alice.sk, "get") } });
    expect(asOwner.status).toBe(200);
    expect(asOwner.headers.get("cache-control")).toContain("no-store");
    expect((await h.request(`/${desc.sha256}`, { headers: { authorization: authHeader(bob.sk, "get") } })).status).toBe(404);
    await h.deps.stores.users.upsert(bob.pubkey, { role: "moderator" });
    expect((await h.request(`/${desc.sha256}`, { headers: { authorization: authHeader(bob.sk, "get") } })).status).toBe(200);
    await h.svc.setStatus(desc.sha256, "approved", "admin");
    expect((await h.request(`/${desc.sha256}`)).status).toBe(200);
    await h.svc.setStatus(desc.sha256, "blocked", "admin");
    expect((await h.request(`/${desc.sha256}`, { headers: { authorization: authHeader(alice.sk, "get") } })).status).toBe(404);
    expect(h.deps.stores.audit.entries.map((e) => e.action)).toEqual(["blob.status", "blob.status"]);
  });
});

describe("mirror (BUD-04)", () => {
  const mirror = (url: string, x: string[], user = alice) =>
    h.request("/mirror", {
      method: "PUT",
      body: JSON.stringify({ url }),
      headers: { "content-type": "application/json", authorization: authHeader(user.sk, "upload", { x }) },
    });

  test("mirrors from a local server and verifies hash", async () => {
    await h.cleanup();
    h = await createHarness({ useSharp: false, allowPrivateMirror: true });
    const { withExif } = jpegWithExif();
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/redir"
          ? Response.redirect("/blob", 302)
          : new Response(withExif as BodyInit, { headers: { "content-type": "image/jpeg" } }),
    });
    try {
      const hash = await sha256(withExif);
      const res = await mirror(`http://127.0.0.1:${server.port}/redir`, [hash]);
      expect(res.status).toBe(201);
      const desc = await res.json();
      // mirrored blobs are kept byte-identical (no EXIF stripping)
      expect(desc).toMatchObject({ sha256: hash, type: "image/jpeg", size: withExif.length });
      // already stored → 200
      expect((await mirror(`http://127.0.0.1:${server.port}/blob`, [hash])).status).toBe(200);
      expect((await mirror(`http://127.0.0.1:${server.port}/blob`, ["ab".repeat(32)])).status).toBe(409);
      expect((await mirror(`http://127.0.0.1:${server.port}/blob`, [])).status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("blocks private targets by default and enforces size limit (mocked fetch)", async () => {
    expect((await mirror("http://127.0.0.1:1/x", ["ab".repeat(32)])).status).toBe(403);
    await h.cleanup();
    const big = new Uint8Array(2048);
    h = await createHarness({
      useSharp: false,
      allowPrivateMirror: true,
      fetch: (async () => new Response(big, { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch,
    });
    await h.deps.settings.update({ blossom: { maxUploadBytes: 1024 } }, "test");
    expect((await mirror("https://remote.example/x", [await sha256(big)])).status).toBe(413);
    expect((await mirror("ftp://remote.example/x", ["ab".repeat(32)])).status).toBe(400);
  });

  test("prefers the origin Content-Type, falling back to sniffing (mocked fetch)", async () => {
    await h.cleanup();
    const types: Record<string, string> = {
      "/declared": "image/x-test; charset=binary",
      "/generic": "application/octet-stream",
      "/none": "",
      "/disallowed": "text/html",
    };
    h = await createHarness({
      useSharp: false,
      allowPrivateMirror: true,
      fetch: (async (url: URL) => {
        const res = new Response(PNG_1x1 as BodyInit);
        const t = types[new URL(url).pathname];
        if (t) res.headers.set("content-type", t);
        else res.headers.delete("content-type");
        return res;
      }) as unknown as typeof fetch,
    });
    const hash = await sha256(PNG_1x1);
    const typeOf = async (path: string) => {
      await h.svc.delete(hash, "admin");
      const res = await mirror(`https://remote.example${path}`, [hash]);
      return res.status === 201 ? (await res.json()).type : res.status;
    };
    expect(await typeOf("/declared")).toBe("image/x-test");
    expect(await typeOf("/generic")).toBe("image/png");
    expect(await typeOf("/none")).toBe("image/png");
    expect(await typeOf("/disallowed")).toBe(415);
  });
});
