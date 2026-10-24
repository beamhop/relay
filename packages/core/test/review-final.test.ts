import { describe, expect, setSystemTime, test } from "bun:test";
import type { Filter, NostrEvent } from "@beamhop/sdk";
import { Negentropy, NegentropyStorage } from "../src";
import { BACKPRESSURE, MAX_NEG_ITEMS, MESSAGES_PER_MINUTE } from "../src/protocol/handlers";
import { ReadLimits, SEARCH_ESTIMATE_MS } from "../src/protocol/read-limits";
import { RateLimiter } from "../src/util/rate-limit";
import { createRelay } from "../src/relay";
import { REPORTERS_KV_NAMESPACE } from "../src/pipeline/special-kinds";
import { eventually, FakeSocket, keypair, setup, sign, tick } from "./fakes";

const h = (id: string, extra: string[][] = []) => [["h", id], ...extra];
const initNeg = () => {
  const s = new NegentropyStorage();
  s.seal();
  return new Negentropy(s, 0).initiate();
};

describe("searches waiting their turn don't stall other reads", () => {
  test("a plain REQ isn't queued behind a backlog of searches", async () => {
    const { connect, stores } = await setup();
    const orig = stores.events.query.bind(stores.events);
    stores.events.query = async (filters: Filter[], opts?: { maxLimit?: number }) => {
      if (filters.some((f) => f.search)) {
        const t0 = Date.now();
        while (Date.now() - t0 < 60) {} // a synchronous full-text query blocks the loop
      }
      return orig(filters, opts);
    };
    for (let ip = 0; ip < 7; ip++) {
      const c = connect(`10.0.0.${ip + 1}`);
      for (let i = 0; i < 3; i++) c.send(["REQ", `s${i}`, { search: "hello world", limit: 10 }]);
    }
    await tick(1);
    const victim = connect("20.0.0.1");
    const t0 = Date.now();
    await victim.req("plain", { kinds: [1], limit: 1 });
    // before: ~20 searches (1.2 s) ran first, each holding a relay-wide query slot while waiting
    expect(Date.now() - t0).toBeLessThan(300);
  }, 20_000);

  test("the search-time estimate charged at admission follows observed query times, within bounds", () => {
    const r = new ReadLimits();
    expect(r.searchEstimateMs).toBe(SEARCH_ESTIMATE_MS.initial);
    for (let i = 0; i < 50; i++) r.recordSearchMs(400);
    expect(r.searchEstimateMs).toBeGreaterThan(350);
    for (let i = 0; i < 50; i++) r.recordSearchMs(100_000);
    expect(r.searchEstimateMs).toBe(SEARCH_ESTIMATE_MS.max);
    for (let i = 0; i < 100; i++) r.recordSearchMs(0);
    expect(r.searchEstimateMs).toBe(SEARCH_ESTIMATE_MS.min);
  });

  test("prepaid search time that wasn't used is refunded, overruns are charged", () => {
    const rl = new RateLimiter(() => 0);
    expect(rl.take("k", 3000, 1000, 1500)).toBe(true); // prepaid estimate
    rl.refund("k", 3000, 900, 1500); // the query took 100 ms
    expect(rl.take("k", 3000, 1400, 1500)).toBe(true);
    rl.charge("k", 3000, 500, 1500); // overrun: into debt
    expect(rl.take("k", 3000, 0, 1500)).toBe(false);
    rl.refund("k", 3000, 10_000, 1500);
    expect(rl.take("k", 3000, 1500, 1500)).toBe(true); // refunds never exceed the capacity
    expect(rl.take("k", 3000, 1, 1500)).toBe(false);
  });

  test("searches from one address are refused once it has too many at once", async () => {
    const { connect } = await setup();
    const conns = Array.from({ length: 6 }, () => connect("10.1.1.1"));
    for (const c of conns) for (let i = 0; i < 3; i++) c.send(["REQ", `s${i}`, { search: "x y", limit: 1 }]);
    await tick(50);
    const closed = conns.flatMap((c) => c.socket.of("CLOSED")).filter((m) => String(m[2]).startsWith("rate-limited: too many searches"));
    expect(closed.length).toBe(18 - 10);
  });
});

