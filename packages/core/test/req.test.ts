import { describe, expect, test } from "bun:test";
import type { BusEvents, NostrEvent } from "@beamhop/sdk";
import { Negentropy, NegentropyStorage } from "../src";
import { keypair, now, setup, sign, tick } from "./fakes";

describe("REQ", () => {
  test("stored results, EOSE, live delivery, CLOSE", async () => {
    const { connect, bus } = await setup();
    const executed: BusEvents["req.executed"][] = [];
    bus.on("req.executed", (e) => executed.push(e));
    const writer = connect();
    const reader = connect();
    const kp = keypair();
    const old1 = sign(kp, { content: "a", created_at: now() - 20 });
    const old2 = sign(kp, { content: "b", created_at: now() - 10 });
    await writer.publish(old1);
    await writer.publish(old2);
    await writer.publish(sign(kp, { kind: 7 }));
    const { end, events } = await reader.req("s1", { kinds: [1], authors: [kp.pk] });
    expect(end[0]).toBe("EOSE");
    expect(events.map((e) => e.id)).toEqual([old2.id, old1.id]);
    expect(executed[0]?.durationMs).toBeGreaterThanOrEqual(0);

    const live = sign(kp, { content: "live" });
    await writer.publish(live);
    await reader.socket.waitFor((m) => m[0] === "EVENT" && m[1] === "s1" && (m[2] as NostrEvent).id === live.id);
    expect(writer.socket.of("EVENT").length).toBe(0);

    reader.send(["CLOSE", "s1"]);
    await tick();
    const before = reader.socket.of("EVENT").length;
    await writer.publish(sign(kp, { content: "after close" }));
    await tick();
    expect(reader.socket.of("EVENT").length).toBe(before);
  });

  test("tag filters, limit and maxLimit clamp, replacing a subscription", async () => {
    const { connect } = await setup({ settings: { limits: { maxLimit: 2 } } });
    const c = connect();
    const kp = keypair();
    for (let i = 0; i < 4; i++) await c.publish(sign(kp, { content: `${i}`, tags: [["t", "nostr"]], created_at: now() - i }));
    await c.publish(sign(kp, { tags: [["t", "other"]] }));
    expect((await c.req("t", { "#t": ["nostr"] })).events.length).toBe(2);
    expect((await c.req("t", { "#t": ["nostr"], limit: 1 })).events.length).toBe(1);
    expect((await c.req("t", { "#t": ["other"] })).events.length).toBe(1);
  });

  test("strict validation and subscription limits", async () => {
    const { connect } = await setup({ settings: { limits: { maxSubscriptions: 1, maxFilters: 1 } } });
    const c = connect();
    expect((await c.req("bad", { authors: ["nothex"] })).end).toEqual(expect.arrayContaining(["CLOSED", "bad"]));
    expect(((await c.req("bad2", { bogus: 1 } as never)).end[2] as string)).toMatch(/^invalid:/);
    expect(((await c.req("two", {}, {})).end[2] as string)).toMatch(/^invalid: too many filters/);
    await c.req("one", { kinds: [1] });
    expect(((await c.req("second", { kinds: [1] })).end[2] as string)).toMatch(/^rate-limited: too many subscriptions/);
    expect((await c.req("one", { kinds: [2] })).end[0]).toBe("EOSE"); // replacing an existing sub is fine
  });

  test("a refused REQ replaces (closes) the existing subscription with the same id", async () => {
    const { connect } = await setup();
    const writer = connect();
    const reader = connect();
    const kp = keypair();
    await reader.req("s", { kinds: [1] });
    reader.send(["REQ", "s", { kinds: [1059] }]);
    expect(((await reader.socket.waitFor((m) => m[0] === "CLOSED" && m[1] === "s"))[2] as string)).toMatch(/^auth-required:/);
    await writer.publish(sign(kp));
    await tick();
    expect(reader.socket.of("EVENT").length).toBe(0);
  });

  test("too-long subscription ids are refused with CLOSED", async () => {
    const { connect } = await setup();
    const c = connect();
    const id = "x".repeat(100);
    c.send(["REQ", id, {}]);
    expect(((await c.socket.waitFor((m) => m[0] === "CLOSED" && m[1] === id))[2] as string)).toMatch(/^invalid: subscription id/);
  });

  test("authForRead requires AUTH", async () => {
    const { connect } = await setup({ settings: { access: { authForRead: true } } });
    const c = connect();
    expect(((await c.req("x", {})).end[2] as string)).toMatch(/^auth-required:/);
    await c.auth(keypair());
    expect((await c.req("x", {})).end[0]).toBe("EOSE");
  });

  test("auth-required mode gates reads", async () => {
    const { connect } = await setup({ settings: { access: { mode: "auth-required" } } });
    const c = connect();
    expect(((await c.req("x", {})).end[2] as string)).toMatch(/^auth-required:/);
    c.send(["COUNT", "c", {}]);
    expect(((await c.socket.waitFor((m) => m[0] === "CLOSED" && m[1] === "c"))[2] as string)).toMatch(/^auth-required:/);
    await c.auth(keypair());
    expect((await c.req("y", {})).end[0]).toBe("EOSE");
  });

  test("REQ rate limiting", async () => {
    const { connect } = await setup({ settings: { limits: { reqPerMinute: 2 } } });
    const c = connect();
    await c.req("a", {});
    await c.req("b", {});
    expect(((await c.req("c", {})).end[2] as string)).toMatch(/^rate-limited:/);
  });

  test("query hooks and visibility hooks", async () => {
    const { connect, hooks } = await setup();
    const c = connect();
    const kp = keypair();
    const secret = sign(kp, { content: "secret" });
    await c.publish(secret);
    await c.publish(sign(kp, { content: "public" }));
    hooks.onVisibility((e) => e.content !== "secret", "test");
    hooks.onQuery((f) => (f[0]?.kinds?.includes(666) ? { reject: "nope" } : f.map((x) => ({ ...x, kinds: [1] }))), "test");
    const { events } = await c.req("v", { kinds: [9999] });
    expect(events.map((e) => e.content)).toEqual(["public"]);
    expect((await c.req("r", { kinds: [666] })).end[2]).toMatch(/nope/);
  });

  test("backpressure: slow consumers are dropped", async () => {
    const { connect } = await setup();
    const w = connect();
    const r = connect();
    await r.req("s", {});
    r.socket.buffered = 64 * 1024 * 1024;
    await w.publish(sign(keypair()));
    await tick();
    expect(r.socket.closed).not.toBeNull();
  });
});

