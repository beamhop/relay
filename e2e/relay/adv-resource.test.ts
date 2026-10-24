/**
 * Adversarial resource use against a real relay: clients that never read, subscription hoarding followed by abrupt
 * disconnects, connection floods and half-open HTTP requests, EVENT pipelining past the in-flight cap, and request
 * bodies that are too large or never end. The relay must bound what it buffers and keep serving everyone else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import { connect, type Socket } from "node:net";
import type { Relay } from "../harness/relay";
import { RelayClient, newUser, sha256, sign } from "../harness/client";
import { clients, isEose, isEventFor, patchSettings, publishOk, rand, startCoreRelay } from "./core-helpers";
import { api, bauth, nip98 } from "./admin-helpers";
import { RawWs, encodeFrame } from "./adv-helpers";

let relay: Relay;
const cs = clients();
const raws: RawWs[] = [];
beforeAll(async () => {
  relay = await startCoreRelay();
});
afterAll(async () => {
  cs.closeAll();
  for (const r of raws.splice(0)) r.destroy();
  await relay?.stop();
});

const openRaw = async (opts: { headers?: Record<string, string> } = {}) => {
  const w = await RawWs.open(relay.port, opts);
  raws.push(w);
  await w.waitFor((m) => m[0] === "AUTH");
  return w;
};

const connections = async (): Promise<{ userAgent?: string; subscriptions: number }[]> => {
  const r = await api(relay.http, relay.owner.sk, "GET", "/connections");
  expect(r.status).toBe(200);
  return r.body.items;
};

async function until(fn: () => Promise<boolean> | boolean, ms = 3000, step = 20) {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(step);
  }
}

/** Publishes `n` large (≈60 KB) events tagged `t`, pipelined in batches. Returns the publisher's OK latency (max ms). */
async function publishBig(c: RelayClient, t: string, n: number): Promise<{ events: Event[]; maxOkMs: number }> {
  const u = newUser();
  const events: Event[] = [];
  let maxOkMs = 0;
  for (let i = 0; i < n; i += 20) {
    const batch = Array.from({ length: Math.min(20, n - i) }, () => sign(u.sk, { kind: 1, content: rand(30_000), tags: [["t", t]] }));
    const t0 = Date.now();
    const oks = await Promise.all(batch.map((e) => c.publish(e)));
    maxOkMs = Math.max(maxOkMs, Date.now() - t0);
    for (const ok of oks) expect(ok.ok).toBe(true);
    events.push(...batch);
  }
  return { events, maxOkMs };
}

describe("slow readers", () => {
  test("a subscriber that stops reading has live events shed at a bounded buffer, without stalling publishers", async () => {
    const ua = `slow-live-${rand(4)}`;
    const t = `slow-${rand(4)}`;
    const slow = await openRaw({ headers: { "User-Agent": ua } });
    slow.json(["REQ", "s", { kinds: [1], "#t": [t] }]);
    await slow.waitFor((m) => m[0] === "EOSE");
    slow.sock.pause(); // never read again (until the end of the test)
    const pub = await cs.connect(relay.ws);
    // ≈12 MB of live traffic for a client whose kernel buffers hold well under 2 MB
    const { events, maxOkMs } = await publishBig(pub, t, 200);
    expect(maxOkMs).toBeLessThan(1500);
    // the slow connection is kept (live delivery is best effort) …
    expect((await connections()).some((c) => c.userAgent === ua)).toBe(true);
    // … but only a bounded amount was queued for it: when it finally reads, far less than was published arrives
    slow.sock.resume();
    await Bun.sleep(300);
    const sent = events.length * 60_000;
    expect(slow.bytesIn).toBeLessThan(6 * 1024 * 1024);
    expect(slow.bytesIn).toBeLessThan(sent / 2);
    // and once drained it is a normal subscriber again
    const fresh = sign(newUser().sk, { kind: 1, content: "after drain", tags: [["t", t]] });
    await publishOk(pub, fresh);
    await slow.waitFor((m) => m[0] === "EVENT" && (m[2] as Event).id === fresh.id, 2000);
  });

  test("a client that stops reading mid stored query doesn't hold up other clients' queries or publishes", async () => {
    const t = `stored-${rand(4)}`;
    const pub = await cs.connect(relay.ws);
    await publishBig(pub, t, 60); // ≈3.6 MB stored
    const slow = await openRaw();
    slow.sock.pause();
    slow.json(["REQ", "dump", { "#t": [t], limit: 500 }]);
    await Bun.sleep(200); // the relay is now blocked on this client's send buffer
    const other = await cs.connect(relay.ws);
    const t0 = Date.now();
    const { events } = await other.query(`o-${rand(3)}`, [{ "#t": [t], limit: 60 }]);
    expect(events.length).toBe(60);
    await publishOk(other, sign(newUser().sk, { kind: 1, content: "unblocked" }));
    expect(Date.now() - t0).toBeLessThan(1500);
    slow.destroy();
  });
});

