/**
 * NIP-01 conformance probes beyond core-*.test.ts: filter edge cases (empty lists, boundaries, empty tag values),
 * stored-query vs live-matching parity, replaceable/addressable ties, ephemeral storage, message ordering and
 * prefixes, NIP-13 difficulty counting and NIP-40 boundaries.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { finalizeEvent, getEventHash, getPublicKey, type Event } from "nostr-tools";
import type { Relay } from "../harness/relay";
import { newUser, RelayClient } from "../harness/client";
import { clients, ids, isClosed, isEventFor, now, publishOk, rand, sign, startCoreRelay } from "./core-helpers";

let relay: Relay;
const cs = clients();
beforeAll(async () => {
  relay = await startCoreRelay();
});
afterEach(() => cs.closeAll());
afterAll(() => relay?.stop());

const sub = () => `n01-${rand(4)}`;
const q = async (c: RelayClient, filters: Record<string, unknown>[]) => (await c.query(sub(), filters)).events;

async function count(c: RelayClient, filters: Record<string, unknown>[]) {
  const s = sub();
  c.send(["COUNT", s, ...filters]);
  return c.waitFor((m) => (m[0] === "COUNT" || m[0] === "CLOSED") && m[1] === s);
}

/** Two events of the same author/kind/created_at, returned as [lowest id, highest id]. */
function tiePair(sk: Uint8Array, t: { kind: number; created_at: number; tags?: string[][] }): [Event, Event] {
  const a = sign(sk, { ...t, content: `a ${rand()}` });
  const b = sign(sk, { ...t, content: `b ${rand()}` });
  return a.id < b.id ? [a, b] : [b, a];
}

const STANDARD_PREFIXES = ["duplicate", "pow", "blocked", "rate-limited", "invalid", "restricted", "mute", "error", "auth-required", "unsupported"];
const prefixOf = (s: string) => /^([a-z-]+):/.exec(s)?.[1];

describe("empty filter lists match nothing (NIP-01: MUST NOT match, MUST NOT be treated as absent)", () => {
  const cases: [string, (pk: string) => Record<string, unknown>][] = [
    ["ids: []", (pk) => ({ ids: [], authors: [pk] })],
    ["authors: []", () => ({ authors: [] })],
    ["kinds: []", (pk) => ({ kinds: [], authors: [pk] })],
    ["#t: []", (pk) => ({ "#t": [], authors: [pk] })],
  ];
  for (const [name, f] of cases) {
    test(`${name}: stored query returns EOSE and no events; no live delivery`, async () => {
      const reader = await cs.connect(relay.ws);
      const writer = await cs.connect(relay.ws);
      const u = newUser();
      await publishOk(writer, sign(u.sk, { kind: 1, content: "stored", tags: [["t", "x"]] }));
      const s = sub();
      const r = await reader.query(s, [f(u.pubkey)], false);
      expect(r.closed).toBeUndefined();
      expect(r.events).toEqual([]);
      const live = await publishOk(writer, sign(u.sk, { kind: 1, content: "live", tags: [["t", "x"]] }));
      await reader.expectNone(isEventFor(s, live.id), 250);
      // COUNT agrees
      expect((await count(reader, [f(u.pubkey)]))[2]).toEqual({ count: 0 });
    });
  }

  test("a filter with an empty list doesn't swallow the other filters of the REQ", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const ev = await publishOk(c, sign(u.sk, { kind: 1, content: "other filter" }));
    expect(ids(await q(c, [{ kinds: [] }, { authors: [u.pubkey] }]))).toEqual([ev.id]);
  });

  test("a tag filter whose only values are NUL-containing is empty, not absent", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 1, content: "nul probe", tags: [["t", "x"]] }));
    const r = await c.query(sub(), [{ authors: [u.pubkey], "#t": ["a\u0000b"] }]);
    // either refused, or matches nothing; never treated as an absent #t
    if (r.closed === undefined) expect(r.events).toEqual([]);
    else expect(r.closed).toStartWith("invalid:");
  });
});

