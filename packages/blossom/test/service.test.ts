import { afterEach, describe, expect, test } from "bun:test";
import { createS3Driver, loadSharp } from "../src";
import { PNG_1x1, authHeader, createHarness, newUser, sha256, type Harness } from "./fakes";

let h: Harness;
afterEach(() => h?.cleanup());
const alice = newUser();
const bob = newUser();
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

const upload = (data: Uint8Array, u = alice) =>
  h.request("/upload", { method: "PUT", body: data as BodyInit, headers: { authorization: authHeader(u.sk, "upload") } });

describe("admin service methods", () => {
  test("list / get / usage / stats / deleteByPubkey / delete", async () => {
    h = await createHarness({ useSharp: false });
    await upload(PDF);
    await upload(PNG_1x1);
    await upload(PNG_1x1, bob);
    const pdf = await sha256(PDF);
    const png = await sha256(PNG_1x1);

    const all = await h.svc.list({});
    expect(all.total).toBe(2);
    expect(all.items.find((b) => b.sha256 === png)!.owners.sort()).toEqual([alice.pubkey, bob.pubkey].sort());
    expect((await h.svc.list({ type: "image" })).items.map((b) => b.sha256)).toEqual([png]);
    expect((await h.svc.list({ type: "application/pdf" })).total).toBe(1);
    expect((await h.svc.list({ pubkey: bob.pubkey })).total).toBe(1);
    expect((await h.svc.list({ status: "pending" })).total).toBe(0);
    const page = await h.svc.list({ limit: 1, offset: 1 });
    expect(page.items.length).toBe(1);
    expect(page.total).toBe(2);

    const rec = (await h.svc.get(pdf))!;
    expect(rec).toMatchObject({ sha256: pdf, type: "application/pdf", status: "approved", url: `https://cdn.example.com/${pdf}.pdf`, hasThumbnail: false });
    expect(await h.svc.get("0".repeat(64))).toBeUndefined();

    expect(await h.svc.usage(alice.pubkey)).toEqual({ count: 2, bytes: PDF.length + PNG_1x1.length });
    const stats = await h.svc.stats();
    expect(stats.count).toBe(2);
    expect(stats.bytes).toBe(PDF.length + PNG_1x1.length);
    expect(stats.byType.map((t) => t.type).sort()).toEqual(["application", "image"]);

    expect(await h.svc.deleteByPubkey(alice.pubkey, "admin")).toBe(2);
    expect(await h.svc.get(pdf)).toBeUndefined();
    expect(await h.svc.driver.has(pdf)).toBe(false);
    expect((await h.svc.get(png))!.owners).toEqual([bob.pubkey]);

    await h.svc.delete(png, "admin");
    expect(await h.svc.get(png)).toBeUndefined();
    expect(await h.svc.driver.has(png)).toBe(false);
    expect(h.deps.stores.audit.entries.map((e) => e.action)).toEqual(["blob.deleteByPubkey", "blob.delete"]);
    expect(await h.svc.setStatus(png, "approved", "admin").catch(() => "missing")).toBe("missing");
  });
});

describe("thumbnails (sharp)", () => {
  test("generated for images and served at /<sha>.thumb.webp", async () => {
    const sharp = (await loadSharp()) as unknown as ((...a: unknown[]) => any) | undefined;
    if (!sharp) return;
    h = await createHarness();
    const img = new Uint8Array(await sharp({ create: { width: 800, height: 400, channels: 3, background: "#0a0" } }).png().toBuffer());
    const desc = await (await upload(img)).json();
    expect(desc.nip94).toContainEqual(["thumb", `https://cdn.example.com/${desc.sha256}.thumb.webp`]);
    for (const path of [`/${desc.sha256}.thumb.webp`, `/${desc.sha256}?thumb=1`]) {
      const res = await h.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      const meta = await sharp(new Uint8Array(await res.arrayBuffer())).metadata();
      expect(meta.width).toBe(320);
    }
    expect((await h.svc.get(desc.sha256))!.thumbnailUrl).toBeDefined();
    const pdf = await (await upload(PDF)).json();
    expect((await h.request(`/${pdf.sha256}.thumb.webp`)).status).toBe(404);
  });
});

describe("s3 public url", () => {
  test("approved GETs redirect (307) to the public URL", async () => {
    const objects = new Map<string, Uint8Array>();
    const fetchFn = (async (req: Request) => {
      const key = new URL(req.url).pathname.split("/").pop()!;
      if (req.method === "PUT") objects.set(key, new Uint8Array(await req.arrayBuffer()));
      return new Response(null, { status: req.method === "HEAD" && !objects.has(key) ? 404 : 200 });
    }) as unknown as typeof fetch;
    const driver = createS3Driver({ endpoint: "https://s3.test", bucket: "b", accessKeyId: "a", secretAccessKey: "s", publicUrl: "https://media.test", fetch: fetchFn });
    h = await createHarness({ useSharp: false, driver });
    const desc = await (await upload(PDF)).json();
    expect(objects.has(desc.sha256)).toBe(true);
    const res = await h.request(`/${desc.sha256}.pdf`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`https://media.test/${desc.sha256}`);
  });
});
