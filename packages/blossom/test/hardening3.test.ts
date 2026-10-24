import { afterEach, describe, expect, test } from "bun:test";
import { readLimited } from "../src/http";
import { ByteBudget, ExpiringSet, KeyedConcurrency } from "../src/limits";
import { PNG_1x1, authHeader, createHarness, newUser, sha256, type Harness, xOf } from "./fakes";

let h: Harness;
afterEach(() => h?.cleanup());
const alice = newUser();
const now = () => Math.floor(Date.now() / 1000);

const stream = (...parts: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });

/** A body that sends `first`, then nothing until `gate` resolves. */
function stalled(first: Uint8Array, gate: Promise<void> = new Promise(() => {})) {
  return new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(first);
      await gate;
      c.close();
    },
  });
}

describe("upload memory budget (D1)", () => {
  test("bytes are reserved as they arrive; chunked bodies count twice; exhausting the budget is a 503", async () => {
    const a = new Uint8Array(1000).fill(1);
    const b = new Uint8Array(500).fill(2);
    const taken: number[] = [];
    const reserve = (n: number) => (taken.push(n), true);
    await readLimited(stream(a, b), 10_000, 1500, { reserve });
    expect(taken).toEqual([1000, 500]);
    taken.length = 0;
    const r = await readLimited(stream(a, b), 10_000, undefined, { reserve });
    expect(taken).toEqual([2000, 1000]); // copied once more at the end
    expect(r.data.byteLength).toBe(1500);
    expect(r.data[999]).toBe(1);
    expect(r.data[1000]).toBe(2);

    const budget = new ByteBudget(() => 2500);
    const l1 = budget.lease();
    await readLimited(stream(a), 10_000, 1000, { reserve: l1.take });
    expect(budget.inUse).toBe(1000);
    const l2 = budget.lease();
    await expect(readLimited(stream(a, b, a), 10_000, 2500, { reserve: l2.take })).rejects.toMatchObject({ status: 503 });
    l1.release();
    l2.release();
    expect(budget.inUse).toBe(0);
  });

  test("a body that stops sending is cut off (408)", async () => {
    await expect(readLimited(stalled(new Uint8Array(10)), 1000, 100, { stallMs: 30 })).rejects.toMatchObject({ status: 408 });
  });

  test("a body trickling below the minimum rate after the grace period is cut off (408)", async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const s = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    const p = readLimited(s, 10_000, undefined, { minBytesPerSec: 100_000, rateGraceMs: 20 });
    ctl.enqueue(new Uint8Array(1));
    await new Promise((r) => setTimeout(r, 40));
    ctl.enqueue(new Uint8Array(1));
    await expect(p).rejects.toMatchObject({ status: 408 });
  });

  test("the route enforces the budget, the per-IP limit and the stall timeout, and frees the budget afterwards", async () => {
    h = await createHarness({ useSharp: false, maxBufferedUploadBytes: 1, maxConcurrentUploadsPerIp: 1, uploadStallMs: 50 });
    // budget floor is 2 × maxUploadBytes, so a normal upload still fits
    const ok = await h.svc.app.fetch(
      new Request("https://cdn.example.com/upload", { method: "PUT", body: PNG_1x1, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(PNG_1x1)] }) } }),
      { ip: "203.0.113.7" },
    );
    expect(ok.status).toBe(201);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const put = (body: BodyInit, ip: string) =>
      h.svc.app.fetch(
        new Request("https://cdn.example.com/upload", { method: "PUT", body, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(PNG_1x1)] }) }, duplex: "half" } as RequestInit),
        { ip },
      );
    const hanging = put(stalled(new Uint8Array([1, 2, 3]), gate), "203.0.113.7");
    await new Promise((r) => setTimeout(r, 10));
    // same IP while its upload is in flight: refused; another IP: fine
    expect((await put(PNG_1x1, "203.0.113.7")).status).toBe(429);
    expect((await put(PNG_1x1, "198.51.100.1")).status).toBe(200);
    expect((await hanging).status).toBe(408);
    release();
    // the slot was given back
    expect((await put(PNG_1x1, "203.0.113.7")).status).toBe(200);
  });

  test("helpers", () => {
    const k = new KeyedConcurrency(2);
    const r1 = k.tryAcquire("a")!;
    k.tryAcquire("a");
    expect(k.tryAcquire("a")).toBeUndefined();
    expect(k.tryAcquire("b")).toBeDefined();
    r1();
    r1(); // idempotent
    expect(k.tryAcquire("a")).toBeDefined();
    expect(k.tryAcquire("a")).toBeUndefined();
  });
});

describe("single-use delete tokens (D2)", () => {
  test("a replayed delete token is refused even after the signer re-uploads the blob", async () => {
    h = await createHarness({ useSharp: false });
    const hash = await sha256(PNG_1x1);
    const up = () => h.request("/upload", { method: "PUT", body: PNG_1x1, headers: { authorization: authHeader(alice.sk, "upload", { x: [hash] }) } });
    expect((await up()).status).toBe(201);
    const token = authHeader(alice.sk, "delete", { x: [hash] });
    const del = (auth: string) => h.request(`/${hash}`, { method: "DELETE", headers: { authorization: auth } });
    expect((await del(token)).status).toBe(200);
    expect((await up()).status).toBe(201);
    expect((await del(token)).status).toBe(401);
    expect((await h.request(`/${hash}`)).status).toBe(200);
    expect((await del(authHeader(alice.sk, "delete", { x: [hash], expiration: now() + 900 }))).status).toBe(200);
  });

  test("used ids expire with their token and the set stays bounded", () => {
    let t = 0;
    const set = new ExpiringSet(2, () => t);
    set.add("a", 100);
    expect(set.has("a")).toBe(true);
    t = 100;
    expect(set.has("a")).toBe(false);
    set.add("b", 1000);
    set.add("c", 1000);
    set.add("d", 1000);
    expect(set.has("b")).toBe(false); // oldest evicted at capacity
    expect(set.has("d")).toBe(true);
  });
});

describe("hidden blob timing (D5)", () => {
  test("with a token, rights are resolved before the lookup (missing and hidden blobs do the same work)", async () => {
    h = await createHarness({ useSharp: false });
    const lookups: string[] = [];
    const users = h.deps.stores.users;
    const get = users.get.bind(users);
    users.get = async (pk) => (lookups.push(pk), get(pk));
    const missing = "ab".repeat(32);
    const res = await h.request(`/${missing}`, { headers: { authorization: authHeader(alice.sk, "get") } });
    expect(res.status).toBe(404);
    expect(lookups).toEqual([alice.pubkey]); // staff check ran although the blob doesn't exist
    lookups.length = 0;
    expect((await h.request(`/${missing}`)).status).toBe(404);
    expect(lookups).toEqual([]); // no token: no auth work at all
  });
});