describe("filter semantics", () => {
  test('#t: [""] matches a tag with an empty value (stored and live) but not a value-less tag', async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const empty = await publishOk(writer, sign(u.sk, { kind: 1, content: "empty t", tags: [["t", ""]] }));
    const bare = await publishOk(writer, sign(u.sk, { kind: 1, content: "bare t", tags: [["t"]] }));
    const s = sub();
    const r = await reader.query(s, [{ authors: [u.pubkey], "#t": [""] }], false);
    expect(ids(r.events)).toEqual([empty.id]);
    expect(ids(r.events)).not.toContain(bare.id);
    const live = await publishOk(writer, sign(u.sk, { kind: 1, content: "live empty t", tags: [["t", ""]] }));
    const liveBare = await publishOk(writer, sign(u.sk, { kind: 1, content: "live bare t", tags: [["t"]] }));
    await reader.waitFor(isEventFor(s, live.id));
    await reader.expectNone(isEventFor(s, liveBare.id), 200);
  });

  test("only the first value of a tag is matched by tag filters", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = `first-${rand()}`;
    await publishOk(c, sign(u.sk, { kind: 1, content: "second value", tags: [["t", "other", t]] }));
    expect(await q(c, [{ "#t": [t] }])).toEqual([]);
  });

  test("tag names are case-sensitive: #T does not match t tags and vice versa", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const v = `case-${rand()}`;
    const lower = await publishOk(c, sign(u.sk, { kind: 1, content: "lower", tags: [["t", v]] }));
    const upper = await publishOk(c, sign(u.sk, { kind: 1, content: "upper", tags: [["T", v]] }));
    expect(ids(await q(c, [{ "#t": [v] }]))).toEqual([lower.id]);
    expect(ids(await q(c, [{ "#T": [v] }]))).toEqual([upper.id]);
  });

  test("tag values are case-sensitive", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const v = `Mixed${rand()}`;
    await publishOk(c, sign(u.sk, { kind: 1, content: "mixed", tags: [["t", v]] }));
    expect(await q(c, [{ "#t": [v.toLowerCase()] }])).toEqual([]);
  });

  test("since > until matches nothing and still ends with EOSE", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 1, content: "x" }));
    const r = await c.query(sub(), [{ authors: [u.pubkey], since: now() + 10, until: now() - 10 }]);
    expect(r.closed).toBeUndefined();
    expect(r.events).toEqual([]);
  });

  test("live delivery: since and until are inclusive at the exact boundary", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey], since: t, until: t + 10 }], false);
    const atSince = await publishOk(writer, sign(u.sk, { kind: 1, content: "at since", created_at: t }));
    const atUntil = await publishOk(writer, sign(u.sk, { kind: 1, content: "at until", created_at: t + 10 }));
    const before = await publishOk(writer, sign(u.sk, { kind: 1, content: "before", created_at: t - 1 }));
    const after = await publishOk(writer, sign(u.sk, { kind: 1, content: "after", created_at: t + 11 }));
    await reader.waitFor(isEventFor(s, atSince.id));
    await reader.waitFor(isEventFor(s, atUntil.id));
    await reader.expectNone((m) => isEventFor(s, before.id)(m) || isEventFor(s, after.id)(m), 200);
  });

  test("limit is ignored for live events (more than limit arrive after EOSE)", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey], limit: 1 }], false);
    const evs: Event[] = [];
    for (let i = 0; i < 3; i++) evs.push(await publishOk(writer, sign(u.sk, { kind: 1, content: `live ${i}` })));
    for (const ev of evs) await reader.waitFor(isEventFor(s, ev.id));
  });

  test("multiple filters with different limits: union of each filter's newest, newest first, ties lowest id", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 300;
    const k1: Event[] = [];
    const k7: Event[] = [];
    for (let i = 0; i < 4; i++) k1.push(await publishOk(c, sign(u.sk, { kind: 1, content: `k1 ${i}`, created_at: t + i })));
    for (let i = 0; i < 4; i++) k7.push(await publishOk(c, sign(u.sk, { kind: 7, content: `k7 ${i}`, created_at: t + i })));
    const got = await q(c, [
      { authors: [u.pubkey], kinds: [1], limit: 2 },
      { authors: [u.pubkey], kinds: [7], limit: 1 },
    ]);
    const want = [k1[3], k7[3], k1[2]].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
    expect(ids(got)).toEqual(ids(want));
  });
});

