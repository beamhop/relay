/** NIP-11 relay information document vs configured settings, and enforcement of every advertised limitation. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { finalizeEvent, getEventHash, getPublicKey, type Event } from "nostr-tools";
import type { Relay } from "../harness/relay";
import { newUser } from "../harness/client";
import { clients, ids, isClosed, isEose, now, patchSettings, publishOk, rand, sign, startCoreRelay } from "./core-helpers";

const operator = newUser().pubkey;
const LIMITS = {
  maxSubscriptions: 3,
  maxFilters: 2,
  maxLimit: 5,
  defaultLimit: 3,
  maxEventTags: 10,
  maxContentLength: 100,
  minPowDifficulty: 8,
  createdAtUpperSec: 60,
  createdAtLowerSec: 3600,
};
const INFO = { name: `e2e relay ${rand(3)}`, description: "core e2e", contact: "mailto:ops@example.test", pubkey: operator };

let relay: Relay;
const cs = clients();
beforeAll(async () => {
  relay = await startCoreRelay({ info: INFO, limits: LIMITS });
});
afterEach(() => cs.closeAll());
afterAll(() => relay?.stop());

const nip11 = async () => {
  const res = await fetch(relay.http, { headers: { Accept: "application/nostr+json" } });
  return { res, doc: (await res.json()) as Record<string, any> };
};

function leadingZeroBits(hex: string) {
  let n = 0;
  for (const ch of hex) {
    const v = parseInt(ch, 16);
    if (v === 0) {
      n += 4;
      continue;
    }
    return n + Math.clz32(v) - 28;
  }
  return n;
}

/** NIP-13: mines a nonce so the id has at least `bits` leading zero bits (committing to `target`), then signs. */
function mined(sk: Uint8Array, bits: number, t: { kind: number; content: string; created_at?: number; tags?: string[][] }, target = bits): Event {
  const pubkey = getPublicKey(sk);
  const created_at = t.created_at ?? now();
  for (let nonce = 0; ; nonce++) {
    const tags = [...(t.tags ?? []), ["nonce", String(nonce), String(target)]];
    const id = getEventHash({ pubkey, created_at, kind: t.kind, tags, content: t.content });
    if (leadingZeroBits(id) >= bits) return finalizeEvent({ created_at, kind: t.kind, tags, content: t.content }, sk);
  }
}
const powSign = (sk: Uint8Array, t: { kind: number; content: string; created_at?: number; tags?: string[][] }) => mined(sk, LIMITS.minPowDifficulty, t);

