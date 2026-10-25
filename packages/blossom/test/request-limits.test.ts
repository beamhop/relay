import { afterEach, describe, expect, test } from "bun:test";
import { createImageProcessor } from "../src";
import { BlossomCore } from "../src/service";
import { authHeader, createHarness, jpegWithExif, newUser, PNG_1x1, sha256, xOf, type Harness } from "./fakes";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});
const alice = newUser();

describe("GET /list rate limit", () => {
  test("each client IP gets listsPerMinutePerIp listings a minute", async () => {
    h = await createHarness({ useSharp: false, listsPerMinutePerIp: 2 });
    const list = (ip: string) => h!.svc.app.fetch(new Request(`https://cdn.example.com/list/${alice.pubkey}`), { ip });
    expect((await list("203.0.113.1")).status).toBe(200);
    expect((await list("203.0.113.1")).status).toBe(200);
    const limited = await list("203.0.113.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-reason")).toContain("too many");
    expect((await list("203.0.113.2")).status).toBe(200);
  });
});

describe("upload byte budget", () => {
  test("the stripped copy is reserved from the upload's budget (503 when it doesn't fit)", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { stripExif: true } } as never, "test");
    const images = await createImageProcessor({ useSharp: false });
    const core = new BlossomCore(h.deps, h.svc.driver, images, {});
    const { withExif, withoutExif } = jpegWithExif();
    const input = { data: withExif, sha256: await sha256(withExif), pubkey: alice.pubkey, tokenCreatedAt: Math.floor(Date.now() / 1000) - 1, strip: true };
    const asked: number[] = [];
    await expect(core.ingest({ ...input, reserve: (n) => (asked.push(n), false) })).rejects.toMatchObject({ status: 503 });
    expect(asked).toEqual([withoutExif.byteLength]);
    expect(await h.svc.get(await sha256(withoutExif))).toBeUndefined();
    const ok = await core.ingest({ ...input, reserve: () => true });
    expect(ok.row.sha256).toBe(await sha256(withoutExif));
  });
});

describe("client aborts", () => {
  test("an upload body that breaks off is a 499, not a 500", async () => {
    h = await createHarness({ useSharp: false });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(PNG_1x1.subarray(0, 10));
        c.error(new Error("connection reset by peer"));
      },
    });
    const res = await h.request("/upload", { method: "PUT", body, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(PNG_1x1)] }) } });
    expect(res.status).toBe(499);
  });
});