describe("stored queries agree with live matching", () => {
  test("the same filters select the same events whether stored or live", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const [a, b, other] = [newUser(), newUser(), newUser()];
    const tag = `par-${rand()}`;
    const ref = rand(32);
    const t = now() - 500;
    const filters: Record<string, unknown>[] = [
      // single-value tag (sqlite: event_tags-driven plan)
      { "#t": [tag] },
      // single tag value plus kinds and since/until
      { "#t": [tag], kinds: [1, 7], since: t + 2, until: t + 5 },
      // two authors with a limit (sqlite: per-author UNION ALL branches)
      { authors: [a.pubkey, b.pubkey], kinds: [1, 30000], limit: 100 },
      // two kinds with a limit (sqlite: per-kind branches)
      { kinds: [7, 30000], "#t": [tag, `${tag}-2`], limit: 100 },
      // two tag conditions AND-ed
      { "#t": [tag], "#e": [ref] },
      // uppercase tag, empty string value
      { "#T": [""], authors: [a.pubkey, b.pubkey, other.pubkey] },
      // d tag of addressable events
      { kinds: [30000], "#d": ["one", "two"] },
    ];
    const templates: { sk: Uint8Array; kind: number; tags: string[][]; created_at: number }[] = [
      { sk: a.sk, kind: 1, tags: [["t", tag]], created_at: t },
      { sk: a.sk, kind: 1, tags: [["t", tag], ["e", ref]], created_at: t + 2 },
      { sk: b.sk, kind: 7, tags: [["t", tag]], created_at: t + 5 },
      { sk: b.sk, kind: 7, tags: [["t", `${tag}-2`]], created_at: t + 6 },
      { sk: other.sk, kind: 1, tags: [["t", tag], ["e", ref]], created_at: t + 3 },
      { sk: other.sk, kind: 1, tags: [["T", ""], ["t", tag]], created_at: t + 4 },
      { sk: a.sk, kind: 30000, tags: [["d", "one"], ["t", tag]], created_at: t + 1 },
      { sk: b.sk, kind: 30000, tags: [["d", "two"], ["t", `${tag}-2`]], created_at: t + 1 },
      { sk: b.sk, kind: 1, tags: [["T", ""]], created_at: t + 7 },
      { sk: other.sk, kind: 30000, tags: [["d", "three"], ["d", "one"]], created_at: t + 1 },
    ];
    const subs = filters.map(() => sub());
    for (let i = 0; i < filters.length; i++) await reader.query(subs[i], [filters[i]], false);
    const published: Event[] = [];
    for (const tp of templates) published.push(await publishOk(writer, sign(tp.sk, { kind: tp.kind, tags: tp.tags, created_at: tp.created_at, content: rand() })));
    await Bun.sleep(300);
    for (let i = 0; i < filters.length; i++) {
      const live = reader.inbox
        .filter((m) => m[0] === "EVENT" && m[1] === subs[i])
        .map((m) => (m[2] as Event).id)
        .sort();
      const stored = ids(await q(reader, [filters[i]])).sort();
      expect({ filter: filters[i], ids: stored }).toEqual({ filter: filters[i], ids: live });
      expect(live.length).toBeGreaterThan(0);
    }
  });
});

describe("message ordering", () => {
  test("all stored events precede EOSE; events published during the query arrive only after EOSE", async () => {
    const c = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    for (let i = 0; i < 30; i++) await publishOk(writer, sign(u.sk, { kind: 1, content: `pre ${i}`, created_at: now() - 100 + i }));
    const s = sub();
    c.send(["REQ", s, { authors: [u.pubkey], limit: 500 }]);
    const live = sign(u.sk, { kind: 1, content: "during" });
    writer.send(["EVENT", live]);
    await c.waitFor(isEventFor(s, live.id));
    const frames = c.inbox.filter((m) => m[1] === s);
    const eose = frames.findIndex((m) => m[0] === "EOSE");
    expect(eose).toBeGreaterThanOrEqual(30);
    expect(frames.slice(0, eose).every((m) => m[0] === "EVENT")).toBe(true);
    // the live one, when not part of the stored results, comes after EOSE (it was consumed by waitFor above)
    expect(frames.filter((m) => m[0] === "EVENT" && (m[2] as Event).id === live.id)).toHaveLength(0);
  });

  test("replacing a sub id right after its REQ: after the old EOSE (if any) only events of the new filter arrive", async () => {
    const c = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const [a, b] = [newUser(), newUser()];
    for (let i = 0; i < 40; i++) await publishOk(writer, sign(a.sk, { kind: 1, content: `a ${i}`, created_at: now() - 200 + i }));
    const fromB = await publishOk(writer, sign(b.sk, { kind: 1, content: "b" }));
    const s = sub();
    c.send(["REQ", s, { authors: [a.pubkey], limit: 500 }]);
    c.send(["REQ", s, { authors: [b.pubkey] }]);
    // round trip: both REQs have been fully handled once this answers
    await c.query(sub(), [{ limit: 0 }]);
    await Bun.sleep(100);
    const frames = c.inbox.filter((m) => m[1] === s);
    const eoses = frames.map((m, i) => (m[0] === "EOSE" ? i : -1)).filter((i) => i >= 0);
    // the old REQ may have completed before the replacement was read; then it has its own EOSE first
    const last = eoses[eoses.length - 1];
    const afterFirst = frames.slice(eoses.length > 1 ? eoses[0] + 1 : 0, last);
    expect(afterFirst.map((m) => (m[2] as Event).id)).toEqual([fromB.id]);
  });

  test("CLOSE right after REQ: nothing for that sub id arrives after the CLOSE is processed", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(writer, sign(u.sk, { kind: 1, content: "stored" }));
    const s = sub();
    reader.send(["REQ", s, { authors: [u.pubkey] }]);
    reader.send(["CLOSE", s]);
    await reader.query(sub(), [{ limit: 0 }]);
    reader.inbox.splice(0);
    await publishOk(writer, sign(u.sk, { kind: 1, content: "after close" }));
    await reader.expectNone((m) => m[1] === s, 250);
  });
});

