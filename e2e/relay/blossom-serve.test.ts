/** Blossom read side: GET/HEAD/range, /list, DELETE, and how admin moderation changes what is served. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { pngBytes, sha256 } from "../harness/client";
import { api, bauth, nip98, pdfBytes, upload, user } from "./admin-helpers";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay({ overrides: { blossom: { limits: { uploadsPerMinutePerIp: 0, uploadsPerMinutePerPubkey: 0 } } } });
});
afterAll(() => relay?.stop());

const get = (sha: string, init: RequestInit = {}) => fetch(`${relay.http}/${sha}`, init);
const del = (sk: Uint8Array, sha: string, auth?: string) =>
  fetch(`${relay.http}/${sha}`, { method: "DELETE", headers: { Authorization: auth ?? bauth(sk, "delete", { hashes: [sha] }) } });
const setStatus = (sha: string, status: string) => api(relay.http, relay.owner.sk, "POST", `/media/${sha}/status`, { status });

describe("GET / HEAD /<sha256>", () => {
  test("GET returns exact bytes with blob headers; extension is ignored", async () => {
    const r = await upload(relay.http, user().sk, pngBytes());
    for (const suffix of ["", ".png", ".jpg", ".PNG"]) {
      const res = await get(r.sha + suffix);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(r.bytes);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("etag")).toBe(`"${r.sha}"`);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  // regression: the fs driver streamed via Readable.toWeb(createReadStream), which Bun sends chunked, dropping the header
  test("GET /<sha256> (and 206 ranges) keep the Content-Length header under Bun (regression)", async () => {
    const r = await upload(relay.http, user().sk, pngBytes());
    const res = await get(r.sha);
    expect(res.headers.get("content-length")).toBe(String(r.bytes.byteLength));
    const part = await get(r.sha, { headers: { Range: "bytes=0-9" } });
    expect(part.headers.get("content-length")).toBe("10");
  });

  test("HEAD mirrors GET without a body", async () => {
    const r = await upload(relay.http, user().sk, pngBytes());
    const h = await get(r.sha, { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(h.headers.get("content-length")).toBe(String(r.bytes.byteLength));
    expect(h.headers.get("content-type")).toBe("image/png");
    expect((await h.arrayBuffer()).byteLength).toBe(0);
  });

  test("PDF is served inline-safe as application/pdf", async () => {
    const r = await upload(relay.http, user().sk, pdfBytes(), { type: "application/pdf" });
    expect(r.status).toBe(201);
    const res = await get(`${r.sha}.pdf`);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    // inline (never attachment, never a bare filename Bun would otherwise add for file-backed bodies)
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  test("unknown hash: 404 with X-Reason; malformed path is not a blob route", async () => {
    const res = await get("f".repeat(64));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-reason")).toBe("blob not found");
    expect((await fetch(`${relay.http}/${"f".repeat(63)}`)).status).toBe(404);
  });

  test("Range requests: bounded, open-ended, suffix, unsatisfiable, invalid", async () => {
    const r = await upload(relay.http, user().sk, pngBytes());
    const size = r.bytes.byteLength;
    const a = await get(r.sha, { headers: { Range: "bytes=0-9" } });
    expect(a.status).toBe(206);
    expect(a.headers.get("content-range")).toBe(`bytes 0-9/${size}`);
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(r.bytes.subarray(0, 10));
    const b = await get(r.sha, { headers: { Range: "bytes=10-" } });
    expect(b.status).toBe(206);
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(r.bytes.subarray(10));
    const c = await get(r.sha, { headers: { Range: "bytes=-5" } });
    expect(c.status).toBe(206);
    expect(c.headers.get("content-range")).toBe(`bytes ${size - 5}-${size - 1}/${size}`);
    expect(new Uint8Array(await c.arrayBuffer())).toEqual(r.bytes.subarray(size - 5));
    const d = await get(r.sha, { headers: { Range: `bytes=${size}-` } });
    expect(d.status).toBe(416);
    expect(d.headers.get("content-range")).toBe(`bytes */${size}`);
    // last < first is syntactically invalid: whole body
    const e = await get(r.sha, { headers: { Range: "bytes=9-3" } });
    expect(e.status).toBe(200);
    // HEAD with range
    const h = await get(r.sha, { method: "HEAD", headers: { Range: "bytes=0-3" } });
    expect(h.status).toBe(206);
    expect(h.headers.get("content-length")).toBe("4");
  });

  test("If-None-Match: 304", async () => {
    const r = await upload(relay.http, user().sk, pngBytes());
    const res = await get(r.sha, { headers: { "If-None-Match": `"${r.sha}"` } });
    expect(res.status).toBe(304);
  });

  test("refused when fetched as a script", async () => {
    const r = await upload(relay.http, user().sk, pngBytes());
    expect((await get(r.sha, { headers: { "Sec-Fetch-Dest": "script" } })).status).toBe(403);
  });
});

describe("GET /list/<pubkey> (BUD-02)", () => {
  test("lists the owner's blobs newest first, with since/until on upload time", async () => {
    const u = user();
    const r1 = await upload(relay.http, u.sk, pngBytes());
    const t1 = r1.body.uploaded as number;
    // wait for the clock to tick so the second upload lands in a later second
    while (Math.floor(Date.now() / 1000) <= t1) await Bun.sleep(20);
    const r2 = await upload(relay.http, u.sk, pngBytes());
    const t2 = r2.body.uploaded as number;
    expect(t2).toBeGreaterThan(t1);
    const all = await (await fetch(`${relay.http}/list/${u.pubkey}`)).json();
    expect(all.map((d: any) => d.sha256)).toEqual([r2.sha, r1.sha]);
    expect(all[0].url).toBe(`${relay.http}/${r2.sha}.png`);
    const since = await (await fetch(`${relay.http}/list/${u.pubkey}?since=${t2}`)).json();
    expect(since.map((d: any) => d.sha256)).toEqual([r2.sha]);
    const until = await (await fetch(`${relay.http}/list/${u.pubkey}?until=${t1}`)).json();
    expect(until.map((d: any) => d.sha256)).toEqual([r1.sha]);
    const none = await (await fetch(`${relay.http}/list/${u.pubkey}?since=${t2 + 10}`)).json();
    expect(none).toEqual([]);
    const lim = await (await fetch(`${relay.http}/list/${u.pubkey}?limit=1`)).json();
    expect(lim.length).toBe(1);
    const page2 = await (await fetch(`${relay.http}/list/${u.pubkey}?cursor=${r2.sha}`)).json();
    expect(page2.map((d: any) => d.sha256)).toEqual([r1.sha]);
  });

  test("a stranger's list is empty; blobs shared by two owners appear in both lists", async () => {
    const a = user();
    const b = user();
    const bytes = pngBytes();
    expect((await upload(relay.http, a.sk, bytes)).status).toBe(201);
    expect((await upload(relay.http, b.sk, bytes)).status).toBe(200);
    const la = await (await fetch(`${relay.http}/list/${a.pubkey}`)).json();
    const lb = await (await fetch(`${relay.http}/list/${b.pubkey}`)).json();
    expect(la.map((d: any) => d.sha256)).toEqual([sha256(bytes)]);
    expect(lb.map((d: any) => d.sha256)).toEqual([sha256(bytes)]);
    expect(await (await fetch(`${relay.http}/list/${user().pubkey}`)).json()).toEqual([]);
  });
});

describe("DELETE /<sha256>", () => {
  test("owner deletes; other user gets 403; missing is 404", async () => {
    const owner = user();
    const other = user();
    const r = await upload(relay.http, owner.sk, pngBytes());
    const forbidden = await del(other.sk, r.sha);
    expect(forbidden.status).toBe(403);
    expect((await get(r.sha)).status).toBe(200);
    const ok = await del(owner.sk, r.sha);
    expect(ok.status).toBe(200);
    expect((await get(r.sha)).status).toBe(404);
    expect((await del(owner.sk, r.sha)).status).toBe(404);
  });

  test("auth rules: missing token 401, wrong verb 401, x tag required", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, pngBytes());
    expect((await fetch(`${relay.http}/${r.sha}`, { method: "DELETE" })).status).toBe(401);
    expect((await del(u.sk, r.sha, bauth(u.sk, "upload", { hashes: [r.sha] }))).status).toBe(401);
    expect((await del(u.sk, r.sha, bauth(u.sk, "delete"))).status).toBe(401);
    expect((await get(r.sha)).status).toBe(200);
  });

  test("shared blob survives until its last owner deletes it", async () => {
    const a = user();
    const b = user();
    const bytes = pngBytes();
    const r = await upload(relay.http, a.sk, bytes);
    await upload(relay.http, b.sk, bytes);
    expect((await del(a.sk, r.sha)).status).toBe(200);
    expect((await get(r.sha)).status).toBe(200);
    expect(await (await fetch(`${relay.http}/list/${a.pubkey}`)).json()).toEqual([]);
    expect((await del(b.sk, r.sha)).status).toBe(200);
    expect((await get(r.sha)).status).toBe(404);
  });

  test("a delete token is single-use and an old upload token can't restore the blob", async () => {
    const u = user();
    const bytes = pngBytes();
    const sha = sha256(bytes);
    const uploadToken = bauth(u.sk, "upload", { hashes: [sha], createdAt: Math.floor(Date.now() / 1000) - 5 });
    expect((await upload(relay.http, u.sk, bytes, { auth: uploadToken })).status).toBe(201);
    const delToken = bauth(u.sk, "delete", { hashes: [sha] });
    expect((await del(u.sk, sha, delToken)).status).toBe(200);
    const replay = await upload(relay.http, u.sk, bytes, { auth: uploadToken });
    expect(replay.status).toBe(401);
    expect(replay.headers.get("x-reason")).toContain("predates your deletion");
    // a fresh token re-uploads, but the old delete token can't delete it again
    while (Math.floor(Date.now() / 1000) <= JSON.parse(Buffer.from(delToken.slice(6), "base64").toString()).created_at) await Bun.sleep(20);
    expect((await upload(relay.http, u.sk, bytes)).status).toBe(201);
    const again = await del(u.sk, sha, delToken);
    expect(again.status).toBe(401);
    expect((await get(sha)).status).toBe(200);
  });
});

describe("moderation via admin API", () => {
  test("requireApproval: new uploads are pending, hidden from the public until approved", async () => {
    expect((await api(relay.http, relay.owner.sk, "PATCH", "/settings", { blossom: { requireApproval: true } })).status).toBe(200);
    try {
      const u = user();
      const r = await upload(relay.http, u.sk, pngBytes());
      expect(r.status).toBe(201);
      expect((await get(r.sha)).status).toBe(404);
      expect(await (await fetch(`${relay.http}/list/${u.pubkey}`)).json()).toEqual([]);
      // the uploader sees it with a get token, and in their own authed list
      const mine = await get(r.sha, { headers: { Authorization: bauth(u.sk, "get", { hashes: [r.sha] }) } });
      expect(mine.status).toBe(200);
      expect(mine.headers.get("cache-control")).toContain("no-store");
      const myList = await (await fetch(`${relay.http}/list/${u.pubkey}`, { headers: { Authorization: bauth(u.sk, "list") } })).json();
      expect(myList.map((d: any) => d.sha256)).toEqual([r.sha]);
      // someone else's token doesn't help
      const other = user();
      expect((await get(r.sha, { headers: { Authorization: bauth(other.sk, "get", { hashes: [r.sha] }) } })).status).toBe(404);
      // admin queue
      const pending = await api(relay.http, relay.owner.sk, "GET", "/media?status=pending");
      expect(pending.body.items.map((b: any) => b.sha256)).toContain(r.sha);
      const stats = await api(relay.http, relay.owner.sk, "GET", "/media/stats");
      expect(stats.body.pending).toBeGreaterThanOrEqual(1);
      // admin preview works while pending
      const raw = await fetch(`${relay.http}/admin/api/media/${r.sha}/raw`, {
        headers: { Authorization: nip98(relay.owner.sk, `${relay.http}/admin/api/media/${r.sha}/raw`, "GET") },
      });
      expect(raw.status).toBe(200);
      expect(new Uint8Array(await raw.arrayBuffer())).toEqual(r.bytes);
      const approved = await setStatus(r.sha, "approved");
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("approved");
      expect(approved.body.moderatedBy).toBeNull(); // approving clears the moderator
      expect((await get(r.sha)).status).toBe(200);
    } finally {
      await api(relay.http, relay.owner.sk, "PATCH", "/settings", { blossom: { requireApproval: false } });
    }
  });

  test("blocked: hidden from public and uploader, visible to staff; audit records it", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, pngBytes());
    expect((await setStatus(r.sha, "blocked")).status).toBe(200);
    expect((await get(r.sha)).status).toBe(404);
    expect((await get(r.sha, { method: "HEAD" })).status).toBe(404);
    expect((await get(r.sha, { headers: { Authorization: bauth(u.sk, "get", { hashes: [r.sha] }) } })).status).toBe(404);
    expect((await get(r.sha, { headers: { Authorization: bauth(relay.owner.sk, "get", { hashes: [r.sha] }) } })).status).toBe(200);
    // re-uploading a blocked blob is refused
    const again = await upload(relay.http, u.sk, r.bytes);
    expect(again.status).toBe(403);
    expect(again.headers.get("x-reason")).toBe("blob is blocked on this server");
    const audit = await api(relay.http, relay.owner.sk, "GET", `/audit?action=blob.status&target=${r.sha}`);
    expect(audit.body.items[0].details.status).toBe("blocked");
    // back to pending: the uploader may see it again with a token
    expect((await setStatus(r.sha, "pending")).status).toBe(200);
    expect((await get(r.sha, { headers: { Authorization: bauth(u.sk, "get", { hashes: [r.sha] }) } })).status).toBe(200);
    expect((await get(r.sha)).status).toBe(404);
  });

  test("admin delete with block=true: gone, on the blocklist, re-upload and preflight refused; unblock lifts it", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, pngBytes());
    const d = await api(relay.http, relay.owner.sk, "DELETE", `/media/${r.sha}?block=true`);
    expect(d.status).toBe(200);
    expect((await get(r.sha)).status).toBe(404);
    const bl = await api(relay.http, relay.owner.sk, "GET", "/media/blocklist");
    expect(bl.body.items.map((e: any) => e.sha256)).toContain(r.sha);
    const other = user();
    const re = await upload(relay.http, other.sk, r.bytes);
    expect(re.status).toBe(403);
    const pre = await fetch(`${relay.http}/upload`, {
      method: "HEAD",
      headers: { Authorization: bauth(other.sk, "upload", { hashes: [r.sha] }), "X-SHA-256": r.sha, "X-Content-Length": "10" },
    });
    expect(pre.status).toBe(403);
    expect((await api(relay.http, relay.owner.sk, "DELETE", `/media/blocklist/${r.sha}`)).status).toBe(200);
    expect((await api(relay.http, relay.owner.sk, "DELETE", `/media/blocklist/${r.sha}`)).status).toBe(404);
    expect((await upload(relay.http, other.sk, r.bytes)).status).toBe(201);
  });

  test("blocked blob deleted by its owner stays blocked (moderation outlives deletion)", async () => {
    const u = user();
    const r = await upload(relay.http, u.sk, pngBytes());
    expect((await setStatus(r.sha, "blocked")).status).toBe(200);
    // owners may still delete their copy of a blocked blob; it then goes on the blocklist
    expect((await del(u.sk, r.sha)).status).toBe(200);
    expect((await api(relay.http, relay.owner.sk, "GET", `/media/${r.sha}`)).status).toBe(404);
    const bl = await api(relay.http, relay.owner.sk, "GET", "/media/blocklist");
    expect(bl.body.items.map((e: any) => e.sha256)).toContain(r.sha);
    expect((await upload(relay.http, user().sk, r.bytes)).status).toBe(403);
  });

  test("bulk approve / block / delete with per-item failures", async () => {
    const u = user();
    const a = await upload(relay.http, u.sk, pngBytes());
    const b = await upload(relay.http, u.sk, pngBytes());
    const block = await api(relay.http, relay.owner.sk, "POST", "/media/bulk", { sha256s: [a.sha, b.sha], action: "block" });
    expect(block.body).toEqual({ ok: 2, failed: [] });
    expect((await get(a.sha)).status).toBe(404);
    const approve = await api(relay.http, relay.owner.sk, "POST", "/media/bulk", { sha256s: [a.sha, "e".repeat(64)], action: "approve" });
    expect(approve.body.ok).toBe(1);
    expect(approve.body.failed.map((f: any) => f.sha256)).toEqual(["e".repeat(64)]);
    expect((await get(a.sha)).status).toBe(200);
    const delr = await api(relay.http, relay.owner.sk, "POST", "/media/bulk", { sha256s: [a.sha, b.sha], action: "delete" });
    expect(delr.body.ok).toBe(2);
    expect((await get(a.sha)).status).toBe(404);
    const list = await api(relay.http, relay.owner.sk, "GET", `/media?pubkey=${u.pubkey}`);
    expect(list.body.total).toBe(0);
    const bad = await api(relay.http, relay.owner.sk, "POST", "/media/bulk", { sha256s: ["nothex"], action: "delete" });
    expect(bad.status).toBe(400);
  });

  test("admin media list filters by pubkey, status and type", async () => {
    const u = user();
    const png = await upload(relay.http, u.sk, pngBytes());
    const pdf = await upload(relay.http, u.sk, pdfBytes(), { type: "application/pdf" });
    const mine = await api(relay.http, relay.owner.sk, "GET", `/media?pubkey=${u.pubkey}`);
    expect(mine.body.total).toBe(2);
    expect(mine.body.items.every((i: any) => i.owners.includes(u.pubkey))).toBe(true);
    const onlyPdf = await api(relay.http, relay.owner.sk, "GET", `/media?pubkey=${u.pubkey}&type=application/pdf`);
    expect(onlyPdf.body.items.map((i: any) => i.sha256)).toEqual([pdf.sha]);
    const rec = await api(relay.http, relay.owner.sk, "GET", `/media/${png.sha}`);
    expect(rec.body).toMatchObject({ sha256: png.sha, type: "image/png", status: "approved", owners: [u.pubkey] });
    expect((await api(relay.http, relay.owner.sk, "GET", "/media?pubkey=nope")).status).toBe(400);
    expect((await api(relay.http, relay.owner.sk, "GET", "/media/xyz")).status).toBe(400);
  });
});
