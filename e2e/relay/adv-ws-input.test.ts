/**
 * Adversarial websocket input: hostile JSON shapes, filter/parameter abuse and RFC 6455 protocol violations sent to a
 * real relay over raw TCP. The relay must answer with NIP-01 refusals (or drop just the offending connection) and keep
 * serving everybody else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import type { Relay } from "../harness/relay";
import { RelayClient, newUser, sign } from "../harness/client";
import { clients, isClosed, isEose, isEventFor, publishOk, rand, startCoreRelay } from "./core-helpers";
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

async function raw(headers?: Record<string, string>): Promise<RawWs> {
  const w = await RawWs.open(relay.port, { headers });
  raws.push(w);
  await w.waitFor((m) => m[0] === "AUTH");
  return w;
}

/** The connection still answers a REQ (it wasn't killed or wedged by what came before). */
async function stillServes(w: RawWs) {
  const sub = `alive-${rand(3)}`;
  w.json(["REQ", sub, { limit: 0 }]);
  await w.waitFor((m) => m[0] === "EOSE" && m[1] === sub, 2000);
}

/** The relay as a whole still serves a fresh client end to end (publish → live delivery). */
async function relayHealthy() {
  const a = await cs.connect(relay.ws);
  const b = await cs.connect(relay.ws);
  const sub = `h-${rand(3)}`;
  b.send(["REQ", sub, { kinds: [1], "#t": [sub] }]);
  await b.waitFor(isEose(sub));
  const ev = sign(newUser().sk, { kind: 1, content: "healthy", tags: [["t", sub]] });
  await publishOk(a, ev);
  await b.waitFor(isEventFor(sub, ev.id), 2000);
}

const reason = (m: unknown[]) => String(m[m.length - 1]);

describe("hostile JSON", () => {
  test("a 60k-deep nested array is refused with a NOTICE and the connection stays usable", async () => {
    const w = await raw();
    w.text("[".repeat(60_000) + "]".repeat(60_000));
    const n = await w.waitFor((m) => m[0] === "NOTICE");
    expect(reason(n)).toStartWith("invalid:");
    await stillServes(w);
  });

  test("deep nesting inside a filter value or as a filter object is CLOSED invalid:", async () => {
    const w = await raw();
    w.text(`["REQ","n1",{"#t":${"[".repeat(50_000)}${"]".repeat(50_000)}}]`);
    expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === "n1"))).toStartWith("invalid:");
    w.text(`["REQ","n2",${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}]`);
    expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === "n2"))).toStartWith("invalid:");
    // a deeply nested event is refused too (tags must be arrays of strings)
    w.text(`["EVENT",{"id":"${"a".repeat(64)}","tags":${"[".repeat(30_000)}${"]".repeat(30_000)}}]`);
    expect(reason(await w.waitFor((m) => m[0] === "OK" || m[0] === "NOTICE"))).toStartWith("invalid:");
    await stillServes(w);
  });

  test("prototype keys in a filter are rejected as unknown keys and pollute nothing", async () => {
    const w = await raw();
    const keys = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "__defineGetter__"];
    for (const [i, k] of keys.entries()) {
      w.text(`["REQ","p${i}",{"${k}":{"limit":0,"kinds":[1]}}]`);
      const m = await w.waitFor((x) => x[0] === "CLOSED" && x[1] === `p${i}`);
      expect(reason(m)).toBe(`invalid: unsupported filter key "${k}"`);
    }
    // a prototype key used as a *tag* name or event field changes nothing either
    w.text('["REQ","pt",{"#_":["x"],"kinds":[1],"limit":0}]');
    await w.waitFor((x) => (x[0] === "CLOSED" || x[0] === "EOSE") && x[1] === "pt");
    expect(({} as Record<string, unknown>).limit).toBeUndefined();
    expect(({} as Record<string, unknown>).kinds).toBeUndefined();
    await stillServes(w);
  });

  test("duplicate keys: the last occurrence wins, consistently", async () => {
    const w = await raw();
    w.text('["REQ","d1",{"limit":-1,"limit":0}]');
    await w.waitFor((m) => m[0] === "EOSE" && m[1] === "d1");
    w.text('["REQ","d2",{"limit":0,"limit":-1}]');
    expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === "d2"))).toStartWith("invalid:");
  });

  test("non-JSON numbers (NaN, Infinity), overflow (1e400) and fractional/negative values are refused; -0, 1.0 and 1e21 are tolerated", async () => {
    const w = await raw();
    for (const lit of ["NaN", "Infinity", "-Infinity", "0x10", "01"]) {
      w.text(`["REQ","nn",{"limit":${lit}}]`);
      expect(reason(await w.waitFor((m) => m[0] === "NOTICE"))).toBe("invalid: malformed JSON");
    }
    const refused: [string, string][] = [
      ["o1", '{"limit":1e400}'],
      ["o2", '{"since":-1}'],
      ["o3", '{"until":-1e300}'],
      ["o4", '{"limit":2.5}'],
      ["o5", '{"kinds":[65536]}'],
      ["o6", '{"kinds":[-1]}'],
      ["o7", '{"kinds":[1e400]}'],
      ["o8", '{"limit":"10"}'],
      ["o9", '{"limit":true}'],
      ["o10", '{"limit":null}'],
      ["o11", '{"since":[1]}'],
    ];
    for (const [sub, f] of refused) {
      w.text(`["REQ","${sub}",${f}]`);
      expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === sub))).toStartWith("invalid:");
    }
    for (const [sub, f] of [["t1", '{"until":-0,"limit":0}'], ["t2", '{"limit":1.0,"kinds":[1.0]}'], ["t3", '{"since":1e21}'], ["t4", '{"until":9007199254740993,"limit":0}']]) {
      w.text(`["REQ","${sub}",${f}]`);
      await w.waitFor((m) => m[0] === "EOSE" && m[1] === sub);
    }
  });

  test("events with hostile field types are refused with OK false (or a NOTICE without an id)", async () => {
    const w = await raw();
    const id = "a".repeat(64);
    const bad = [
      { id, pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: 1e400, kind: 1, tags: [], content: "" },
      { id, pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: -1, kind: 1, tags: [], content: "" },
      { id, pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: 1, kind: 65536, tags: [], content: "" },
      { id, pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: 1, kind: 1, tags: [[]], content: "" },
      { id, pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: 1, kind: 1, tags: [["t", 1]], content: "" },
      { id, pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: 1, kind: 1, tags: {}, content: "" },
      { id, pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: 1, kind: 1, tags: [], content: { toString: "x" } },
    ];
    for (const e of bad) {
      w.json(["EVENT", e]);
      const m = await w.waitFor((x) => x[0] === "OK" && x[1] === id);
      expect(m[2]).toBe(false);
      expect(reason(m)).toStartWith("invalid:");
    }
    w.text(`["EVENT",${JSON.stringify(bad[0]).replace('"kind":1', '"__proto__":{"kind":1}')}]`);
    expect((await w.waitFor((x) => x[0] === "OK" && x[1] === id))[2]).toBe(false);
    w.json(["EVENT"]);
    expect(reason(await w.waitFor((x) => x[0] === "NOTICE"))).toStartWith("invalid:");
    await stillServes(w);
  });
});