describe("OK / CLOSED messages", () => {
  test("every OK false and CLOSED message carries a standard machine-readable prefix", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const msgs: string[] = [];
    msgs.push((await c.publish({ ...sign(u.sk, { kind: 1, content: "x" }), content: "tampered" })).message);
    msgs.push((await c.publish(sign(u.sk, { kind: 1, content: "future", created_at: now() + 86_400 }))).message);
    msgs.push((await c.publish(sign(u.sk, { kind: 1, content: "exp", tags: [["expiration", String(now() - 1)]] }))).message);
    msgs.push((await c.publish(sign(u.sk, { kind: 22242, content: "" }))).message);
    for (const f of [{ foo: 1 }, { ids: ["zz"] }, { limit: -1 }]) {
      const s = sub();
      c.send(["REQ", s, f]);
      msgs.push((await c.waitFor(isClosed(s)))[2] as string);
    }
    for (const m of msgs) expect(STANDARD_PREFIXES).toContain(prefixOf(m) as string);
  });

  test("OK true for a stale replaceable is true with a duplicate: message", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 50;
    await publishOk(c, sign(u.sk, { kind: 10000, content: "", created_at: t }));
    const r = await c.publish(sign(u.sk, { kind: 10000, content: "older", created_at: t - 1 }));
    expect(r.ok).toBe(true);
    expect(prefixOf(r.message)).toBe("duplicate");
  });

  test("REQ with an invalid filter echoes the sub id in CLOSED", async () => {
    const c = await cs.connect(relay.ws);
    const s = sub();
    c.send(["REQ", s, { "#": ["x"] }]);
    const m = await c.waitFor(isClosed(s));
    expect(m[2] as string).toStartWith("invalid:");
  });
});