describe("document", () => {
  test("served on / for Accept: application/nostr+json with CORS", async () => {
    const { res } = await nip11();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/nostr+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("a plain GET / is not the NIP-11 document", async () => {
    const res = await fetch(relay.http, { headers: { Accept: "text/html" } });
    expect(res.headers.get("content-type") ?? "").not.toContain("application/nostr+json");
  });

  test("CORS preflight on / allows any origin", async () => {
    const res = await fetch(relay.http, {
      method: "OPTIONS",
      headers: { Origin: "https://client.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "accept" },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("info fields reflect the configured settings", async () => {
    const { doc } = await nip11();
    expect(doc.name).toBe(INFO.name);
    expect(doc.description).toBe(INFO.description);
    expect(doc.contact).toBe(INFO.contact);
    expect(doc.pubkey).toBe(operator);
    expect(doc.self).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof doc.software).toBe("string");
    expect(typeof doc.version).toBe("string");
  });

  test("supported_nips is a sorted list of integers including the NIPs this suite exercises", async () => {
    const { doc } = await nip11();
    const nips = doc.supported_nips as number[];
    expect(nips.every((n) => Number.isInteger(n))).toBe(true);
    expect([...nips].sort((a, b) => a - b)).toEqual(nips);
    for (const n of [1, 9, 11, 13, 40, 42, 45, 50]) expect(nips).toContain(n);
  });

  test("limitation mirrors the configured limits", async () => {
    const { doc } = await nip11();
    expect(doc.limitation).toMatchObject({
      max_subscriptions: LIMITS.maxSubscriptions,
      max_filters: LIMITS.maxFilters,
      max_limit: LIMITS.maxLimit,
      default_limit: LIMITS.defaultLimit,
      max_subid_length: 64,
      max_event_tags: LIMITS.maxEventTags,
      max_content_length: LIMITS.maxContentLength,
      min_pow_difficulty: LIMITS.minPowDifficulty,
      created_at_upper_limit: LIMITS.createdAtUpperSec,
      created_at_lower_limit: LIMITS.createdAtLowerSec,
      auth_required: false,
      payment_required: false,
      restricted_writes: false,
    });
    expect(typeof doc.limitation.max_message_length).toBe("number");
  });

  test("a settings change is reflected in the document without a restart", async () => {
    const description = `changed ${rand()}`;
    await patchSettings(relay, { info: { description } });
    try {
      expect((await nip11()).doc.description).toBe(description);
    } finally {
      await patchSettings(relay, { info: { description: INFO.description } });
    }
  });
});

describe("advertised limitations are enforced", () => {
  test("max_subscriptions: the extra REQ is CLOSED; closing one frees a slot", async () => {
    const c = await cs.connect(relay.ws);
    for (let i = 0; i < LIMITS.maxSubscriptions; i++) await c.query(`s${i}`, [{ limit: 0 }], false);
    c.send(["REQ", "over", { limit: 0 }]);
    const m = await c.waitFor(isClosed("over"));
    expect(m[2] as string).toMatch(/^(rate-limited|restricted|blocked):/);
    c.send(["CLOSE", "s0"]);
    c.send(["REQ", "again", { limit: 0 }]);
    await c.waitFor(isEose("again"));
  });

  test("max_subscriptions is per connection", async () => {
    const a = await cs.connect(relay.ws);
    const b = await cs.connect(relay.ws);
    for (let i = 0; i < LIMITS.maxSubscriptions; i++) await a.query(`a${i}`, [{ limit: 0 }], false);
    await b.query("b0", [{ limit: 0 }], false);
  });

  test("re-using an open sub id does not count as a new subscription", async () => {
    const c = await cs.connect(relay.ws);
    for (let i = 0; i < LIMITS.maxSubscriptions; i++) await c.query(`r${i}`, [{ limit: 0 }], false);
    const { closed } = await c.query("r0", [{ limit: 0 }], false);
    expect(closed).toBeUndefined();
  });

  test("max_filters: a REQ with one filter too many is CLOSED invalid:", async () => {
    const c = await cs.connect(relay.ws);
    expect((await c.query("f-ok", [{ limit: 0 }, { limit: 0 }])).closed).toBeUndefined();
    c.send(["REQ", "f-over", { limit: 0 }, { limit: 0 }, { limit: 0 }]);
    expect((await c.waitFor(isClosed("f-over")))[2] as string).toStartWith("invalid:");
  });

  test("max_limit caps a larger requested limit; default_limit applies when none is given", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t0 = now() - 100;
    const evs: Event[] = [];
    for (let i = 0; i < 8; i++) evs.push(await publishOk(c, powSign(u.sk, { kind: 1, content: `l${i}`, created_at: t0 + i })));
    const newest = ids([...evs].reverse());
    expect(ids((await c.query("ml", [{ authors: [u.pubkey], limit: 100 }])).events)).toEqual(newest.slice(0, LIMITS.maxLimit));
    expect(ids((await c.query("dl", [{ authors: [u.pubkey] }])).events)).toEqual(newest.slice(0, LIMITS.defaultLimit));
  });

  test("max_event_tags and max_content_length", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    // the nonce tag counts: 9 + nonce = 10
    await publishOk(c, powSign(u.sk, { kind: 1, content: "x".repeat(LIMITS.maxContentLength), tags: Array.from({ length: 9 }, (_, i) => ["t", `${i}`]) }));
    const tooMany = await c.publish(powSign(u.sk, { kind: 1, content: "tags", tags: Array.from({ length: 10 }, (_, i) => ["t", `${i}`]) }));
    expect(tooMany.ok).toBe(false);
    expect(tooMany.message).toStartWith("invalid:");
    const tooLong = await c.publish(powSign(u.sk, { kind: 1, content: "x".repeat(LIMITS.maxContentLength + 1) }));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.message).toStartWith("invalid:");
  });

  test("min_pow_difficulty: events below it are refused with pow:, mined ones accepted", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    let weak = sign(u.sk, { kind: 1, content: `weak ${rand()}` });
    // make sure the unmined event really is below the target (1/256 chance it is not)
    while (leadingZeroBits(weak.id) >= LIMITS.minPowDifficulty) weak = sign(u.sk, { kind: 1, content: `weak ${rand()}` });
    const r = await c.publish(weak);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("pow:");
    await publishOk(c, powSign(u.sk, { kind: 1, content: `strong ${rand()}` }));
  });

  test("min_pow_difficulty: enough zero bits but a committed target below the minimum is refused", async () => {
    const c = await cs.connect(relay.ws);
    const ev = mined(newUser().sk, LIMITS.minPowDifficulty, { kind: 1, content: `lucky ${rand()}` }, 4);
    const r = await c.publish(ev);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("pow:");
  });

  test("created_at_upper_limit: further in the future is refused, within it accepted", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const far = await c.publish(powSign(u.sk, { kind: 1, content: "far", created_at: now() + LIMITS.createdAtUpperSec + 30 }));
    expect(far.ok).toBe(false);
    expect(far.message).toStartWith("invalid:");
    await publishOk(c, powSign(u.sk, { kind: 1, content: "near", created_at: now() + LIMITS.createdAtUpperSec - 30 }));
  });

  test("created_at_lower_limit: older than the limit is refused, newer accepted", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const old = await c.publish(powSign(u.sk, { kind: 1, content: "old", created_at: now() - LIMITS.createdAtLowerSec - 60 }));
    expect(old.ok).toBe(false);
    expect(old.message).toStartWith("invalid:");
    await publishOk(c, powSign(u.sk, { kind: 1, content: "recent", created_at: now() - LIMITS.createdAtLowerSec + 60 }));
  });

  test("max_message_length: a message just under it is processed normally", async () => {
    const c = await cs.connect(relay.ws);
    const { doc } = await nip11();
    const max = doc.limitation.max_message_length as number;
    const s = `mm-${rand(3)}`;
    const msg = JSON.stringify(["REQ", s, { "#t": ["x".repeat(max - 200)], limit: 1 }]);
    expect(msg.length).toBeLessThan(max);
    c.ws.send(msg);
    await c.waitFor(isEose(s));
  });
});