describe("NIP-42 AUTH", () => {
  test("valid auth, wrong challenge, wrong relay, stale", async () => {
    const { connect, bus } = await setup();
    const authed: unknown[] = [];
    bus.on("connection.auth", (e) => authed.push(e));
    const c = connect();
    expect(c.challenge.length).toBeGreaterThan(8);
    const kp = keypair();
    expect((await c.auth(kp, "wss://elsewhere.example.com"))[3]).toMatch(/^invalid:/);
    const wrongChallenge = sign(kp, { kind: 22242, tags: [["relay", "wss://relay.example.com"], ["challenge", "nope"]] });
    c.send(["AUTH", wrongChallenge]);
    expect((await c.socket.waitFor((m) => m[0] === "OK" && m[1] === wrongChallenge.id))[2]).toBe(false);
    const stale = sign(kp, { kind: 22242, created_at: now() - 700, tags: [["relay", "wss://relay.example.com"], ["challenge", c.challenge]] });
    c.send(["AUTH", stale]);
    expect((await c.socket.waitFor((m) => m[0] === "OK" && m[1] === stale.id))[2]).toBe(false);
    expect(await c.auth(kp)).toEqual(["OK", expect.any(String), true, ""]);
    expect(authed.length).toBe(1);
    // scheme-insensitive relay url match
    const c2 = connect();
    expect((await c2.auth(kp, "ws://relay.example.com/"))[2]).toBe(true);
  });
});