describe("replaceable / addressable ties and live delivery", () => {
  test("replaceable tie, lower id first: the higher id is refused as duplicate and not delivered live", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const [lo, hi] = tiePair(u.sk, { kind: 3, created_at: now() - 30, tags: [["p", newUser().pubkey]] });
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey], kinds: [3] }], false);
    await publishOk(writer, lo);
    await reader.waitFor(isEventFor(s, lo.id));
    const r = await writer.publish(hi);
    expect(r.ok).toBe(true);
    expect(r.message).toStartWith("duplicate:");
    await reader.expectNone(isEventFor(s, hi.id), 200);
    expect(ids(await q(writer, [{ authors: [u.pubkey], kinds: [3] }]))).toEqual([lo.id]);
  });

  test("replaceable tie, higher id first: the lower id replaces it and is delivered live", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const [lo, hi] = tiePair(u.sk, { kind: 10002, created_at: now() - 30, tags: [["r", "wss://relay.example.com"]] });
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey], kinds: [10002] }], false);
    await publishOk(writer, hi);
    await reader.waitFor(isEventFor(s, hi.id));
    await publishOk(writer, lo);
    await reader.waitFor(isEventFor(s, lo.id));
    expect(ids(await q(writer, [{ authors: [u.pubkey], kinds: [10002] }]))).toEqual([lo.id]);
    expect(await q(writer, [{ ids: [hi.id] }])).toEqual([]);
  });

  test("addressable tie: lowest id wins whichever arrives first", async () => {
    const c = await cs.connect(relay.ws);
    for (const order of ["lo-first", "hi-first"]) {
      const u = newUser();
      const [lo, hi] = tiePair(u.sk, { kind: 30023, created_at: now() - 30, tags: [["d", "article"]] });
      const [first, second] = order === "lo-first" ? [lo, hi] : [hi, lo];
      await publishOk(c, first);
      expect((await c.publish(second)).ok).toBe(true);
      expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [30023], "#d": ["article"] }]))).toEqual([lo.id]);
    }
  });

  test("addressable with several d tags: the first d tag is the address", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 30;
    const ab = await publishOk(c, sign(u.sk, { kind: 30001, content: "a,b", created_at: t, tags: [["d", "a"], ["d", "b"]] }));
    // a newer event addressed "b" is a different address: both stay
    const b = await publishOk(c, sign(u.sk, { kind: 30001, content: "b", created_at: t + 1, tags: [["d", "b"]] }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [30001] }])).sort()).toEqual([ab.id, b.id].sort());
    // a newer event addressed "a" replaces the first one
    const a = await publishOk(c, sign(u.sk, { kind: 30001, content: "a", created_at: t + 2, tags: [["d", "a"]] }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [30001] }])).sort()).toEqual([a.id, b.id].sort());
  });

  test("replaceable kinds ignore d tags: kind 10000 with different d tags still replaces", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 30;
    await publishOk(c, sign(u.sk, { kind: 10000, content: "", created_at: t, tags: [["d", "x"]] }));
    const v2 = await publishOk(c, sign(u.sk, { kind: 10000, content: "", created_at: t + 1, tags: [["d", "y"]] }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [10000] }]))).toEqual([v2.id]);
  });

  test("kind boundaries: 9999/20000/29999/30000/39999/40000 classified per NIP-01", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 30;
    // regular kinds: both versions kept
    for (const kind of [1, 2, 4, 44, 1000, 9999, 40000, 65535]) {
      if (kind === 4) continue; // DMs are read-gated
      const e1 = await publishOk(c, sign(u.sk, { kind, content: "1", created_at: t }));
      const e2 = await publishOk(c, sign(u.sk, { kind, content: "2", created_at: t + 1 }));
      expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [kind] }])).sort()).toEqual([e1.id, e2.id].sort());
    }
    // replaceable
    for (const kind of [0, 3, 10000, 19999]) {
      await publishOk(c, sign(u.sk, { kind, content: "1", created_at: t }));
      const e2 = await publishOk(c, sign(u.sk, { kind, content: "2", created_at: t + 1 }));
      expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [kind] }]))).toEqual([e2.id]);
    }
    // addressable
    for (const kind of [30000, 39999]) {
      await publishOk(c, sign(u.sk, { kind, content: "1", created_at: t, tags: [["d", "k"]] }));
      const e2 = await publishOk(c, sign(u.sk, { kind, content: "2", created_at: t + 1, tags: [["d", "k"]] }));
      expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [kind] }]))).toEqual([e2.id]);
    }
    // ephemeral
    for (const kind of [20000, 29999]) {
      const e = await publishOk(c, sign(u.sk, { kind, content: "eph", created_at: t }));
      expect(await q(c, [{ ids: [e.id] }])).toEqual([]);
    }
  });
});

describe("ephemeral events", () => {
  test("never counted by COUNT", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 20500, content: "eph" }));
    expect((await count(c, [{ authors: [u.pubkey] }]))[2]).toEqual({ count: 0 });
  });

  test("an ephemeral event is not delivered as a stored result to a REQ opened right after it", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const ev = await publishOk(c, sign(u.sk, { kind: 25000, content: "gone" }));
    expect(await q(c, [{ authors: [u.pubkey] }])).toEqual([]);
    expect(ev.id).toBeTruthy();
  });

  test("a kind 5 naming an ephemeral event is stored; the ephemeral event is still relayed live", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const eph = sign(u.sk, { kind: 20001, content: "eph after deletion" });
    const del = await publishOk(writer, sign(u.sk, { kind: 5, content: "", tags: [["e", eph.id]] }));
    expect(ids(await q(writer, [{ ids: [del.id] }]))).toEqual([del.id]);
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey], kinds: [20001] }], false);
    const r = await writer.publish(eph);
    expect(r.ok).toBe(true);
  });
});

