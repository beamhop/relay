import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobDriver, createFsDriver, createS3Driver, streamToBytes } from "../src";

const sha = "ab".repeat(32);
const sha2 = "cd".repeat(32);
const enc = (s: string) => new TextEncoder().encode(s);
const text = async (s: ReadableStream<Uint8Array>) => new TextDecoder().decode(await streamToBytes(s));

describe("fs driver", () => {
  const root = mkdtempSync(join(tmpdir(), "beamhop-fsdrv-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const d = createFsDriver(root);

  test("put/get/has/delete with sharded layout", async () => {
    expect(await d.has(sha)).toBe(false);
    expect(await d.get(sha)).toBeUndefined();
    await d.put(sha, enc("hello world"), "text/plain");
    expect(existsSync(join(root, "ab", "ab", sha))).toBe(true);
    expect(readdirSync(join(root, "ab", "ab")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await d.has(sha)).toBe(true);
    const obj = (await d.get(sha))!;
    expect(obj.size).toBe(11);
    expect(await text(obj.body)).toBe("hello world");
    await d.delete(sha);
    expect(await d.has(sha)).toBe(false);
    await d.delete(sha); // idempotent
  });

  test("range reads", async () => {
    await d.put(sha, enc("0123456789"), "text/plain");
    const obj = (await d.get(sha, { start: 2, end: 5 }))!;
    expect(obj.size).toBe(10);
    expect(obj.range).toEqual({ start: 2, end: 5 });
    expect(await text(obj.body)).toBe("2345");
  });

  test("stream input and thumbnails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc("ab"));
        c.enqueue(enc("cd"));
        c.close();
      },
    });
    await d.put(sha2, stream, "text/plain");
    expect(await text((await d.get(sha2))!.body)).toBe("abcd");
    await d.putThumbnail(sha2, enc("thumb"));
    expect(existsSync(join(root, "cd", "cd", `${sha2}.thumb.webp`))).toBe(true);
    expect(await text((await d.getThumbnail(sha2))!.body)).toBe("thumb");
    await d.delete(sha2);
    expect(await d.getThumbnail(sha2)).toBeUndefined();
  });

  test("rejects invalid keys", async () => {
    await expect(d.put("../etc/passwd", enc("x"), "text/plain")).rejects.toThrow();
  });

  test("createBlobDriver picks fs by default", () => {
    expect(createBlobDriver({ enabled: true, driver: "fs", fsPath: root }).name).toBe("fs");
    expect(() => createBlobDriver({ enabled: true, driver: "s3", fsPath: root })).toThrow();
  });
});

describe("s3 driver", () => {
  function mockS3() {
    const objects = new Map<string, Uint8Array>();
    const calls: { method: string; url: string; auth: string | null }[] = [];
    const fetchFn = (async (input: Request) => {
      const req = input instanceof Request ? input : new Request(input);
      calls.push({ method: req.method, url: req.url, auth: req.headers.get("authorization") });
      const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/bucket\//, ""));
      const obj = objects.get(key);
      switch (req.method) {
        case "PUT":
          objects.set(key, new Uint8Array(await req.arrayBuffer()));
          return new Response(null, { status: 200 });
        case "HEAD":
          return new Response(null, { status: obj ? 200 : 404 });
        case "DELETE":
          objects.delete(key);
          return new Response(null, { status: 204 });
        case "GET": {
          if (!obj) return new Response("NoSuchKey", { status: 404 });
          const m = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "");
          if (m) {
            const [s, e] = [Number(m[1]), Number(m[2])];
            return new Response(obj.slice(s, e + 1), { status: 206, headers: { "content-range": `bytes ${s}-${e}/${obj.length}` } });
          }
          return new Response(obj as BodyInit, { status: 200, headers: { "content-length": String(obj.length) } });
        }
      }
      return new Response(null, { status: 405 });
    }) as unknown as typeof fetch;
    return { objects, calls, fetchFn };
  }

  test("signed put/get/range/has/delete + thumbnails", async () => {
    const s3 = mockS3();
    const d = createS3Driver({ endpoint: "https://s3.test/", bucket: "bucket", accessKeyId: "AK", secretAccessKey: "SK", fetch: s3.fetchFn });
    await d.put(sha, enc("0123456789"), "text/plain");
    expect(s3.calls[0].url).toBe(`https://s3.test/bucket/${sha}`);
    expect(s3.calls[0].auth).toStartWith("AWS4-HMAC-SHA256");
    expect(await d.has(sha)).toBe(true);
    const full = (await d.get(sha))!;
    expect(full.size).toBe(10);
    expect(await text(full.body)).toBe("0123456789");
    const part = (await d.get(sha, { start: 3, end: 4 }))!;
    expect(part.size).toBe(10);
    expect(part.range).toEqual({ start: 3, end: 4 });
    expect(await text(part.body)).toBe("34");
    await d.putThumbnail(sha, enc("t"));
    expect(s3.objects.has(`${sha}.thumb.webp`)).toBe(true);
    await d.delete(sha);
    expect(s3.objects.size).toBe(0);
    expect(await d.has(sha)).toBe(false);
    expect(await d.get(sha)).toBeUndefined();
    expect(d.publicUrl).toBeUndefined();
  });

  test("publicUrl", () => {
    const d = createS3Driver({ endpoint: "https://s3.test", bucket: "b", accessKeyId: "a", secretAccessKey: "s", publicUrl: "https://media.test/" });
    expect(d.publicUrl!(sha)).toBe(`https://media.test/${sha}`);
  });
});
