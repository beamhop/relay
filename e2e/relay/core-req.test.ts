/** NIP-01 REQ / EOSE / CLOSE / CLOSED: filter semantics, ordering, live delivery. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import type { Relay } from "../harness/relay";
import { newUser, type RelayClient } from "../harness/client";
import { clients, ids, isClosed, isEose, isEventFor, isNotice, now, publishOk, rand, sendRaw, sign, startCoreRelay } from "./core-helpers";

let relay: Relay;
const cs = clients();
beforeAll(async () => {
  relay = await startCoreRelay();
});
afterEach(() => cs.closeAll());
afterAll(() => relay?.stop());

/** Publishes `n` kind-1 events by one fresh author at distinct, decreasing timestamps (newest first in the result). */
async function seed(c: RelayClient, n: number, extra: (i: number) => Partial<Event> = () => ({})) {
  const u = newUser();
  const t0 = now() - 1000;
  const evs: Event[] = [];
  for (let i = 0; i < n; i++) evs.push(await publishOk(c, sign(u.sk, { kind: 1, content: `seed ${i} ${rand()}`, created_at: t0 + i, ...extra(i) })));
  return { u, evs, t0 };
}
const sub = () => `sub-${rand(4)}`;

describe("filter fields", () => {
  test("ids matches exactly the listed events", async () => {
    const c = await cs.connect(relay.ws);
    const { evs } = await seed(c, 3);
    const { events } = await c.query(sub(), [{ ids: [evs[0].id, evs[2].id] }]);
    expect(ids(events).sort()).toEqual([evs[0].id, evs[2].id].sort());
  });

  test("authors matches only that author's events", async () => {
    const c = await cs.connect(relay.ws);
    const a = await seed(c, 2);
    await seed(c, 2);
    const { events } = await c.query(sub(), [{ authors: [a.u.pubkey] }]);
    expect(ids(events).sort()).toEqual(ids(a.evs).sort());
  });

  test("kinds restricts to the listed kinds", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const k1 = await publishOk(c, sign(u.sk, { kind: 1, content: "k1" }));
    const k7 = await publishOk(c, sign(u.sk, { kind: 7, content: "+" }));
    await publishOk(c, sign(u.sk, { kind: 1111, content: "k1111" }));
    const { events } = await c.query(sub(), [{ authors: [u.pubkey], kinds: [1, 7] }]);
    expect(ids(events).sort()).toEqual([k1.id, k7.id].sort());
  });

  test("#e, #p and #t tag filters match on the first tag value", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const target = rand(32);
    const p = newUser().pubkey;
    const t = `topic-${rand()}`;
    const withE = await publishOk(c, sign(u.sk, { kind: 1, content: "e", tags: [["e", target]] }));
    const withP = await publishOk(c, sign(u.sk, { kind: 1, content: "p", tags: [["p", p]] }));
    const withT = await publishOk(c, sign(u.sk, { kind: 1, content: "t", tags: [["t", t]] }));
    // a value in a later position of the tag does not match
    await publishOk(c, sign(u.sk, { kind: 1, content: "t2", tags: [["t", "other", t]] }));
    expect(ids((await c.query(sub(), [{ "#e": [target] }])).events)).toEqual([withE.id]);
    expect(ids((await c.query(sub(), [{ "#p": [p] }])).events)).toEqual([withP.id]);
    expect(ids((await c.query(sub(), [{ "#t": [t] }])).events)).toEqual([withT.id]);
  });

  test("values within one tag filter are OR'd; different tag filters are AND'd", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const [x, y, z] = [`x-${rand()}`, `y-${rand()}`, `z-${rand()}`];
    const ex = await publishOk(c, sign(u.sk, { kind: 1, content: "x", tags: [["t", x]] }));
    const ey = await publishOk(c, sign(u.sk, { kind: 1, content: "y", tags: [["t", y]] }));
    const exz = await publishOk(c, sign(u.sk, { kind: 1, content: "xz", tags: [["t", x], ["r", z]] }));
    expect(ids((await c.query(sub(), [{ "#t": [x, y] }])).events).sort()).toEqual([ex.id, ey.id, exz.id].sort());
    expect(ids((await c.query(sub(), [{ "#t": [x], "#r": [z] }])).events)).toEqual([exz.id]);
  });

  test("tag filters on uppercase single-letter tags work too", async () => {
    const c = await cs.connect(relay.ws);
    const v = `K-${rand()}`;
    const ev = await publishOk(c, sign(newUser().sk, { kind: 1, content: "upper", tags: [["K", v]] }));
    expect(ids((await c.query(sub(), [{ "#K": [v] }])).events)).toEqual([ev.id]);
    expect((await c.query(sub(), [{ "#k": [v] }])).events).toEqual([]);
  });

  test("since and until are inclusive", async () => {
    const c = await cs.connect(relay.ws);
    const { u, evs, t0 } = await seed(c, 3);
    const a = [u.pubkey];
    expect(ids((await c.query(sub(), [{ authors: a, since: t0 + 1 }])).events)).toEqual([evs[2].id, evs[1].id]);
    expect(ids((await c.query(sub(), [{ authors: a, until: t0 + 1 }])).events)).toEqual([evs[1].id, evs[0].id]);
    expect(ids((await c.query(sub(), [{ authors: a, since: t0 + 1, until: t0 + 1 }])).events)).toEqual([evs[1].id]);
    expect((await c.query(sub(), [{ authors: a, since: t0 + 2, until: t0 + 1 }])).events).toEqual([]);
  });

  test("results are newest first and limit keeps the newest", async () => {
    const c = await cs.connect(relay.ws);
    const { u, evs } = await seed(c, 6);
    const all = (await c.query(sub(), [{ authors: [u.pubkey] }])).events;
    expect(ids(all)).toEqual(ids([...evs].reverse()));
    const top = (await c.query(sub(), [{ authors: [u.pubkey], limit: 2 }])).events;
    expect(ids(top)).toEqual([evs[5].id, evs[4].id]);
  });

  test("events with the same created_at are ordered by lowest id first", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 50;
    const evs: Event[] = [];
    for (let i = 0; i < 5; i++) evs.push(await publishOk(c, sign(u.sk, { kind: 1, content: `tie ${i}`, created_at: t })));
    const got = (await c.query(sub(), [{ authors: [u.pubkey] }])).events;
    expect(ids(got)).toEqual(ids(evs).sort());
    // and limit keeps the lowest ids
    expect(ids((await c.query(sub(), [{ authors: [u.pubkey], limit: 2 }])).events)).toEqual(ids(evs).sort().slice(0, 2));
  });

  test("multiple filters are OR'd and an event matching several is sent once", async () => {
    const c = await cs.connect(relay.ws);
    const a = await seed(c, 2);
    const b = await seed(c, 2);
    const { events } = await c.query(sub(), [{ authors: [a.u.pubkey] }, { ids: [b.evs[0].id] }, { ids: [a.evs[0].id] }]);
    expect(ids(events).sort()).toEqual([...ids(a.evs), b.evs[0].id].sort());
  });

  test("each filter's limit applies separately", async () => {
    const c = await cs.connect(relay.ws);
    const a = await seed(c, 3);
    const b = await seed(c, 3);
    const { events } = await c.query(sub(), [
      { authors: [a.u.pubkey], limit: 1 },
      { authors: [b.u.pubkey], limit: 2 },
    ]);
    expect(ids(events).sort()).toEqual([a.evs[2].id, b.evs[2].id, b.evs[1].id].sort());
  });

  test("limit: 0 returns EOSE with no stored events but still delivers live ones", async () => {
    const c = await cs.connect(relay.ws);
    const { u } = await seed(c, 2);
    const s = sub();
    const { events } = await c.query(s, [{ authors: [u.pubkey], limit: 0 }], false);
    expect(events).toEqual([]);
    const live = await publishOk(c, sign(u.sk, { kind: 1, content: "live after limit 0" }));
    await c.waitFor(isEventFor(s, live.id));
  });

  test("empty filter {} matches any event", async () => {
    const c = await cs.connect(relay.ws);
    await seed(c, 1);
    const { events } = await c.query(sub(), [{ limit: 1 }]);
    expect(events).toHaveLength(1);
  });

  test("filter that matches nothing yields just EOSE", async () => {
    const c = await cs.connect(relay.ws);
    const { events, closed } = await c.query(sub(), [{ authors: [newUser().pubkey] }]);
    expect(events).toEqual([]);
    expect(closed).toBeUndefined();
  });
});