describe("negentropy sessions", () => {
  test("idle expired sessions don't keep the relay-wide item budget", async () => {
    const { connect, stores } = await setup();
    const big = Array.from({ length: MAX_NEG_ITEMS }, (_, i) => ({ id: i.toString(16).padStart(64, "0"), created_at: 1_700_000_000 + i }));
    stores.events.queryIdsForSync = async (f: Filter) => (f.kinds?.[0] === 30000 ? big : big.slice(0, 10));
    for (let c = 0; c < 2; c++) {
      const conn = connect(`5.5.5.${c + 1}`);
      for (let s = 0; s < 2; s++) {
        conn.send(["NEG-OPEN", `big${s}`, { kinds: [30000] }, initNeg()]);
        const r = await conn.socket.waitFor((m) => (m[0] === "NEG-MSG" || m[0] === "NEG-ERR") && m[1] === `big${s}`, 60_000);
        expect(r[0]).toBe("NEG-MSG");
      }
    }
    setSystemTime(new Date(Date.now() + 10 * 60_000));
    try {
      const victim = connect("6.6.6.6");
      victim.send(["NEG-OPEN", "v", { kinds: [1] }, initNeg()]);
      const r = await victim.socket.waitFor((m) => (m[0] === "NEG-MSG" || m[0] === "NEG-ERR") && m[1] === "v");
      expect(r[0]).toBe("NEG-MSG");
    } finally {
      setSystemTime();
    }
  }, 120_000);

  test("NEG-ERR from the message limiter ends the session", async () => {
    const { connect } = await setup();
    const c = connect();
    c.send(["NEG-OPEN", "n", { kinds: [1] }, initNeg()]);
    await c.socket.waitFor((m) => m[0] === "NEG-MSG" && m[1] === "n");
    for (let i = 0; i < MESSAGES_PER_MINUTE + 5; i++) c.send(["NEG-MSG", "x", "61"]);
    c.send(["NEG-MSG", "n", "61"]); // over the limit: NEG-ERR, and the session is gone
    await tick(5);
    expect(c.socket.of("NEG-ERR").some((m) => m[1] === "n" && String(m[2]).startsWith("rate-limited:"))).toBe(true);
  });

  test("one address prepares two syncs at a time; a third waits for a slot", async () => {
    const { connect, stores } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stores.events.queryIdsForSync = async () => {
      await gate;
      return [];
    };
    const a = connect("7.7.7.7");
    const b = connect("7.7.7.7");
    a.send(["NEG-OPEN", "a1", { kinds: [1] }, initNeg()]);
    a.send(["NEG-OPEN", "a2", { kinds: [1] }, initNeg()]);
    await tick(5);
    b.send(["NEG-OPEN", "b", { kinds: [1] }, initNeg()]);
    await tick(100);
    expect(b.socket.sent.some((m) => m[0] === "NEG-ERR" || m[0] === "NEG-MSG")).toBe(false); // waiting
    release();
    await b.socket.waitFor((m) => m[0] === "NEG-MSG" && m[1] === "b");
    await a.socket.waitFor((m) => m[0] === "NEG-MSG" && m[1] === "a2");
  });
});