describe("gift wrap / DM privacy", () => {
  test("stored and live delivery only to authed recipients", async () => {
    const { connect } = await setup();
    const alice = keypair();
    const bob = keypair();
    const eve = keypair();
    const w = connect();
    const wrap = sign(keypair(), { kind: 1059, tags: [["p", bob.pk]] });
    await w.publish(wrap);
    const note = sign(alice);
    await w.publish(note);

    const anon = connect();
    expect(((await anon.req("g", { kinds: [1059] })).end[2] as string)).toMatch(/^auth-required:/);
    const mixed = await anon.req("m", { kinds: [1, 1059] });
    expect(mixed.events.map((e) => e.id)).toEqual([note.id]);

    const eveConn = connect();
    await eveConn.auth(eve);
    expect((await eveConn.req("g", { kinds: [1059], "#p": [bob.pk] })).events.length).toBe(0);

    const bobConn = connect();
    await bobConn.auth(bob);
    expect((await bobConn.req("g", { kinds: [1059], "#p": [bob.pk] })).events.map((e) => e.id)).toEqual([wrap.id]);

    const live = sign(keypair(), { kind: 1059, tags: [["p", bob.pk]] });
    await w.publish(live);
    await bobConn.socket.waitFor((m) => m[0] === "EVENT" && (m[2] as NostrEvent).id === live.id);
    await tick();
    expect(eveConn.socket.of("EVENT").length).toBe(0);
    expect(anon.socket.of("EVENT").filter((m) => (m[2] as NostrEvent).kind === 1059).length).toBe(0);
  });

  test("ephemeral gift wraps (21059) are only delivered to authed recipients", async () => {
    const { connect } = await setup();
    const bob = keypair();
    const w = connect();
    const anon = connect();
    await anon.req("a", { kinds: [1, 21059] });
    const bobConn = connect();
    await bobConn.auth(bob);
    await bobConn.req("b", { kinds: [21059], "#p": [bob.pk] });
    const wrap = sign(keypair(), { kind: 21059, tags: [["p", bob.pk]] });
    await w.publish(wrap);
    await bobConn.socket.waitFor((m) => m[0] === "EVENT" && (m[2] as NostrEvent).id === wrap.id);
    await tick();
    expect(anon.socket.of("EVENT").length).toBe(0);
  });

  test("kind 4 visible to author and recipient", async () => {
    const { connect } = await setup();
    const alice = keypair();
    const bob = keypair();
    const w = connect();
    const dm = sign(alice, { kind: 4, tags: [["p", bob.pk]] });
    await w.publish(dm);
    const a = connect();
    await a.auth(alice);
    expect((await a.req("d", { kinds: [4], authors: [alice.pk] })).events.length).toBe(1);
    const other = connect();
    await other.auth(keypair());
    expect((await other.req("d", { kinds: [4], authors: [alice.pk] })).events.length).toBe(0);
  });
});

describe("COUNT (NIP-45)", () => {
  test("counts and privacy", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    const bob = keypair();
    for (let i = 0; i < 3; i++) await c.publish(sign(kp, { content: `${i}` }));
    await c.publish(sign(kp, { kind: 1059, tags: [["p", bob.pk]] }));
    c.send(["COUNT", "c1", { kinds: [1], authors: [kp.pk] }]);
    expect(await c.socket.waitFor((m) => m[0] === "COUNT" && m[1] === "c1")).toEqual(["COUNT", "c1", { count: 3 }]);
    c.send(["COUNT", "c2", { kinds: [1059], "#p": [bob.pk] }]);
    expect(((await c.socket.waitFor((m) => m[0] === "CLOSED" && m[1] === "c2"))[2] as string)).toMatch(/^auth-required:/);
    await c.auth(bob);
    c.send(["COUNT", "c3", { kinds: [1059], "#p": [bob.pk] }]);
    expect(await c.socket.waitFor((m) => m[0] === "COUNT" && m[1] === "c3")).toEqual(["COUNT", "c3", { count: 1 }]);
  });

  test("filters without kinds don't count private events", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    const bob = keypair();
    await c.publish(sign(kp, { content: "public", tags: [["p", bob.pk]] }));
    await c.publish(sign(kp, { kind: 4, tags: [["p", bob.pk]] }));
    await c.publish(sign(kp, { kind: 1059, tags: [["p", bob.pk]] }));
    const count = async (id: string, f: object) => {
      c.send(["COUNT", id, f]);
      return ((await c.socket.waitFor((m) => m[0] === "COUNT" && m[1] === id))[2] as { count: number }).count;
    };
    expect(await count("a", { "#p": [bob.pk] })).toBe(1);
    expect(await count("b", { authors: [kp.pk] })).toBe(1);
    await c.auth(keypair());
    expect(await count("c", { authors: [kp.pk] })).toBe(1);
    await c.auth(bob);
    expect(await count("d", { "#p": [bob.pk] })).toBe(3);
  });
});

