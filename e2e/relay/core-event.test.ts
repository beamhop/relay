/** NIP-01 EVENT / OK semantics and malformed-message (NOTICE) behaviour over a real websocket. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Relay } from "../harness/relay";
import { newUser } from "../harness/client";
import { clients, isNotice, isOk, isClosed, now, plain, publishOk, rand, sendRaw, sign, startCoreRelay } from "./core-helpers";

const MAX_CONTENT = 1000;
const MAX_TAGS = 50;
const MAX_EVENT_BYTES = 8192;
const MAX_MESSAGE_BYTES = 16384;

let relay: Relay;
const cs = clients();
beforeAll(async () => {
  relay = await startCoreRelay({
    limits: { maxContentLength: MAX_CONTENT, maxEventTags: MAX_TAGS, maxEventBytes: MAX_EVENT_BYTES, maxMessageBytes: MAX_MESSAGE_BYTES },
  });
});
afterEach(() => cs.closeAll());
afterAll(() => relay?.stop());

async function stored(id: string) {
  const c = await cs.connect(relay.ws);
  return (await c.query(`s-${rand(4)}`, [{ ids: [id] }])).events;
}

describe("EVENT → OK", () => {
  test("valid event is accepted with OK true and an empty message, then queryable", async () => {
    const c = await cs.connect(relay.ws);
    const ev = sign(newUser().sk, { kind: 1, content: `hello ${rand()}` });
    await publishOk(c, ev);
    expect(await stored(ev.id)).toEqual([plain(ev)]);
  });

  test("event whose id does not match its body is rejected with invalid: and not stored", async () => {
    const c = await cs.connect(relay.ws);
    const ev = { ...sign(newUser().sk, { kind: 1, content: "original" }), content: "tampered" };
    const r = await c.publish(ev);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
    expect(await stored(ev.id)).toEqual([]);
  });

  test("event with a well-formed but wrong signature is rejected with invalid:", async () => {
    const c = await cs.connect(relay.ws);
    const ev = sign(newUser().sk, { kind: 1, content: `sig ${rand()}` });
    const last = ev.sig.at(-1)!;
    const bad = { ...ev, sig: ev.sig.slice(0, -1) + (last === "0" ? "1" : "0") };
    const r = await c.publish(bad);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
    expect(await stored(ev.id)).toEqual([]);
  });

  test("signature by a different key (pubkey swapped) is rejected", async () => {
    const c = await cs.connect(relay.ws);
    const a = sign(newUser().sk, { kind: 1, content: "x", created_at: 1_700_000_000 });
    const b = sign(newUser().sk, { kind: 1, content: "x", created_at: 1_700_000_000 });
    const r = await c.publish({ ...a, sig: b.sig });
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
  });

  test("re-publishing a stored event answers OK true with duplicate:", async () => {
    const c = await cs.connect(relay.ws);
    const ev = sign(newUser().sk, { kind: 1, content: `dup ${rand()}` });
    await publishOk(c, ev);
    const r = await c.publish(ev);
    expect(r.ok).toBe(true);
    expect(r.message).toStartWith("duplicate:");
    // from another connection too
    const c2 = await cs.connect(relay.ws);
    const r2 = await c2.publish(ev);
    expect(r2.ok).toBe(true);
    expect(r2.message).toStartWith("duplicate:");
  });

  test("created_at beyond the advertised upper limit is rejected; within it accepted", async () => {
    const c = await cs.connect(relay.ws);
    const info = await (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json();
    const upper = info.limitation.created_at_upper_limit as number;
    const u = newUser();
    const far = sign(u.sk, { kind: 1, content: "future", created_at: now() + upper + 120 });
    const r = await c.publish(far);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
    await publishOk(c, sign(u.sk, { kind: 1, content: "near future", created_at: now() + Math.floor(upper / 2) }));
  });

  test("old created_at is accepted when no lower limit is configured", async () => {
    const c = await cs.connect(relay.ws);
    const ev = sign(newUser().sk, { kind: 1, content: "from 2001", created_at: 1_000_000_000 });
    await publishOk(c, ev);
    expect(await stored(ev.id)).toHaveLength(1);
  });

  test("OKs come back in submission order for a burst of events", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const evs = Array.from({ length: 20 }, (_, i) => sign(u.sk, { kind: 1, content: `burst ${i} ${rand()}` }));
    for (const ev of evs) c.send(["EVENT", ev]);
    await c.waitFor(isOk(evs.at(-1)!.id));
    // all OK frames remaining in the inbox (and the one consumed) follow the send order
    const order = c.inbox.filter((m) => m[0] === "OK").map((m) => m[1]);
    expect(order).toEqual(evs.slice(0, -1).map((e) => e.id));
  });

  test("unknown extra keys on the event are dropped; the stored copy is canonical", async () => {
    const c = await cs.connect(relay.ws);
    const ev = sign(newUser().sk, { kind: 1, content: `extra ${rand()}` });
    c.send(["EVENT", { ...ev, foo: "bar", seen_on: ["x"] }]);
    const ok = await c.waitFor(isOk(ev.id));
    expect(ok[2]).toBe(true);
    const [got] = await stored(ev.id);
    expect(Object.keys(got).sort()).toEqual(["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
  });

  test("kind 22242 (AUTH) sent as EVENT is refused with invalid:", async () => {
    const c = await cs.connect(relay.ws);
    const ev = sign(newUser().sk, { kind: 22242, tags: [["relay", relay.ws], ["challenge", "x"]] });
    const r = await c.publish(ev);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
  });
});

describe("event shape validation", () => {
  const shapeCases: [string, (ev: Record<string, unknown>) => Record<string, unknown>][] = [
    ["uppercase hex pubkey", (ev) => ({ ...ev, pubkey: (ev.pubkey as string).toUpperCase() })],
    ["missing sig", ({ sig: _s, ...ev }) => ev],
    ["non-integer created_at", (ev) => ({ ...ev, created_at: 1.5 })],
    ["negative kind", (ev) => ({ ...ev, kind: -1 })],
    ["kind above 65535", (ev) => ({ ...ev, kind: 70000 })],
    ["non-string content", (ev) => ({ ...ev, content: 42 })],
    ["tags not an array", (ev) => ({ ...ev, tags: {} })],
    ["empty tag", (ev) => ({ ...ev, tags: [[]] })],
    ["non-string tag value", (ev) => ({ ...ev, tags: [["t", 5]] })],
  ];
  for (const [name, mutate] of shapeCases) {
    test(`${name} → OK false invalid:`, async () => {
      const c = await cs.connect(relay.ws);
      const ev = sign(newUser().sk, { kind: 1, content: `shape ${rand()}` });
      c.send(["EVENT", mutate({ ...ev })]);
      const m = await c.waitFor(isOk(ev.id));
      expect(m[2]).toBe(false);
      expect(m[3] as string).toStartWith("invalid:");
    });
  }

  test("NUL in content is rejected with invalid:", async () => {
    const c = await cs.connect(relay.ws);
    const r = await c.publish(sign(newUser().sk, { kind: 1, content: "a\u0000b" }));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
  });

  test("event with a non-hex id gets an OK false echoing that id", async () => {
    const c = await cs.connect(relay.ws);
    const ev = sign(newUser().sk, { kind: 1, content: "x" });
    c.send(["EVENT", { ...ev, id: "not-an-id" }]);
    const m = await c.waitFor(isOk("not-an-id"));
    expect(m[2]).toBe(false);
    expect(m[3] as string).toStartWith("invalid:");
  });
});

describe("size limits", () => {
  test(`content of exactly max_content_length (${MAX_CONTENT}) is accepted, one more is rejected`, async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 1, content: "a".repeat(MAX_CONTENT) }));
    const r = await c.publish(sign(u.sk, { kind: 1, content: "b".repeat(MAX_CONTENT + 1) }));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
  });

  test("max_content_length counts code points: astral characters at the limit are accepted", async () => {
    const c = await cs.connect(relay.ws);
    // 1000 emoji = 2000 UTF-16 units, 1000 code points
    await publishOk(c, sign(newUser().sk, { kind: 1, content: "😀".repeat(MAX_CONTENT) }));
  });

  test(`exactly max_event_tags (${MAX_TAGS}) tags accepted, one more rejected`, async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const tags = (n: number) => Array.from({ length: n }, (_, i) => ["t", `t${i}`]);
    await publishOk(c, sign(u.sk, { kind: 1, content: "tags ok", tags: tags(MAX_TAGS) }));
    const r = await c.publish(sign(u.sk, { kind: 1, content: "tags over", tags: tags(MAX_TAGS + 1) }));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
  });

  test(`event over maxEventBytes (${MAX_EVENT_BYTES}) but under the message limit is rejected`, async () => {
    const c = await cs.connect(relay.ws);
    const tags = Array.from({ length: 30 }, (_, i) => ["x", `${i}`.padEnd(300, "z")]);
    const ev = sign(newUser().sk, { kind: 1, content: "big", tags });
    expect(JSON.stringify(ev).length).toBeGreaterThan(MAX_EVENT_BYTES);
    expect(JSON.stringify(["EVENT", ev]).length).toBeLessThan(MAX_MESSAGE_BYTES);
    const r = await c.publish(ev);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
    expect(await stored(ev.id)).toEqual([]);
  });

  // regression: the transport cap used to equal maxMessageBytes, so the socket dropped (1006) before the relay
  // could answer the oversized message with OK/CLOSED as NIP-01 requires
  test("EVENT message over max_message_length still gets an OK false for its id", async () => {
    const c = await cs.connect(relay.ws);
    const ev = sign(newUser().sk, { kind: 1, content: "y".repeat(MAX_MESSAGE_BYTES) });
    const r = await c.publish(ev);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
    expect(c.closed).toBe(false);
  });

  test("REQ message over max_message_length is answered with CLOSED for its sub id", async () => {
    const c = await cs.connect(relay.ws);
    c.send(["REQ", "huge", { "#t": Array.from({ length: 1000 }, (_, i) => `value-${i}-padding-padding`) }]);
    const m = await c.waitFor(isClosed("huge"));
    expect(m[2] as string).toStartWith("invalid:");
  });
});

describe("malformed messages → NOTICE", () => {
  const notices: [string, string][] = [
    ["malformed JSON", '["EVENT", {'],
    ["JSON object instead of array", '{"type":"EVENT"}'],
    ["array not starting with a string", "[1, 2, 3]"],
    ["empty array", "[]"],
    ["unknown verb", '["HELLO", "world"]'],
    ["lower-case verb", '["event", {}]'],
    ["EVENT without an event", '["EVENT"]'],
    ["CLOSE without a sub id", '["CLOSE"]'],
  ];
  for (const [name, frame] of notices) {
    test(`${name} → NOTICE with invalid: and the connection stays usable`, async () => {
      const c = await cs.connect(relay.ws);
      sendRaw(c, frame);
      const m = await c.waitFor(isNotice);
      expect(typeof m[1]).toBe("string");
      expect(m[1] as string).toStartWith("invalid:");
      // still open and serving
      const ev = sign(newUser().sk, { kind: 1, content: `after ${rand()}` });
      await publishOk(c, ev);
      expect(c.closed).toBe(false);
    });
  }

  test("EVENT carrying two events is refused (NOTICE, nothing stored)", async () => {
    const c = await cs.connect(relay.ws);
    const a = sign(newUser().sk, { kind: 1, content: `two-a ${rand()}` });
    const b = sign(newUser().sk, { kind: 1, content: `two-b ${rand()}` });
    c.send(["EVENT", a, b]);
    const m = await c.waitFor(isNotice);
    expect(m[1] as string).toStartWith("invalid:");
    expect(await stored(a.id)).toEqual([]);
  });

  test("connecting yields a NIP-42 AUTH challenge first", async () => {
    const c = await cs.connect(relay.ws);
    const m = await c.waitFor((f) => f[0] === "AUTH");
    expect(typeof m[1]).toBe("string");
    expect((m[1] as string).length).toBeGreaterThan(8);
  });
});
