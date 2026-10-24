/** Kind semantics: replaceable, addressable, ephemeral, NIP-09 deletion, NIP-40 expiration, NIP-45 COUNT, NIP-50 search. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Relay } from "../harness/relay";
import { newUser, type RelayClient } from "../harness/client";
import { clients, ids, isClosed, isEventFor, now, publishOk, rand, sign, startCoreRelay } from "./core-helpers";

let relay: Relay;
const cs = clients();
beforeAll(async () => {
  relay = await startCoreRelay();
});
afterEach(() => cs.closeAll());
afterAll(() => relay?.stop());

const sub = () => `k-${rand(4)}`;
const q = async (c: RelayClient, filters: Record<string, unknown>[]) => (await c.query(sub(), filters)).events;

async function count(c: RelayClient, filters: Record<string, unknown>[]) {
  const s = sub();
  c.send(["COUNT", s, ...filters]);
  return c.waitFor((m) => (m[0] === "COUNT" || m[0] === "CLOSED") && m[1] === s);
}

describe("replaceable events (0, 3, 10000-19999)", () => {
  for (const kind of [0, 3, 10002]) {
    test(`kind ${kind}: a newer event replaces the older one; an older one is refused as stale`, async () => {
      const c = await cs.connect(relay.ws);
      const u = newUser();
      const t = now() - 100;
      const v1 = await publishOk(c, sign(u.sk, { kind, content: "v1", created_at: t }));
      const v2 = await publishOk(c, sign(u.sk, { kind, content: "v2", created_at: t + 10 }));
      expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [kind] }]))).toEqual([v2.id]);
      expect(await q(c, [{ ids: [v1.id] }])).toEqual([]);
      const old = sign(u.sk, { kind, content: "v0", created_at: t + 5 });
      const r = await c.publish(old);
      expect(r.ok).toBe(true);
      expect(r.message).toStartWith("duplicate:");
      expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [kind] }]))).toEqual([v2.id]);
    });
  }

  test("same created_at: the event with the lowest id is kept", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    const a = sign(u.sk, { kind: 0, content: '{"name":"a"}', created_at: t });
    const b = sign(u.sk, { kind: 0, content: '{"name":"b"}', created_at: t });
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    await publishOk(c, hi);
    await publishOk(c, lo);
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [0] }]))).toEqual([lo.id]);
    // publishing the higher id again does not displace it
    expect((await c.publish(hi)).ok).toBe(true);
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [0] }]))).toEqual([lo.id]);
  });

  test("replacement is per author: two authors keep their own kind 0", async () => {
    const c = await cs.connect(relay.ws);
    const [a, b] = [newUser(), newUser()];
    const ea = await publishOk(c, sign(a.sk, { kind: 0, content: "{}" }));
    const eb = await publishOk(c, sign(b.sk, { kind: 0, content: "{}" }));
    expect(ids(await q(c, [{ authors: [a.pubkey, b.pubkey], kinds: [0] }])).sort()).toEqual([ea.id, eb.id].sort());
  });

  test("a replacement is delivered live to subscribers", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(writer, sign(u.sk, { kind: 0, content: "v1", created_at: now() - 10 }));
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey], kinds: [0] }], false);
    const v2 = await publishOk(writer, sign(u.sk, { kind: 0, content: "v2" }));
    await reader.waitFor(isEventFor(s, v2.id));
  });

  test("a stale (older) replaceable event is not delivered live", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(writer, sign(u.sk, { kind: 10002, content: "", created_at: now() - 10 }));
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey], kinds: [10002] }], false);
    const stale = sign(u.sk, { kind: 10002, content: "", created_at: now() - 50 });
    expect((await writer.publish(stale)).message).toStartWith("duplicate:");
    await reader.expectNone(isEventFor(s, stale.id), 200);
  });
});

describe("addressable events (30000-39999)", () => {
  test("same d tag replaces, different d tags coexist, #d filters", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    await publishOk(c, sign(u.sk, { kind: 30023, content: "a1", tags: [["d", "a"]], created_at: t }));
    const a2 = await publishOk(c, sign(u.sk, { kind: 30023, content: "a2", tags: [["d", "a"]], created_at: t + 1 }));
    const b1 = await publishOk(c, sign(u.sk, { kind: 30023, content: "b1", tags: [["d", "b"]], created_at: t }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [30023] }])).sort()).toEqual([a2.id, b1.id].sort());
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [30023], "#d": ["b"] }]))).toEqual([b1.id]);
    const stale = await c.publish(sign(u.sk, { kind: 30023, content: "a0", tags: [["d", "a"]], created_at: t - 1 }));
    expect(stale.ok).toBe(true);
    expect(stale.message).toStartWith("duplicate:");
  });

  test("the same d tag under another kind or author is a different address", async () => {
    const c = await cs.connect(relay.ws);
    const [a, b] = [newUser(), newUser()];
    const d = `d-${rand()}`;
    const x = await publishOk(c, sign(a.sk, { kind: 30000, tags: [["d", d]] }));
    const y = await publishOk(c, sign(a.sk, { kind: 30001, tags: [["d", d]] }));
    const z = await publishOk(c, sign(b.sk, { kind: 30000, tags: [["d", d]] }));
    expect(ids(await q(c, [{ "#d": [d] }])).sort()).toEqual([x.id, y.id, z.id].sort());
  });

  test("a missing d tag is the same address as an empty d tag", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    await publishOk(c, sign(u.sk, { kind: 30078, content: "no d", created_at: t }));
    const empty = await publishOk(c, sign(u.sk, { kind: 30078, content: "empty d", tags: [["d", ""]], created_at: t + 1 }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [30078] }]))).toEqual([empty.id]);
  });

  test("regular kinds (1, 1000-9999) are never replaced", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const a = await publishOk(c, sign(u.sk, { kind: 1063, tags: [["d", "x"]], created_at: now() - 5 }));
    const b = await publishOk(c, sign(u.sk, { kind: 1063, tags: [["d", "x"]] }));
    expect(ids(await q(c, [{ authors: [u.pubkey] }])).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("ephemeral events (20000-29999)", () => {
  test("delivered live to subscribers, accepted with OK true, never stored", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey] }], false);
    const ev = sign(u.sk, { kind: 20001, content: `typing ${rand()}` });
    expect(await writer.publish(ev)).toEqual({ ok: true, message: "" });
    await reader.waitFor(isEventFor(s, ev.id));
    expect(await q(writer, [{ ids: [ev.id] }])).toEqual([]);
    expect(await q(writer, [{ authors: [u.pubkey] }])).toEqual([]);
  });

  test("a replayed ephemeral event is answered duplicate: and not relayed again", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey] }], false);
    const ev = sign(u.sk, { kind: 29999, content: "once" });
    await publishOk(writer, ev);
    await reader.waitFor(isEventFor(s, ev.id));
    const r = await writer.publish(ev);
    expect(r.ok).toBe(true);
    expect(r.message).toStartWith("duplicate:");
    await reader.expectNone(isEventFor(s, ev.id), 200);
  });
});

describe("NIP-09 deletion", () => {
  test("kind 5 by the author removes the e-tagged event; the deletion itself is stored", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const target = await publishOk(c, sign(u.sk, { kind: 1, content: "to delete" }));
    const keep = await publishOk(c, sign(u.sk, { kind: 1, content: "to keep" }));
    const del = await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", target.id], ["k", "1"]], content: "oops" }));
    expect(await q(c, [{ ids: [target.id] }])).toEqual([]);
    expect(ids(await q(c, [{ ids: [keep.id, del.id] }])).sort()).toEqual([keep.id, del.id].sort());
  });

  test("a deleted event can't be re-published", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const target = await publishOk(c, sign(u.sk, { kind: 1, content: "gone" }));
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", target.id]] }));
    const r = await c.publish(target);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("blocked:");
    expect(await q(c, [{ ids: [target.id] }])).toEqual([]);
  });

  test("kind 5 by someone else does not delete", async () => {
    const c = await cs.connect(relay.ws);
    const [owner, other] = [newUser(), newUser()];
    const target = await publishOk(c, sign(owner.sk, { kind: 1, content: "mine" }));
    const r = await c.publish(sign(other.sk, { kind: 5, tags: [["e", target.id]] }));
    expect(r.ok).toBe(true);
    expect(ids(await q(c, [{ ids: [target.id] }]))).toEqual([target.id]);
  });

  test("a-tag deletion removes addressable versions up to its created_at; newer versions are accepted", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    const coord = `30023:${u.pubkey}:post`;
    await publishOk(c, sign(u.sk, { kind: 30023, content: "v1", tags: [["d", "post"]], created_at: t }));
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["a", coord]], created_at: t + 10 }));
    expect(await q(c, [{ authors: [u.pubkey], kinds: [30023] }])).toEqual([]);
    // a version from before the deletion stays deleted
    const older = await c.publish(sign(u.sk, { kind: 30023, content: "v-old", tags: [["d", "post"]], created_at: t + 5 }));
    expect(older.ok).toBe(false);
    expect(older.message).toStartWith("blocked:");
    const newer = await publishOk(c, sign(u.sk, { kind: 30023, content: "v2", tags: [["d", "post"]], created_at: t + 20 }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [30023] }]))).toEqual([newer.id]);
  });

  test("a-tag deletion works for replaceable kinds (kind:pubkey: with empty d)", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    await publishOk(c, sign(u.sk, { kind: 10002, content: "", created_at: t }));
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["a", `10002:${u.pubkey}:`]], created_at: t + 1 }));
    expect(await q(c, [{ authors: [u.pubkey], kinds: [10002] }])).toEqual([]);
  });

  test("a stranger's deletion of an id that arrives first doesn't block the real event", async () => {
    const c = await cs.connect(relay.ws);
    const [owner, other] = [newUser(), newUser()];
    const ev = sign(owner.sk, { kind: 1, content: `later ${rand()}` });
    await publishOk(c, sign(other.sk, { kind: 5, tags: [["e", ev.id]] }));
    await publishOk(c, ev);
    expect(ids(await q(c, [{ ids: [ev.id] }]))).toEqual([ev.id]);
  });

  test("a-tag deletion naming another author's coordinate has no effect", async () => {
    const c = await cs.connect(relay.ws);
    const [owner, other] = [newUser(), newUser()];
    const ev = await publishOk(c, sign(owner.sk, { kind: 30023, content: "safe", tags: [["d", "x"]] }));
    await c.publish(sign(other.sk, { kind: 5, tags: [["a", `30023:${owner.pubkey}:x`]] }));
    expect(ids(await q(c, [{ ids: [ev.id] }]))).toEqual([ev.id]);
  });

  test("a deletion request against a deletion request has no effect", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const target = await publishOk(c, sign(u.sk, { kind: 1, content: "x" }));
    const del = await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", target.id]] }));
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", del.id]] }));
    expect(ids(await q(c, [{ ids: [del.id] }]))).toEqual([del.id]);
    expect(await q(c, [{ ids: [target.id] }])).toEqual([]);
  });

  test("the deletion request is delivered live to subscribers of the author", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const target = await publishOk(writer, sign(u.sk, { kind: 1, content: "x" }));
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey], kinds: [5] }], false);
    const del = await publishOk(writer, sign(u.sk, { kind: 5, tags: [["e", target.id]] }));
    await reader.waitFor(isEventFor(s, del.id));
  });
});

describe("NIP-40 expiration", () => {
  test("an already-expired event is rejected with invalid:", async () => {
    const c = await cs.connect(relay.ws);
    const r = await c.publish(sign(newUser().sk, { kind: 1, content: "late", tags: [["expiration", String(now() - 10)]] }));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
  });

  test("an event with a future expiration is served until it expires, then no longer returned", async () => {
    const c = await cs.connect(relay.ws);
    const exp = now() + 2;
    const ev = await publishOk(c, sign(newUser().sk, { kind: 1, content: "short-lived", tags: [["expiration", String(exp)]] }));
    expect(ids(await q(c, [{ ids: [ev.id] }]))).toEqual([ev.id]);
    // poll until the expiration second has passed (≤ ~3s)
    const deadline = Date.now() + 6000;
    while (now() <= exp && Date.now() < deadline) await Bun.sleep(100);
    expect(await q(c, [{ ids: [ev.id] }])).toEqual([]);
    expect(await q(c, [{ authors: [ev.pubkey] }])).toEqual([]);
    expect((await count(c, [{ ids: [ev.id] }]))[2]).toEqual({ count: 0 });
  });

  test("a malformed expiration tag is ignored", async () => {
    const c = await cs.connect(relay.ws);
    const ev = await publishOk(c, sign(newUser().sk, { kind: 1, content: "odd exp", tags: [["expiration", "soon"]] }));
    expect(ids(await q(c, [{ ids: [ev.id] }]))).toEqual([ev.id]);
  });
});

describe("NIP-45 COUNT", () => {
  test("COUNT returns the number of matching events, with multiple filters OR'd", async () => {
    const c = await cs.connect(relay.ws);
    const [a, b] = [newUser(), newUser()];
    for (let i = 0; i < 3; i++) await publishOk(c, sign(a.sk, { kind: 1, content: `a${i}` }));
    await publishOk(c, sign(a.sk, { kind: 7, content: "+" }));
    for (let i = 0; i < 2; i++) await publishOk(c, sign(b.sk, { kind: 1, content: `b${i}` }));
    expect((await count(c, [{ authors: [a.pubkey], kinds: [1] }]))[2]).toEqual({ count: 3 });
    expect((await count(c, [{ authors: [a.pubkey] }]))[2]).toEqual({ count: 4 });
    expect((await count(c, [{ authors: [a.pubkey], kinds: [1] }, { authors: [b.pubkey] }]))[2]).toEqual({ count: 5 });
    expect((await count(c, [{ authors: [newUser().pubkey] }]))[2]).toEqual({ count: 0 });
  });

  test("COUNT ignores limit", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    for (let i = 0; i < 3; i++) await publishOk(c, sign(u.sk, { kind: 1, content: `c${i}` }));
    expect((await count(c, [{ authors: [u.pubkey], limit: 1 }]))[2]).toEqual({ count: 3 });
  });

  test("COUNT with an invalid filter is refused with CLOSED invalid:", async () => {
    const c = await cs.connect(relay.ws);
    const m = await count(c, [{ ids: ["nothex"] }]);
    expect(m[0]).toBe("CLOSED");
    expect(m[2] as string).toStartWith("invalid:");
  });

  test("COUNT of DMs (kind 4) without AUTH is refused with auth-required:", async () => {
    const c = await cs.connect(relay.ws);
    const m = await count(c, [{ kinds: [4] }]);
    expect(m[0]).toBe("CLOSED");
    expect(m[2] as string).toStartWith("auth-required:");
  });
});

describe("NIP-04 read gating", () => {
  test("REQ that can only match DMs is refused with auth-required: when unauthenticated", async () => {
    const c = await cs.connect(relay.ws);
    const s = sub();
    c.send(["REQ", s, { kinds: [4] }]);
    const m = await c.waitFor(isClosed(s));
    expect(m[2] as string).toStartWith("auth-required:");
  });
});

describe("NIP-50 search", () => {
  test("NIP-50 is advertised", async () => {
    const info = await (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json();
    expect(info.supported_nips).toContain(50);
  });

  test("search matches content words case-insensitively and excludes non-matches", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const word = `zq${rand(5)}`;
    const hit = await publishOk(c, sign(u.sk, { kind: 1, content: `Something about ${word.toUpperCase()} here` }));
    await publishOk(c, sign(u.sk, { kind: 1, content: "nothing relevant" }));
    expect(ids(await q(c, [{ search: word, authors: [u.pubkey] }]))).toEqual([hit.id]);
  });

  test("all search terms must match", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const [w1, w2] = [`ya${rand(5)}`, `yb${rand(5)}`];
    const both = await publishOk(c, sign(u.sk, { kind: 1, content: `${w1} and ${w2}` }));
    await publishOk(c, sign(u.sk, { kind: 1, content: `only ${w1}` }));
    expect(ids(await q(c, [{ search: `${w1} ${w2}` }]))).toEqual([both.id]);
  });

  test("live search subscription delivers only matching events", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const word = `xl${rand(5)}`;
    const s = sub();
    await reader.query(s, [{ search: word, authors: [u.pubkey] }], false);
    const miss = await publishOk(writer, sign(u.sk, { kind: 1, content: "unrelated" }));
    const hit = await publishOk(writer, sign(u.sk, { kind: 1, content: `live ${word}` }));
    await reader.waitFor(isEventFor(s, hit.id));
    await reader.expectNone(isEventFor(s, miss.id), 150);
  });

  test("a search query over 256 chars is refused with CLOSED invalid:", async () => {
    const c = await cs.connect(relay.ws);
    const s = sub();
    c.send(["REQ", s, { search: "a".repeat(257) }]);
    const m = await c.waitFor(isClosed(s));
    expect(m[2] as string).toStartWith("invalid:");
  });
});