describe("NIP-77 through the relay", () => {
  test("NEG-OPEN / NEG-MSG reconciles with stored events", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    const stored: NostrEvent[] = [];
    for (let i = 0; i < 60; i++) {
      const e = sign(kp, { content: `${i}`, created_at: now() - i });
      stored.push(e);
      await c.publish(e);
    }
    const clientOnly = "ab".repeat(32);
    const local = new NegentropyStorage();
    for (const e of stored.slice(0, 40)) local.insert(e.created_at, e.id);
    local.insert(now() - 1000, clientOnly);
    local.seal();
    const neg = new Negentropy(local);
    const need = new Set<string>();
    const have = new Set<string>();
    let msg: string | null = neg.initiate();
    c.send(["NEG-OPEN", "n1", { kinds: [1] }, msg]);
    for (let round = 0; msg !== null && round < 10; round++) {
      const from = c.socket.sent.length;
      const resp = await c.socket.waitFor((m) => m[0] === "NEG-MSG" || m[0] === "NEG-ERR", 2000, from - (round === 0 ? 1 : 0));
      expect(resp[0]).toBe("NEG-MSG");
      const r = neg.reconcile(resp[2] as string);
      r.need.forEach((x) => need.add(x));
      r.have.forEach((x) => have.add(x));
      msg = r.output;
      if (msg !== null) c.send(["NEG-MSG", "n1", msg]);
    }
    c.send(["NEG-CLOSE", "n1"]);
    expect([...need].sort()).toEqual(stored.slice(40).map((e) => e.id).sort());
    expect([...have]).toEqual([clientOnly]);
  });

  test("NEG-OPEN never reveals private event ids", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    const bob = keypair();
    const pub = sign(kp, { content: "public", tags: [["p", bob.pk]] });
    await c.publish(pub);
    await c.publish(sign(kp, { kind: 4, tags: [["p", bob.pk]] }));
    await c.publish(sign(kp, { kind: 1059, tags: [["p", bob.pk]] }));
    const local = new NegentropyStorage();
    local.seal();
    const neg = new Negentropy(local);
    const from = c.socket.sent.length;
    c.send(["NEG-OPEN", "n2", { "#p": [bob.pk] }, neg.initiate()]);
    const resp = await c.socket.waitFor((m) => m[0] === "NEG-MSG" || m[0] === "NEG-ERR", 2000, from);
    expect(resp[0]).toBe("NEG-MSG");
    expect(neg.reconcile(resp[2] as string).need).toEqual([pub.id]);
    c.send(["NEG-OPEN", "n3", { search: "x" }, new Negentropy(local).initiate()]);
    expect(((await c.socket.waitFor((m) => m[0] === "NEG-ERR" && m[1] === "n3"))[2] as string)).toMatch(/^unsupported:/);
  });

  test("a refused NEG-OPEN still closes the old session with that id", async () => {
    const { connect } = await setup();
    const c = connect();
    const local = new NegentropyStorage();
    local.seal();
    c.send(["NEG-OPEN", "n", { kinds: [1] }, new Negentropy(local).initiate()]);
    await c.socket.waitFor((m) => m[0] === "NEG-MSG" && m[1] === "n");
    c.send(["NEG-OPEN", "n", { kinds: [4] }, new Negentropy(local).initiate()]);
    expect(((await c.socket.waitFor((m) => m[0] === "NEG-ERR" && m[1] === "n"))[2] as string)).toMatch(/^auth-required:/);
    const from = c.socket.sent.length;
    c.send(["NEG-MSG", "n", new Negentropy(local).initiate()]);
    expect(((await c.socket.waitFor((m) => m[0] === "NEG-ERR" && m[1] === "n", 2000, from))[2] as string)).toMatch(/^closed:/);
  });

  test("NEG-MSG for unknown session → NEG-ERR", async () => {
    const { connect } = await setup();
    const c = connect();
    c.send(["NEG-MSG", "nope", "61"]);
    expect(((await c.socket.waitFor((m) => m[0] === "NEG-ERR"))[2] as string)).toMatch(/closed|unknown|invalid/);
  });
});
