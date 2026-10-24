import { afterEach, describe, expect, test } from "bun:test";
import { createBlossomService, createS3Driver, optionsFromConfig } from "../src";
import { PNG_1x1, authHeader, createHarness, newUser, sha256, type Harness } from "./fakes";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const alice = newUser();
const pdf = (n: number) => new TextEncoder().encode(`%PDF-1.4\n% ${n}\n%%EOF\n`);
const upload = (body: Uint8Array, sk = alice.sk) =>
  h!.request("/upload", { method: "PUT", body: body as BodyInit, headers: { authorization: authHeader(sk, "upload", { server: ["cdn.example.com"] }) } });

describe("a block that lands while upload hooks run", () => {
  test("admin blocks the blob while a slow hook is in flight: upload refused, nothing served", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { allowedMimeTypes: ["application/pdf", "image/*"] } } as never, "test");
    const body = pdf(42);
    const x = await sha256(body);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inHook = new Promise<void>((r) => (entered = r));
    h.deps.hooks.onBlobUpload(async () => {
      entered();
      await gate;
      return undefined;
    }, "slow-scanner");
    const up = upload(body);
    await inHook;
    await h.svc.block!(x, "abuse", "admin");
    release();
    expect((await up).status).toBe(403);
    expect((await h.request(`/${x}`)).status).toBe(404);
    expect(await h.svc.get(x)).toBeUndefined();
  });

  test("a hook that blocks the blob it is looking at and then accepts: upload refused", async () => {
    h = await createHarness({ useSharp: false });
    const x = await sha256(PNG_1x1);
    h.deps.hooks.onBlobUpload(async (info) => {
      await h!.svc.block!(info.sha256, "auto", "plugin");
      return undefined;
    }, "t");
    expect((await upload(PNG_1x1)).status).toBe(403);
    expect((await h.request(`/${x}`)).status).toBe(404);
  });
});

describe("hooks only see uploads that pass the cheap checks", () => {
  test("over-quota uploads never reach hooks", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { allowedMimeTypes: ["application/pdf"] } } as never, "test");
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: 1 } as never);
    let calls = 0;
    h.deps.hooks.onBlobUpload(async () => {
      calls++;
      return undefined;
    }, "scanner");
    expect((await upload(pdf(7))).status).toBe(413);
    expect(calls).toBe(0);
  });

  test("a blob moderated to 'blocked' is refused before hooks", async () => {
    h = await createHarness({ useSharp: false });
    const x = await sha256(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(200);
    await h.svc.setStatus(x, "blocked", "admin");
    let calls = 0;
    h.deps.hooks.onBlobUpload(async () => {
      calls++;
      return undefined;
    }, "scanner");
    expect((await upload(PNG_1x1, newUser().sk)).status).toBe(403);
    expect(calls).toBe(0);
  });
});

describe("S3 moves that are denied", () => {
  function s3(opts: { denyCopy?: boolean } = {}) {
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
            if (opts.denyCopy) return deny(); // e.g. a KMS key or bucket policy refusing the copy
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
          return obj ? new Response(obj as BodyInit) : deny();
      }
      return new Response(null, { status: 405 });
    }) as unknown as typeof fetch;
    return { objects, fetchFn };
  }
  const sha = "a".repeat(64);

  test("a copy denied while the source exists throws instead of reporting success", async () => {
    const s = s3({ denyCopy: true });
    const warnings: string[] = [];
    const d = createS3Driver({ endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", publicUrl: "https://cdn.test", fetch: s.fetchFn, warn: (m) => warnings.push(m) });
    await d.put(sha, new Uint8Array([1, 2, 3]), "image/png", { hidden: false });
    await expect(d.setHidden!(sha, true, { hasThumbnail: false })).rejects.toThrow(/denied \(403\) while the source exists/);
    expect(s.objects.has(sha)).toBe(true); // still where it was, and the caller knows
    // a 403 that is treated as "missing" is logged, so a real permission problem shows up somewhere
    expect(await d.has("b".repeat(64))).toBe(false);
    expect(warnings.length).toBe(1);
  });

  test("a blob found under neither key throws", async () => {
    const s = s3();
    const d = createS3Driver({ endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", publicUrl: "https://cdn.test", fetch: s.fetchFn });
    await expect(d.setHidden!(sha, true, { hasThumbnail: false })).rejects.toThrow(/not found under either key/);
  });

  test("setStatus leaves the status unchanged when the move fails", async () => {
    const s = s3({ denyCopy: true });
    const driver = createS3Driver({ endpoint: "https://s3.test", bucket: "bucket", accessKeyId: "a", secretAccessKey: "s", publicUrl: "https://cdn.test", fetch: s.fetchFn });
    h = await createHarness({ useSharp: false, driver });
    const x = await sha256(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(200);
    await expect(h.svc.setStatus(x, "blocked", "admin")).rejects.toThrow();
    expect((await h.svc.get(x))?.status).toBe("approved");
  });
});

describe("used delete tokens survive a restart", () => {
  test("replaying a used delete token after a restart and re-upload is refused", async () => {
    h = await createHarness({ useSharp: false });
    const x = await sha256(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(200);
    const token = authHeader(alice.sk, "delete", { x: [x] });
    expect((await h.request(`/${x}`, { method: "DELETE", headers: { authorization: token } })).status).toBe(200);
    expect(Object.keys(await h.deps.stores.kv.list("blossom-used-delete-tokens")).length).toBe(1);

    // "restart": a fresh service (empty in-memory caches) over the same stores
    const svc2 = await createBlossomService(h.deps as never, { useSharp: false });
    const req = (path: string, init?: RequestInit) => svc2.app.fetch(new Request(`https://cdn.example.com${path}`, init));
    expect((await req("/upload", { method: "PUT", body: PNG_1x1 as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { server: ["cdn.example.com"] }) } })).status).toBe(200);
    expect((await req(`/${x}`, { method: "DELETE", headers: { authorization: token } })).status).toBe(401);
    expect((await req(`/${x}`)).status).toBe(200);
  });
});

describe("mirror timeouts", () => {
  test("a body cut off by the transfer timeout is a 504, not a 502", async () => {
    const remote = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(1000));
    const x = await sha256(remote);
    const fetchFn = (async (_url: string, init?: { signal?: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(remote.slice(0, 10)); // then stalls until the timeout fires
          init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/pdf" } });
    }) as unknown as typeof fetch;
    h = await createHarness({ useSharp: false, fetch: fetchFn, mirrorTimeoutMs: 150, uploadStallMs: 60_000 });
    await h.deps.settings.update({ blossom: { allowedMimeTypes: ["application/pdf"] } } as never, "test");
    const res = await h.request("/mirror", {
      method: "PUT",
      body: JSON.stringify({ url: "https://example.org/a.pdf" }),
      headers: { authorization: authHeader(alice.sk, "upload", { x: [x] }), "content-type": "application/json" },
    });
    expect(res.status).toBe(504);
  });
});

describe("config", () => {
  test("an empty mirror port list is rejected", () => {
    expect(() => optionsFromConfig({ blossom: { limits: { mirrorPorts: [] } } } as never)).toThrow(/at least one port/);
  });
});