describe("NIP-29 control events", () => {
  test("a control event whose save failed applies when retried", async () => {
    const { connect, stores, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g") }));
    const add = sign(admin, { kind: 9000, tags: h("g", [["p", bob.pk]]) });
    const save = stores.events.save.bind(stores.events);
    let fail = true;
    stores.events.save = async (e: NostrEvent) => {
      if (fail && e.id === add.id) {
        fail = false;
        throw new Error("SQLITE_BUSY");
      }
      return save(e);
    };
    expect((await c.publish(add))[2]).toBe(false);
    const retry = await c.publish(add);
    expect(retry[2]).toBe(true);
    expect(retry[3]).toBe("");
    expect((await relay.groups.get("g"))?.memberList.some((m) => m.pubkey === bob.pk)).toBe(true);
    expect(stores.events.events.has(add.id)).toBe(true);
  });

  test("a control event that failed to apply isn't left stored", async () => {
    const { connect, stores, relay } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("club", [["closed"]]) }));
    await c.publish(sign(admin, { kind: 9009, tags: h("club", [["code", "good-code"]]) }));
    const a = keypair();
    const b = keypair();
    const ja = sign(a, { kind: 9021, tags: h("club", [["code", "good-code"]]) });
    const jb = sign(b, { kind: 9021, tags: h("club", [["code", "good-code"]]) });
    const [ra, rb] = await Promise.all([connect("2.2.2.2").publish(ja), connect("3.3.3.3").publish(jb)]);
    const loser = ra[2] ? jb : ja;
    expect([ra[2], rb[2]].sort()).toEqual([false, true]);
    expect(stores.events.events.has(loser.id)).toBe(false);
    expect((await relay.groups.get("club"))?.members).toBe(2);
  });

  test("a replayed control event removed by a 9005 doesn't apply twice", async () => {
    const { connect, stores, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g") }));
    const add = sign(admin, { kind: 9000, tags: h("g", [["p", bob.pk]]) });
    await c.publish(add);
    await c.publish(sign(admin, { kind: 9001, tags: h("g", [["p", bob.pk]]) }));
    await c.publish(sign(admin, { kind: 9005, tags: h("g", [["e", add.id]]) }));
    expect(stores.events.events.has(add.id)).toBe(false);
    const r = await connect("9.9.9.9").publish(add);
    expect(r[2]).toBe(true);
    expect(r[3]).toMatch(/^duplicate:/);
    expect((await relay.groups.get("g"))?.memberList.some((m) => m.pubkey === bob.pk)).toBe(false);
    expect(stores.events.events.has(add.id)).toBe(false);
  });

  test("an open group ignores an unknown invite code", async () => {
    const { connect, relay } = await setup();
    const admin = keypair();
    await connect().publish(sign(admin, { kind: 9007, tags: h("open") }));
    const u = keypair();
    const r = await connect("4.4.4.4").publish(sign(u, { kind: 9021, tags: h("open", [["code", "expired-code"]]) }));
    expect(r[2]).toBe(true);
    expect((await relay.groups.get("open"))?.memberList.some((m) => m.pubkey === u.pk)).toBe(true);
  });

  test("failed invite-code attempts are limited, valid ones are not counted", async () => {
    const { connect } = await setup();
    const admin = keypair();
    const c = connect();
    await c.publish(sign(admin, { kind: 9007, tags: h("club", [["closed"]]) }));
    for (let i = 0; i < 3; i++) await c.publish(sign(admin, { kind: 9009, tags: h("club", [["code", `code-${i}-ok`]]) }));
    // valid joins don't use up the group's allowance
    for (let i = 0; i < 3; i++) expect((await connect(`8.8.8.${i}`).publish(sign(keypair(), { kind: 9021, tags: h("club", [["code", `code-${i}-ok`]]) })))[2]).toBe(true);
    // an address guessing is cut off after its failures
    const guesser = connect("6.6.6.6");
    const results: string[] = [];
    for (let i = 0; i < 12; i++) results.push((await guesser.publish(sign(keypair(), { kind: 9021, tags: h("club", [["code", `guess-${i}`]]) })))[3]);
    expect(results.slice(0, 10).every((m) => m.startsWith("restricted: join request pending admin approval"))).toBe(true);
    expect(results.at(-1)).toMatch(/^rate-limited:/);
  });

  test("with groups disabled, events with several h tags are accepted", async () => {
    const { connect } = await setup({ settings: { groups: { enabled: false } } });
    const r = await connect().publish(sign(keypair(), { kind: 1, tags: [["h", "a"], ["h", "b"]] }));
    expect(r[2]).toBe(true);
  });
});

describe("misc", () => {
  test("an empty REQ result leaves no per-address byte entry", () => {
    const r = new ReadLimits();
    for (let i = 0; i < 100; i++) expect(r.reserve(`4:${i.toString(16)}`, 0, 0)).toBe(true);
    expect(r.resultBytesByIp.size).toBe(0);
  });

  test("AUTH is answered even if the user lookup fails", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    stores.users.get = async () => {
      throw new Error("db down");
    };
    const ok = await c.auth(keypair());
    expect(ok[2]).toBe(false);
    expect(ok[3]).toMatch(/^error:/);
  });

  test("stored results keep the send buffer below half the live-delivery limit", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    await c.publish(sign(kp, { content: "a" }));
    c.socket.buffered = Math.floor(BACKPRESSURE.highWater * 1.5); // above the pacing mark, below the live-drop limit
    const from = c.socket.sent.length;
    c.send(["REQ", "bp", { authors: [kp.pk] }]);
    await tick(60);
    expect(c.socket.sent.slice(from).some((m) => m[1] === "bp")).toBe(false);
    c.socket.buffered = 0;
    await c.socket.waitFor((m) => m[0] === "EOSE" && m[1] === "bp", 2000, from);
  });
});