describe("slow readers on the admin SSE stream", () => {
  // BUG: packages/admin-api/src/routes/stream.ts:68 calls stream.writeSSE() without awaiting it or checking the
  // client's backlog, so for a staff client that stops reading every event (≤50/s, each up to maxEventBytes) is queued
  // in server memory without bound until the socket dies. Expected: shed events or close the stream once a bounded
  // backlog builds up, like the websocket path does (SOFT/HARD_BUFFER_LIMIT in core/protocol/connection.ts).
  test("an /admin/api/stream client that never reads does not make the server buffer every event (regression)", async () => {
    await patchSettings(relay, { limits: { maxMessageBytes: 4_000_000, maxEventBytes: 2_200_000, maxContentLength: 2_100_000 } });
    const sock = connect({ host: "127.0.0.1", port: relay.port });
    try {
      let bytes = 0;
      await new Promise<void>((r) => sock.on("connect", () => r()));
      const url = `${relay.http}/admin/api/stream?events=1`;
      sock.write(`GET /admin/api/stream?events=1 HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\nAuthorization: ${nip98(relay.owner.sk, url, "GET")}\r\n\r\n`);
      sock.on("data", (d: Buffer) => (bytes += d.length));
      await until(() => bytes > 0);
      sock.pause(); // a dashboard tab that stopped reading
      const pub = await cs.connect(relay.ws);
      const u = newUser();
      for (let i = 0; i < 12; i++) expect((await pub.publish(sign(u.sk, { kind: 1, content: rand(1_000_000) }))).ok).toBe(true); // ≈24 MB
      sock.resume();
      await Bun.sleep(800);
      // kernel socket buffers hold a few MB; everything beyond that was queued by the server for this one client
      expect(bytes).toBeLessThan(12 * 1024 * 1024);
    } finally {
      sock.destroy();
      await patchSettings(relay, { limits: { maxMessageBytes: 131072, maxEventBytes: 65536, maxContentLength: 65536 } });
    }
  });
});