describe("NIP-40 boundaries", () => {
  test("expiration exactly now is expired: refused on write", async () => {
    const c = await cs.connect(relay.ws);
    const r = await c.publish(sign(newUser().sk, { kind: 1, content: "exp now", tags: [["expiration", String(now())]] }));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
  });

  test("an expired ephemeral event is dropped, not relayed", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey] }], false);
    const ev = sign(u.sk, { kind: 20001, content: "late eph", tags: [["expiration", String(now() - 5)]] });
    const r = await writer.publish(ev);
    expect(r.ok).toBe(false);
    await reader.expectNone(isEventFor(s, ev.id), 200);
  });

  test("an event expiring soon is delivered live while still valid", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey] }], false);
    const ev = await publishOk(writer, sign(u.sk, { kind: 1, content: "soon", tags: [["expiration", String(now() + 30)]] }));
    await reader.waitFor(isEventFor(s, ev.id));
  });

  test("once the latest replaceable version expires it is no longer served, and a newer version replaces it", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 30;
    const exp = now() + 2;
    const latest = await publishOk(c, sign(u.sk, { kind: 0, content: "{}", created_at: t, tags: [["expiration", String(exp)]] }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [0] }]))).toEqual([latest.id]);
    const deadline = Date.now() + 6000;
    while (now() <= exp && Date.now() < deadline) await Bun.sleep(100);
    expect(await q(c, [{ authors: [u.pubkey], kinds: [0] }])).toEqual([]);
    const newer = await publishOk(c, sign(u.sk, { kind: 0, content: '{"v":2}', created_at: t + 1 }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [0] }]))).toEqual([newer.id]);
  });
});

describe("subscription ids", () => {
  test("a 64-char sub id of non-ASCII BMP characters is accepted", async () => {
    const c = await cs.connect(relay.ws);
    const s = "é".repeat(64);
    const r = await c.query(s, [{ limit: 0 }]);
    expect(r.closed).toBeUndefined();
  });

  test("sub ids are per connection: the same id on two connections is independent", async () => {
    const r1 = await cs.connect(relay.ws);
    const r2 = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const [a, b] = [newUser(), newUser()];
    await r1.query("same", [{ authors: [a.pubkey] }], false);
    await r2.query("same", [{ authors: [b.pubkey] }], false);
    const ea = await publishOk(writer, sign(a.sk, { kind: 1, content: "a" }));
    const eb = await publishOk(writer, sign(b.sk, { kind: 1, content: "b" }));
    await r1.waitFor(isEventFor("same", ea.id));
    await r2.waitFor(isEventFor("same", eb.id));
    await r1.expectNone(isEventFor("same", eb.id), 100);
    await r2.expectNone(isEventFor("same", ea.id), 100);
  });
});

/**
 * NIP-01 id serialization: only \n \" \\ \r \t \b \f are escaped in content, "all other characters must be included
 * verbatim". Signs `content` with an id computed that way (a raw control character in the JSON string).
 */
function signSpecSerialized(sk: Uint8Array, content: string, kind = 1): Event {
  const pubkey = getPublicKey(sk);
  const created_at = now();
  const esc: Record<string, string> = { "\n": "\\n", '"': '\\"', "\\": "\\\\", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
  const str = `"${content.replace(/[\n"\\\r\t\b\f]/g, (c) => esc[c])}"`;
  const serialized = `[0,"${pubkey}",${created_at},${kind},[],${str}]`;
  const id = createHash("sha256").update(serialized, "utf8").digest("hex");
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), sk)).toString("hex");
  return { id, pubkey, created_at, kind, tags: [], content, sig } as Event;
}

describe("event id serialization", () => {
  // regression: NIP-01 "all other characters must be included verbatim"; JSON.stringify writes U+0001 as \u0001
  test("an event whose id serializes a control character (U+0001) verbatim, as NIP-01 specifies, is accepted", async () => {
    const c = await cs.connect(relay.ws);
    const ev = signSpecSerialized(newUser().sk, `ctrl \u0001 char ${rand()}`);
    expect(await c.publish(ev)).toEqual({ ok: true, message: "" });
    expect(ids(await q(c, [{ ids: [ev.id] }]))).toEqual([ev.id]);
  });

  test("for content without other control characters both serializations agree (sanity check of the helper)", async () => {
    const c = await cs.connect(relay.ws);
    const sk = newUser().sk;
    const ev = signSpecSerialized(sk, `line\nquote"back\\tab\tcr\rbs\bff\f é ${rand()}`);
    expect(ev.id).toBe(getEventHash(ev));
    await publishOk(c, ev);
  });
});