describe("invalid REQs → CLOSED invalid:", () => {
  const bad: [string, unknown[]][] = [
    ["no filters", []],
    ["id prefix (prefix matching is not supported)", [{ ids: ["abcdef"] }]],
    ["author prefix", [{ authors: ["abcd"] }]],
    ["uppercase hex author", [{ authors: ["A".repeat(64)] }]],
    ["unknown filter key", [{ foo: [1] }]],
    ["multi-letter tag key", [{ "#tt": ["x"] }]],
    ["negative limit", [{ limit: -1 }]],
    ["fractional since", [{ since: 1.5 }]],
    ["kinds of strings", [{ kinds: ["1"] }]],
    ["tag values not strings", [{ "#t": [1] }]],
    ["filter not an object", ["kinds"]],
  ];
  for (const [name, filters] of bad) {
    test(name, async () => {
      const c = await cs.connect(relay.ws);
      const s = sub();
      c.send(["REQ", s, ...filters]);
      const m = await c.waitFor(isClosed(s));
      expect(m[2] as string).toStartWith("invalid:");
      expect(c.inbox.some(isEose(s))).toBe(false);
    });
  }

  test("sub id longer than max_subid_length (64) is refused with CLOSED; exactly 64 works", async () => {
    const c = await cs.connect(relay.ws);
    const long = "x".repeat(65);
    c.send(["REQ", long, { limit: 0 }]);
    const m = await c.waitFor(isClosed(long));
    expect(m[2] as string).toStartWith("invalid:");
    const ok = "y".repeat(64);
    c.send(["REQ", ok, { limit: 0 }]);
    await c.waitFor(isEose(ok));
  });

  test("empty sub id is refused with a NOTICE", async () => {
    const c = await cs.connect(relay.ws);
    sendRaw(c, JSON.stringify(["REQ", "", { limit: 0 }]));
    const m = await c.waitFor(isNotice);
    expect(m[1] as string).toStartWith("invalid:");
  });

  test("non-string sub id is refused with a NOTICE", async () => {
    const c = await cs.connect(relay.ws);
    sendRaw(c, JSON.stringify(["REQ", 7, { limit: 0 }]));
    const m = await c.waitFor(isNotice);
    expect(m[1] as string).toStartWith("invalid:");
  });
});