describe("subscription hoarding and abrupt disconnects", () => {
  test("30 subscriptions on each of 10 connections, then TCP resets: nothing lingers and delivery stays prompt", async () => {
    const ua = `hoard-${rand(4)}`;
    const hoarders: RawWs[] = [];
    for (let i = 0; i < 10; i++) {
      const w = await openRaw({ headers: { "User-Agent": ua } });
      for (let s = 0; s < 30; s++) w.json(["REQ", `h${s}`, { kinds: [1], limit: 0 }, { "#t": Array.from({ length: 100 }, (_, k) => `tag${k}`), limit: 0 }]);
      hoarders.push(w);
    }
    await until(async () => (await connections()).filter((c) => c.userAgent === ua).reduce((n, c) => n + c.subscriptions, 0) === 300);
    for (const w of hoarders) w.destroy(); // no close frame: the relay only sees the socket die
    await until(async () => !(await connections()).some((c) => c.userAgent === ua));
    // a fresh subscriber gets live events promptly
    const a = await cs.connect(relay.ws);
    const b = await cs.connect(relay.ws);
    const sub = `fresh-${rand(3)}`;
    b.send(["REQ", sub, { kinds: [1], "#t": [sub] }]);
    await b.waitFor(isEose(sub));
    const ev = sign(newUser().sk, { kind: 1, content: "x", tags: [["t", sub]] });
    const t0 = Date.now();
    await publishOk(a, ev);
    await b.waitFor(isEventFor(sub, ev.id), 1000);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("a burst of 200 distinct REQs on one connection keeps at most max_subscriptions open", async () => {
    const ua = `burst-${rand(4)}`;
    const w = await openRaw({ headers: { "User-Agent": ua } });
    for (let i = 0; i < 200; i++) w.json(["REQ", `b${i}`, { kinds: [1], limit: 0 }]);
    await w.waitFor((m) => (m[0] === "EOSE" || m[0] === "CLOSED") && m[1] === "b199", 4000);
    const closed = w.messages().filter((m) => m[0] === "CLOSED");
    expect(closed.length).toBe(170);
    for (const m of closed) expect(String(m[2])).toStartWith("rate-limited:");
    const mine = (await connections()).find((c) => c.userAgent === ua)!;
    expect(mine.subscriptions).toBe(30);
  });

  test("EVENTs pipelined past the in-flight cap each get exactly one OK", async () => {
    const w = await openRaw();
    const u = newUser();
    const evs = Array.from({ length: 250 }, (_, i) => sign(u.sk, { kind: 1, content: `pipelined ${i} ${rand(2)}` }));
    w.sock.write(Buffer.concat(evs.map((e) => encodeFrame(1, JSON.stringify(["EVENT", e])))));
    await until(() => w.messages().filter((m) => m[0] === "OK").length >= evs.length, 4000);
    await Bun.sleep(100);
    const oks = w.messages().filter((m) => m[0] === "OK");
    expect(oks.length).toBe(evs.length);
    expect(new Set(oks.map((m) => m[1]))).toEqual(new Set(evs.map((e) => e.id)));
    for (const m of oks) if (!m[2]) expect(String(m[3])).toStartWith("rate-limited:");
  });
});

describe("connection floods", () => {
  test("connectionsPerIp caps a parallel flood, and abruptly dropped sockets give their slots back", async () => {
    cs.closeAll();
    for (const r of raws.splice(0)) r.destroy();
    await until(async () => (await connections()).length === 0);
    const before = 0;
    await patchSettings(relay, { limits: { connectionsPerIp: 5 } });
    try {
      const flood = await Promise.all(Array.from({ length: 25 }, () => RawWs.open(relay.port)));
      raws.push(...flood);
      await Bun.sleep(300);
      const open = flood.filter((w) => !w.ended && w.closeCode() === undefined);
      expect(open.length).toBe(Math.max(0, 5 - before));
      for (const w of flood.filter((x) => !open.includes(x))) {
        expect(w.messages().some((m) => m[0] === "NOTICE" && String(m[1]).startsWith("rate-limited:"))).toBe(true);
      }
      for (const w of flood) w.destroy();
      await until(async () => (await connections()).length === before);
      const again = await Promise.all(Array.from({ length: 5 - before }, () => RawWs.open(relay.port)));
      raws.push(...again);
      await Bun.sleep(200);
      expect(again.every((w) => !w.ended && w.closeCode() === undefined)).toBe(true);
      for (const w of again) w.destroy();
    } finally {
      await patchSettings(relay, { limits: { connectionsPerIp: 0 } });
    }
  });

  test("200 half-open HTTP requests (slowloris) and 50 garbage upgrades don't block other clients", async () => {
    const socks: Socket[] = [];
    try {
      for (let i = 0; i < 200; i++) {
        const s = connect({ host: "127.0.0.1", port: relay.port });
        s.on("error", () => {});
        s.on("connect", () => s.write(`GET / HTTP/1.1\r\nHost: x\r\nX-Slow-${i}: `));
        socks.push(s);
      }
      for (let i = 0; i < 50; i++) {
        const s = connect({ host: "127.0.0.1", port: relay.port });
        s.on("error", () => {});
        s.on("connect", () => s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: !!\r\nSec-WebSocket-Version: 99\r\n\r\n\x00\xff garbage`));
        socks.push(s);
      }
      await Bun.sleep(200);
      const t0 = Date.now();
      const info = await fetch(relay.http, { headers: { Accept: "application/nostr+json" } });
      expect(info.status).toBe(200);
      const c = await cs.connect(relay.ws);
      await c.query(`sl-${rand(3)}`, [{ limit: 0 }]);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      for (const s of socks) s.destroy();
    }
  });
});

describe("request bodies", () => {
  const MB = 1024 * 1024;
  /** A chunked request body of `chunks` × 64 KiB (or endless), without Content-Length. */
  const stream = (chunks = Infinity) => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (i++ >= chunks) return c.close();
        c.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
    });
  };
  const send = (path: string, method: string, headers: Record<string, string>, body: ReadableStream<Uint8Array> | string) =>
    fetch(`${relay.http}${path}`, { method, headers, body, duplex: "half" } as RequestInit);

  test("admin API: declared or streamed bodies over 1 MiB are 413 before auth, without reading them to the end", async () => {
    const declared = await send("/admin/api/settings", "PATCH", { "Content-Type": "application/json" }, "x".repeat(2 * MB));
    expect(declared.status).toBe(413);
    expect((await declared.json()).code).toBe("too_large");
    const t0 = Date.now();
    const endless = await send("/admin/api/events/query", "POST", { "Content-Type": "application/json", "X-Requested-With": "beamhop" }, stream());
    expect(endless.status).toBe(413);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("NIP-86 and invite redemption cap unauthenticated chunked bodies (64 KiB / 4 KiB)", async () => {
    const t0 = Date.now();
    const rpc = await send("/", "POST", { "Content-Type": "application/nostr+json+rpc" }, stream());
    expect(rpc.status).toBe(413);
    const redeem = await send("/invite/redeem", "POST", { "Content-Type": "application/json" }, stream());
    expect(redeem.status).toBe(413);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("Blossom: unauthenticated uploads are refused before the body; authorised chunked uploads stop at maxUploadBytes", async () => {
    const anon = await send("/upload", "PUT", { "Content-Type": "image/png" }, stream());
    expect(anon.status).toBe(401);
    const prev = (await api(relay.http, relay.owner.sk, "GET", "/settings")).body.settings.blossom.maxUploadBytes;
    await patchSettings(relay, { blossom: { maxUploadBytes: 512 * 1024, limits: { uploadsPerMinutePerIp: 0, uploadsPerMinutePerPubkey: 0 } } });
    try {
      const u = newUser();
      const whole = new Uint8Array(40 * 64 * 1024).fill(0x61);
      const auth = bauth(u.sk, "upload", { hashes: [sha256(whole)] });
      const t0 = Date.now();
      const r = await send("/upload", "PUT", { "Content-Type": "image/png", Authorization: auth }, stream(40));
      expect(r.status).toBe(413);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect((await fetch(`${relay.http}/${sha256(whole)}`)).status).toBe(404);
      // the mirror request body (a tiny JSON document) is capped too
      const m = await send("/mirror", "PUT", { "Content-Type": "application/json", Authorization: bauth(u.sk, "upload", { hashes: [sha256("x")] }) }, stream());
      expect(m.status).toBe(413);
    } finally {
      await patchSettings(relay, { blossom: { maxUploadBytes: prev } });
    }
  });
});