describe("oversized parameters", () => {
  test("more filters than max_filters, and more values than the per-filter cap, are CLOSED invalid:", async () => {
    const w = await raw();
    w.json(["REQ", "mf", ...Array.from({ length: 11 }, () => ({}))]);
    expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === "mf"))).toContain("too many filters");
    w.json(["REQ", "mv", { "#t": Array.from({ length: 5001 }, (_, i) => `v${i}`) }]);
    expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === "mv"))).toContain("too many values");
    // the cap is per filter in total, not per key
    w.json(["REQ", "mt", { "#t": Array.from({ length: 3000 }, (_, i) => `t${i}`), "#p": Array.from({ length: 2001 }, (_, i) => `p${i}`) }]);
    expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === "mt"))).toContain("too many values");
    // just under the caps is fine
    w.json(["REQ", "ok", { "#t": Array.from({ length: 5000 }, (_, i) => `k${i}`), limit: 0 }]);
    await w.waitFor((m) => m[0] === "EOSE" && m[1] === "ok");
  });

  test("over-long subscription ids: echoed in CLOSED up to 1 KiB, NOTICE beyond; neither is registered", async () => {
    const w = await raw();
    const kib = "k".repeat(1024);
    w.json(["REQ", kib, { limit: 0 }]);
    expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === kib))).toContain("longer than 64");
    w.json(["REQ", "z".repeat(5000), { limit: 0 }]);
    expect(reason(await w.waitFor((m) => m[0] === "NOTICE"))).toContain("longer than 64");
    // control characters and quotes inside a 64-char id are fine and echoed exactly
    const odd = `\u0000\n"\\ ${"x".repeat(59)}`;
    expect(odd.length).toBe(64);
    w.json(["REQ", odd, { limit: 0 }]);
    await w.waitFor((m) => m[0] === "EOSE" && m[1] === odd);
  });

  test("a frame between max_message_length and the transport cap gets the NIP-01 answer for its sub id", async () => {
    const w = await raw();
    w.json(["REQ", "big", { "#t": ["x".repeat(140_000)] }]);
    expect(reason(await w.waitFor((m) => m[0] === "CLOSED" && m[1] === "big"))).toContain("message too large");
    await stillServes(w);
  });
});