describe("live subscriptions", () => {
  test("matching events published after EOSE are delivered live; non-matching ones are not", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const t = `live-${rand()}`;
    const s = sub();
    await reader.query(s, [{ "#t": [t] }], false);
    const hit = await publishOk(writer, sign(u.sk, { kind: 1, content: "hit", tags: [["t", t]] }));
    const miss = await publishOk(writer, sign(u.sk, { kind: 1, content: "miss", tags: [["t", `${t}-no`]] }));
    const m = await reader.waitFor(isEventFor(s, hit.id));
    expect((m[2] as Event).id).toBe(hit.id);
    await reader.expectNone(isEventFor(s, miss.id), 200);
  });

  test("live delivery honours since/until and kinds", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    const t = now();
    await reader.query(s, [{ authors: [u.pubkey], kinds: [1], since: t - 100, until: t + 100 }], false);
    const tooOld = await publishOk(writer, sign(u.sk, { kind: 1, content: "old", created_at: t - 500 }));
    const wrongKind = await publishOk(writer, sign(u.sk, { kind: 7, content: "+" }));
    const good = await publishOk(writer, sign(u.sk, { kind: 1, content: "in range" }));
    await reader.waitFor(isEventFor(s, good.id));
    await reader.expectNone((m) => isEventFor(s, tooOld.id)(m) || isEventFor(s, wrongKind.id)(m), 200);
  });

  test("CLOSE stops live delivery", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey] }], false);
    const first = await publishOk(writer, sign(u.sk, { kind: 1, content: "before close" }));
    await reader.waitFor(isEventFor(s, first.id));
    reader.send(["CLOSE", s]);
    // a round trip on the same connection guarantees the CLOSE was processed
    await reader.query(sub(), [{ limit: 0 }]);
    const second = await publishOk(writer, sign(u.sk, { kind: 1, content: "after close" }));
    await reader.expectNone(isEventFor(s), 250);
    expect(second.id).toBeTruthy();
  });

  test("CLOSE of an unknown subscription is silently ignored", async () => {
    const c = await cs.connect(relay.ws);
    c.send(["CLOSE", "never-opened"]);
    await c.query(sub(), [{ limit: 0 }]);
    expect(c.inbox.filter((m) => m[0] === "NOTICE" || m[0] === "CLOSED")).toEqual([]);
  });

  test("REQ with an existing sub id replaces the old subscription", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const a = newUser();
    const b = newUser();
    const s = sub();
    await reader.query(s, [{ authors: [a.pubkey] }], false);
    await reader.query(s, [{ authors: [b.pubkey] }], false);
    const fromA = await publishOk(writer, sign(a.sk, { kind: 1, content: "a" }));
    const fromB = await publishOk(writer, sign(b.sk, { kind: 1, content: "b" }));
    await reader.waitFor(isEventFor(s, fromB.id));
    await reader.expectNone(isEventFor(s, fromA.id), 200);
  });

  test("an event matching several filters of one subscription is delivered once", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const t = `once-${rand()}`;
    const s = sub();
    await reader.query(s, [{ authors: [u.pubkey] }, { "#t": [t] }, { kinds: [1], authors: [u.pubkey] }], false);
    const ev = await publishOk(writer, sign(u.sk, { kind: 1, content: "once", tags: [["t", t]] }));
    await reader.waitFor(isEventFor(s, ev.id));
    await reader.expectNone(isEventFor(s, ev.id), 200);
  });

  test("two subscriptions on one connection each get the event under their own id", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const [s1, s2] = [sub(), sub()];
    await reader.query(s1, [{ authors: [u.pubkey] }], false);
    await reader.query(s2, [{ kinds: [1], authors: [u.pubkey] }], false);
    const ev = await publishOk(writer, sign(u.sk, { kind: 1, content: "both" }));
    await reader.waitFor(isEventFor(s1, ev.id));
    await reader.waitFor(isEventFor(s2, ev.id));
  });

  test("the publisher's own connection receives its event live", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    await c.query(s, [{ authors: [u.pubkey] }], false);
    const ev = await publishOk(c, sign(u.sk, { kind: 1, content: "echo" }));
    await c.waitFor(isEventFor(s, ev.id));
  });

  test("rejected and duplicate events are not delivered live", async () => {
    const reader = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    const stored = await publishOk(writer, sign(u.sk, { kind: 1, content: "stored first" }));
    expect(ids((await reader.query(s, [{ authors: [u.pubkey] }], false)).events)).toEqual([stored.id]);
    expect((await writer.publish(stored)).message).toStartWith("duplicate:");
    const bad = { ...sign(u.sk, { kind: 1, content: "x" }), content: "tampered" };
    expect((await writer.publish(bad)).ok).toBe(false);
    await reader.expectNone(isEventFor(s), 250);
  });

  test("subscriptions are dropped when the connection closes (no cross-connection leak)", async () => {
    const r1 = await cs.connect(relay.ws);
    const r2 = await cs.connect(relay.ws);
    const writer = await cs.connect(relay.ws);
    const u = newUser();
    await r1.query("shared-id", [{ authors: [u.pubkey] }], false);
    await r2.query("shared-id", [{ authors: [u.pubkey] }], false);
    r1.close();
    const ev = await publishOk(writer, sign(u.sk, { kind: 1, content: "after r1 left" }));
    await r2.waitFor(isEventFor("shared-id", ev.id));
  });
});