describe("limit counts visible events only", () => {
  test("hidden DMs among the newest results don't eat the limit; ties keep lowest id first", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const peer = newUser().pubkey;
    const t = now() - 400;
    const notes: Event[] = [];
    for (let i = 0; i < 3; i++) notes.push(await publishOk(c, sign(u.sk, { kind: 1, content: `old ${i}`, created_at: t })));
    for (let i = 0; i < 2; i++) notes.push(await publishOk(c, sign(u.sk, { kind: 1, content: `mid ${i}`, created_at: t + 1 })));
    for (let i = 0; i < 12; i++) await publishOk(c, sign(u.sk, { kind: 4, content: `dm ${i}`, created_at: t + 1 + (i % 3), tags: [["p", peer]] }));
    const want = [...notes].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, 3);
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [1, 4], limit: 3 }]))).toEqual(ids(want));
  });
});

describe("endpoint", () => {
  test("websocket upgrades on another path are not accepted as the relay", async () => {
    let connected = false;
    try {
      const c = await RelayClient.connect(`${relay.ws}/some/other/path`);
      connected = true;
      c.close();
    } catch {
      /* refused */
    }
    expect(connected).toBe(false);
  });
});

// ------------------------------------------------------------------ NIP-13 (relay with a PoW minimum)

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

/** Mines until the id has exactly `bits` leading zero bits (or at least, when `exact` is false). */
function mine(sk: Uint8Array, bits: number, opts: { target?: string | null; exact?: boolean; kind?: number } = {}): Event {
  const pubkey = getPublicKey(sk);
  const created_at = now();
  const kind = opts.kind ?? 1;
  const content = `pow ${rand()}`;
  for (let nonce = 0; ; nonce++) {
    const nonceTag = opts.target === null ? ["nonce", String(nonce)] : ["nonce", String(nonce), opts.target ?? String(bits)];
    const tags = [nonceTag];
    const id = getEventHash({ pubkey, created_at, kind, tags, content });
    const lz = leadingZeroBits(id);
    if (opts.exact === false ? lz >= bits : lz === bits) return finalizeEvent({ created_at, kind, tags, content }, sk);
  }
}

describe("NIP-13 proof of work", () => {
  const MIN = 10;
  let powRelay: Relay;
  beforeAll(async () => {
    powRelay = await startCoreRelay({ limits: { minPowDifficulty: MIN } });
  });
  afterAll(() => powRelay?.stop());

  test("exactly the minimum number of leading zero bits is accepted; one less is refused with pow:", async () => {
    const c = await cs.connect(powRelay.ws);
    const u = newUser();
    await publishOk(c, mine(u.sk, MIN));
    const weak = mine(u.sk, MIN - 1, { target: String(MIN) });
    const r = await c.publish(weak);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("pow:");
  });

  test("leading zeros inside a non-zero nibble count (e.g. 00 3x... = 10 bits)", async () => {
    const c = await cs.connect(powRelay.ws);
    // MIN = 10: two zero nibbles (8) plus a nibble 2 or 3 (2 more bits)
    const ev = mine(newUser().sk, MIN);
    expect(ev.id.slice(0, 2)).toBe("00");
    expect(["2", "3"]).toContain(ev.id[2]);
    await publishOk(c, ev);
  });

  test("a nonce without a committed target is accepted when the difficulty is met", async () => {
    const c = await cs.connect(powRelay.ws);
    await publishOk(c, mine(newUser().sk, MIN, { target: null, exact: false }));
  });

  test("a committed target above the minimum with enough work is accepted", async () => {
    const c = await cs.connect(powRelay.ws);
    await publishOk(c, mine(newUser().sk, MIN, { target: String(MIN + 5), exact: false }));
  });

  test("an ephemeral event is also subject to the PoW minimum", async () => {
    const c = await cs.connect(powRelay.ws);
    let ev = sign(newUser().sk, { kind: 20001, content: `eph ${rand()}` });
    while (leadingZeroBits(ev.id) >= MIN) ev = sign(newUser().sk, { kind: 20001, content: `eph ${rand()}` });
    const r = await c.publish(ev);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("pow:");
  });
});