describe("inbound limits and connection caps", () => {
  test("allow-listed addresses are exempt from the inbound message limit", async () => {
    const { deps, stores } = await setup();
    await stores.ipRules.add({ cidr: "10.5.0.0/16", action: "allow", reason: "bridge" });
    const relay = await createRelay(deps);
    const s = new FakeSocket();
    const handle = relay.handleConnection(s, { ip: "10.5.1.1" });
    for (let i = 0; i < MESSAGES_PER_MINUTE + 5; i++) handle.onMessage(JSON.stringify(["NEG-MSG", "x", "61"]));
    await tick(5);
    expect(s.of("NEG-ERR").some((m) => String(m[2]).startsWith("rate-limited: too many messages"))).toBe(false);
  });

  test("users with a rate-limit override get their own message limit", async () => {
    const { connect, stores } = await setup();
    const kp = keypair();
    await stores.users.upsert(kp.pk, { rateLimit: { eventsPerMinute: 5000 } });
    const c = connect();
    await c.auth(kp);
    await tick(5); // limits follow the user record, looked up after the OK
    for (let i = 0; i < MESSAGES_PER_MINUTE + 5; i++) c.send(["NEG-MSG", "x", "61"]);
    await tick(5);
    expect(c.socket.of("NEG-ERR").some((m) => String(m[2]).startsWith("rate-limited: too many messages"))).toBe(false);
  });

  test("IPv6: the connection cap is per address, with a larger cap per /64", async () => {
    const { connect } = await setup({ settings: { limits: { connectionsPerIp: 2 } } });
    const closed = (ip: string) => connect(ip).socket.closed !== null;
    expect(closed("2001:db8::1")).toBe(false);
    expect(closed("2001:db8::1")).toBe(false);
    expect(closed("2001:db8::1")).toBe(true); // per address
    for (let i = 2; i <= 4; i++) expect(closed(`2001:db8::${i}`)).toBe(false);
    for (let i = 5; i <= 8; i++) closed(`2001:db8::${i}`);
    expect(closed("2001:db8::99")).toBe(true); // 4 × 2 per /64
    expect(closed("2001:db8:0:1::1")).toBe(false); // another /64
  });
});

describe("NIP-56 auto-ban", () => {
  test("member reports seen before tracking count (seeded once from stored reports)", async () => {
    const { connect, stores } = await setup({ settings: { moderation: { autoBanReportThreshold: 2 } } });
    const target = keypair();
    const m1 = keypair();
    const m2 = keypair();
    await stores.users.upsert(m1.pk, { allowed: true });
    await stores.users.upsert(m2.pk, { allowed: true });
    // m1's report predates tracking (stored directly)
    const old = sign(m1, { kind: 1984, tags: [["p", target.pk, "spam"]] });
    stores.events.events.set(old.id, old);
    expect(await stores.kv.get(REPORTERS_KV_NAMESPACE, target.pk)).toBeUndefined();
    await connect().publish(sign(m2, { kind: 1984, tags: [["p", target.pk, "spam"]] }));
    await eventually(async () => (await stores.users.get(target.pk))?.status === "banned");
  });

  test("reports from non-members return without lookups", async () => {
    const { connect, stores } = await setup({ settings: { moderation: { autoBanReportThreshold: 2 } } });
    const target = keypair();
    // count the auto-ban's report lookups (kind 1984 queries); the publishes themselves don't query reports
    let reportQueries = 0;
    const query = stores.events.query.bind(stores.events);
    stores.events.query = async (filters: Filter[], opts?: { maxLimit?: number }) => {
      if (filters.some((f) => f.kinds?.includes(1984))) reportQueries++;
      return query(filters, opts);
    };
    for (let i = 0; i < 5; i++) await connect(`10.0.1.${i}`).publish(sign(keypair(), { kind: 1984, tags: [["p", target.pk, "spam"]] }));
    await tick(20);
    expect(reportQueries).toBe(0);
    expect(await stores.kv.get(REPORTERS_KV_NAMESPACE, target.pk)).toBeUndefined();
  });
});