describe("RFC 6455 violations close only the offending connection", () => {
  const violations: [string, (w: RawWs) => void][] = [
    ["invalid UTF-8 in a text frame", (w) => w.sendFrame(1, Buffer.from([0x5b, 0x22, 0xff, 0xfe, 0x22, 0x5d]))],
    ["an unmasked client frame", (w) => w.sendFrame(1, JSON.stringify(["REQ", "u", { limit: 0 }]), { mask: false })],
    ["RSV bits without a negotiated extension", (w) => w.sendFrame(1, JSON.stringify(["REQ", "u", { limit: 0 }]), { rsv: 2 })],
    ["a reserved opcode", (w) => w.sendFrame(3, "x")],
    ["a control frame over 125 bytes", (w) => w.sendFrame(9, Buffer.alloc(200))],
    ["a continuation frame with nothing to continue", (w) => w.sendFrame(0, "x")],
    ["a frame beyond the transport payload cap", (w) => w.text("x".repeat(300_000))],
  ];
  for (const [name, send] of violations) {
    test(name, async () => {
      const bystander = await raw();
      const w = await raw();
      send(w);
      await w.waitClosed(2000);
      await stillServes(bystander);
    });
  }

  test("a frame header announcing a 64 TiB payload is cut off at once, not buffered", async () => {
    const w = await raw();
    const t = Date.now();
    w.sock.write(Buffer.from([0x81, 0xff, 0, 0, 0x40, 0, 0, 0, 0, 0, 1, 2, 3, 4]));
    w.sock.write(Buffer.alloc(64 * 1024, 0x20));
    await w.waitClosed(2000);
    expect(Date.now() - t).toBeLessThan(2000);
    await relayHealthy();
  });

  test("fragmented messages are reassembled; a fragment stream outgrowing the cap is cut off", async () => {
    const w = await raw();
    w.sendFrame(1, '["REQ","frag",', { fin: false });
    w.sendFrame(0, '{"limit"', { fin: false });
    w.sendFrame(9, "ping-in-between");
    w.sendFrame(0, ":0}]");
    await w.waitFor((m) => m[0] === "EOSE" && m[1] === "frag");
    const flood = await raw();
    flood.sendFrame(1, '["REQ","fr",', { fin: false });
    for (let i = 0; i < 400; i++) flood.sendFrame(0, " ".repeat(1000), { fin: false });
    await flood.waitClosed(2000);
    await stillServes(w);
  });

  test("a permessage-deflate bomb (≈50 MB inflated from 50 KB) is cut off; normal compressed frames work", async () => {
    const ext = { "Sec-WebSocket-Extensions": "permessage-deflate" };
    const ok = await raw(ext);
    ok.sendFrame(1, deflateRawSync(Buffer.from(JSON.stringify(["REQ", "z-ok", { limit: 0 }]))), { rsv: 4 });
    await ok.waitFor((m) => m[0] === "EOSE" && m[1] === "z-ok");
    const bomb = deflateRawSync(Buffer.concat([Buffer.from('["REQ","z",{"#t":["'), Buffer.alloc(50_000_000, 0x61), Buffer.from('"]}]')]));
    expect(bomb.length).toBeLessThan(100_000);
    const rssBefore = process.memoryUsage().rss;
    const w = await raw(ext);
    w.sendFrame(1, bomb, { rsv: 4 });
    await w.waitClosed(2000);
    // the server must not have inflated the whole thing into memory
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(40 * 1024 * 1024);
    await stillServes(ok);
  });

  test("binary frames carrying a valid JSON message are processed like text", async () => {
    const w = await raw();
    w.sendFrame(2, Buffer.from(JSON.stringify(["REQ", "bin", { limit: 0 }])));
    await w.waitFor((m) => m[0] === "EOSE" && m[1] === "bin");
  });

  test("hundreds of messages pipelined in one TCP write are all answered, in order", async () => {
    const w = await raw();
    const frames: Buffer[] = [];
    for (let i = 0; i < 300; i++) {
      frames.push(Buffer.from(JSON.stringify(["REQ", `q${i}`, { limit: 0 }])));
      frames.push(Buffer.from(JSON.stringify(["CLOSE", `q${i}`])));
    }
    w.sock.write(Buffer.concat(frames.map((f) => encodeFrame(1, f))));
    await w.waitFor((m) => m[0] === "EOSE" && m[1] === "q299", 4000);
    const eose = w.messages().filter((m) => m[0] === "EOSE").map((m) => m[1]);
    expect(eose).toEqual(Array.from({ length: 300 }, (_, i) => `q${i}`));
  });
});

test("after all of the above the relay still serves new clients end to end", async () => {
  await relayHealthy();
  const c = await RelayClient.connect(relay.ws);
  const sub = `final-${rand(3)}`;
  const { events } = await c.query(sub, [{ kinds: [1], limit: 1 }]);
  expect(events.length).toBeLessThanOrEqual(1);
  expect(c.inbox.some(isClosed(sub))).toBe(false);
  c.close();
});
