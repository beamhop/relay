import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { Negentropy, NegentropyStorage } from "../src";
import { MAX_FILTER_VALUES } from "../src/protocol/messages";
import { BACKPRESSURE, MAX_AUTHED_PUBKEYS, MAX_INFLIGHT_EVENTS, MAX_NEG_SESSIONS_PER_CONN } from "../src/protocol/handlers";
import { MESSAGES_PER_MINUTE } from "../src/relay";
import { eventually, keypair, now, setup, sign, tick } from "./fakes";

const RELAY = "wss://relay.example.com";
const h = (id: string, extra: string[][] = []) => [["h", id], ...extra];
const hex = (n: number) => n.toString(16).padStart(64, "0");
type Conn = ReturnType<Awaited<ReturnType<typeof setup>>["connect"]>;

async function negNeed(c: Conn, filter: object, subId = "n"): Promise<string[] | string> {
  const s = new NegentropyStorage();
  s.seal();
  const client = new Negentropy(s, 0);
  const need = new Set<string>();
  let msg: string | null = client.initiate();
  let first = true;
  while (msg !== null) {
    const from = c.socket.sent.length;
    c.send(first ? ["NEG-OPEN", subId, filter, msg] : ["NEG-MSG", subId, msg]);
    first = false;
    const resp = await c.socket.waitFor((m) => (m[0] === "NEG-MSG" || m[0] === "NEG-ERR") && m[1] === subId, 5000, from);
    if (resp[0] === "NEG-ERR") return resp[2] as string;
    const r = client.reconcile(resp[2] as string);
    r.need.forEach((x) => need.add(x));
    msg = r.output;
  }
  return [...need];
}

describe("filter size limits", () => {
  test("arrays above the per-filter cap are refused", async () => {
    const { connect } = await setup();
    const c = connect();
    const kinds = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => i);
    const { end } = await c.req("big", { kinds });
    expect(end[0]).toBe("CLOSED");
    expect(end[2]).toMatch(/^invalid: too many values in "kinds"/);
    const tags = Array.from({ length: 1700 }, (_, i) => `t${i}`);
    const { end: end2 } = await c.req("big2", { "#t": tags, "#e": tags, "#p": tags });
    expect(end2[2]).toMatch(/^invalid: too many values in one filter/);
  });

  test("filter values are budgeted per connection", async () => {
    const { connect } = await setup();
    const c = connect();
    const tags = (n: number) => Array.from({ length: 1000 }, (_, i) => `v${n}-${i}`);
    let closed: unknown[] | undefined;
    for (let i = 0; i < 25 && !closed; i++) {
      const { end } = await c.req(`s${i}`, { "#t": tags(i), limit: 0 });
      if (end[0] === "CLOSED") closed = end;
    }
    expect(closed?.[2]).toMatch(/^restricted: too many filter values/);
    // closing subscriptions frees the budget
    for (let i = 0; i < 25; i++) c.send(["CLOSE", `s${i}`]);
    expect((await c.req("again", { "#t": tags(99), limit: 0 })).end[0]).toBe("EOSE");
  });

  test("live delivery still matches large tag filters (compiled to sets)", async () => {
    const { connect } = await setup();
    const reader = connect();
    const values = Array.from({ length: 1000 }, (_, i) => `topic${i}`);
    await reader.req("live", { "#t": values, limit: 0 });
    const writer = connect("5.6.7.8");
    const ev = sign(keypair(), { tags: [["t", "topic777"]] });
    await writer.publish(ev);
    await reader.socket.waitFor((m) => m[0] === "EVENT" && m[1] === "live" && (m[2] as NostrEvent).id === ev.id);
  });
});

describe("inbound throttling", () => {
  test("messages beyond the per-connection budget are refused before any work", async () => {
    const { connect } = await setup();
    const c = connect();
    for (let i = 0; i < MESSAGES_PER_MINUTE + 5; i++) c.send(["NEG-MSG", "x", "61"]);
    const errs = c.socket.of("NEG-ERR").map((m) => m[2]);
    expect(errs.filter((r) => String(r).startsWith("rate-limited: too many messages")).length).toBe(5);
    // CLOSE is never throttled
    c.send(["CLOSE", "whatever"]);
  });

  test("relay staff are exempt from the message budget", async () => {
    const owner = keypair();
    const { connect } = await setup({ config: { admin: { owners: [owner.pk] } } });
    const c = connect();
    expect((await c.auth(owner))[2]).toBe(true);
    for (let i = 0; i < MESSAGES_PER_MINUTE + 5; i++) c.send(["NEG-MSG", "x", "61"]);
    expect(c.socket.of("NEG-ERR").some((m) => String(m[2]).startsWith("rate-limited"))).toBe(false);
  });

  test("EVENTs awaiting their OK are capped per connection", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    const evs = Array.from({ length: MAX_INFLIGHT_EVENTS + 20 }, (_, i) => sign(kp, { content: `m${i}` }));
    for (const ev of evs) c.send(["EVENT", ev]);
    const last = evs[evs.length - 1];
    const res = await c.socket.waitFor((m) => m[0] === "OK" && m[1] === last.id);
    expect(res[3]).toMatch(/^rate-limited: too many events awaiting OK/);
    await c.socket.waitFor((m) => m[0] === "OK" && m[1] === evs[0].id);
  });

  test("a connection can only authenticate a bounded number of pubkeys", async () => {
    const { connect } = await setup();
    const c = connect();
    for (let i = 0; i < MAX_AUTHED_PUBKEYS; i++) expect((await c.auth(keypair()))[2]).toBe(true);
    const res = await c.auth(keypair());
    expect(res[2]).toBe(false);
    expect(res[3]).toMatch(/^restricted: too many authenticated pubkeys/);
  });
});

describe("negentropy", () => {
  test("sessions per connection are capped", async () => {
    const { connect } = await setup();
    const c = connect();
    const s = new NegentropyStorage();
    s.seal();
    for (let i = 0; i < MAX_NEG_SESSIONS_PER_CONN; i++) {
      c.send(["NEG-OPEN", `n${i}`, { kinds: [1] }, new Negentropy(s, 0).initiate()]);
      await c.socket.waitFor((m) => m[0] === "NEG-MSG" && m[1] === `n${i}`);
    }
    c.send(["NEG-OPEN", "extra", { kinds: [1] }, new Negentropy(s, 0).initiate()]);
    const err = await c.socket.waitFor((m) => m[0] === "NEG-ERR" && m[1] === "extra");
    expect(err[2]).toMatch(/^blocked: too many negentropy sessions/);
    c.send(["NEG-CLOSE", "n0"]);
    c.send(["NEG-OPEN", "extra", { kinds: [1] }, new Negentropy(s, 0).initiate()]);
    await c.socket.waitFor((m) => m[0] === "NEG-MSG" && m[1] === "extra");
  });

  test("a visibility hook no longer refuses large syncs; hidden events are still left out", async () => {
    const { connect, hooks, stores } = await setup();
    hooks.onVisibility((e) => e.content !== "secret", "test");
    const kp = keypair();
    const t = now();
    for (let i = 0; i < 6000; i++) {
      const ev = { id: hex(i + 1), pubkey: kp.pk, created_at: t - i, kind: 1, tags: [], content: "x", sig: "0".repeat(128) };
      stores.events.events.set(ev.id, ev);
    }
    const secret = sign(kp, { content: "secret" });
    stores.events.events.set(secret.id, secret);
    const need = await negNeed(connect(), { authors: [kp.pk] });
    expect(Array.isArray(need)).toBe(true);
    expect((need as string[]).length).toBe(6000);
    expect((need as string[]).includes(secret.id)).toBe(false);
  });

  test("many private (gated) events fall back to per-event checks instead of refusing", async () => {
    const { connect, stores } = await setup();
    const kp = keypair();
    const t = now();
    for (let i = 0; i < 5100; i++) {
      const ev = { id: hex(i + 1), pubkey: kp.pk, created_at: t - i, kind: 1059, tags: [["p", hex(999_999)]], content: "", sig: "0".repeat(128) };
      stores.events.events.set(ev.id, ev);
    }
    const mine = sign(kp, { kind: 1 });
    stores.events.events.set(mine.id, mine);
    const c = connect();
    await c.auth(keypair());
    expect(await negNeed(c, { authors: [kp.pk] })).toEqual([mine.id]);
  });
});

describe("COUNT", () => {
  test("counts above 5000 under plugin visibility hooks are exact, never 'approximate'", async () => {
    const { connect, hooks, stores } = await setup();
    hooks.onVisibility((e) => e.content !== "secret", "test");
    const kp = keypair();
    for (let i = 0; i < 5005; i++) {
      const ev = { id: hex(i + 1), pubkey: kp.pk, created_at: now() - i, kind: 7, tags: [], content: i % 1000 === 0 ? "secret" : "+", sig: "0".repeat(128) };
      stores.events.events.set(ev.id, ev);
    }
    const c = connect();
    c.send(["COUNT", "c", { kinds: [7] }]);
    const res = await c.socket.waitFor((m) => (m[0] === "COUNT" || m[0] === "CLOSED") && m[1] === "c", 10_000);
    expect(res).toEqual(["COUNT", "c", { count: 5005 - 6 }]);
  });
});

describe("stored results honour backpressure", () => {
  test("waits for the send buffer to drain, then sends the rest and EOSE", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    await c.publish(sign(kp, { content: "a" }));
    c.socket.buffered = 2 << 20;
    const from = c.socket.sent.length;
    c.send(["REQ", "bp", { authors: [kp.pk] }]);
    await tick(60);
    expect(c.socket.sent.slice(from).some((m) => m[1] === "bp")).toBe(false);
    c.socket.buffered = 0;
    await c.socket.waitFor((m) => m[0] === "EOSE" && m[1] === "bp", 2000, from);
    expect(c.socket.sent.slice(from).filter((m) => m[0] === "EVENT").length).toBe(1);
  });

  test("a client that never drains is disconnected instead of buffering without limit", async () => {
    const saved = { ...BACKPRESSURE };
    BACKPRESSURE.drainTimeoutMs = 50;
    BACKPRESSURE.pollMs = 5;
    try {
      const { connect } = await setup();
      const c = connect();
      const kp = keypair();
      await c.publish(sign(kp));
      c.socket.buffered = 2 << 20;
      c.send(["REQ", "bp", { authors: [kp.pk] }]);
      await tick(150);
      expect(c.socket.closed?.code).toBe(1008);
      expect(c.socket.of("EOSE").length).toBe(0);
    } finally {
      Object.assign(BACKPRESSURE, saved);
    }
  });
});

describe("NIP-29", () => {
  test("invite codes (9009) are only readable by the group's admins/moderators", async () => {
    const { connect } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("club", [["closed"]]) }));
    const invite = sign(admin, { kind: 9009, tags: h("club", [["code", "s3cret-code"]]) });
    expect((await c.publish(invite))[2]).toBe(true);

    const outsider = connect("9.9.9.9");
    await outsider.auth(keypair());
    expect((await outsider.req("i", { kinds: [9009], "#h": ["club"] })).events).toEqual([]);
    outsider.send(["COUNT", "ic", { kinds: [9009] }]);
    expect(await outsider.socket.waitFor((m) => m[0] === "COUNT" && m[1] === "ic")).toEqual(["COUNT", "ic", { count: 0 }]);

    const adminConn = connect("9.9.9.8");
    await adminConn.auth(admin);
    expect((await adminConn.req("i", { kinds: [9009], "#h": ["club"] })).events.map((e) => e.id)).toEqual([invite.id]);
  });

  test("invite codes: hashed at rest, short codes refused, bad codes refused and rate limited", async () => {
    const { connect, stores, relay } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("club", [["closed"]]) }));
    expect((await c.publish(sign(admin, { kind: 9009, tags: h("club", [["code", "abc"]]) })))[3]).toMatch(/^invalid: invite codes must be at least/);
    await c.publish(sign(admin, { kind: 9009, tags: h("club", [["code", "good-code"]]) }));
    const rows = await stores.db.all<{ code: string }>("SELECT code FROM core_group_invites");
    expect(rows.map((r) => r.code)).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{64}$/)]);

    const guesser = connect("7.7.7.7");
    const wrong = sign(keypair(), { kind: 9021, tags: h("club", [["code", "guess-0"]]) });
    expect((await guesser.publish(wrong))[3]).toMatch(/^restricted: invalid invite code/);
    expect(await stores.events.getById(wrong.id)).toBeUndefined();
    let limited = false;
    for (let i = 1; i < 15 && !limited; i++) {
      const res = await guesser.publish(sign(keypair(), { kind: 9021, tags: h("club", [["code", `guess-${i}`]]) }));
      limited = /^rate-limited:/.test(res[3]);
    }
    expect(limited).toBe(true);
    // the valid code still works from another address
    const bob = keypair();
    expect((await connect("8.8.8.8").publish(sign(bob, { kind: 9021, tags: h("club", [["code", "good-code"]]) })))[2]).toBe(true);
    expect((await relay.groups.get("club"))?.memberList.some((m) => m.pubkey === bob.pk)).toBe(true);
  });

  test("a deleted control event replayed later does not re-apply its change", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g") }));
    const add = sign(admin, { kind: 9000, tags: h("g", [["p", bob.pk]]) });
    await c.publish(add);
    await c.publish(sign(admin, { kind: 9001, tags: h("g", [["p", bob.pk]]) }));
    // removed from storage without a NIP-09 tombstone (9005)
    await c.publish(sign(admin, { kind: 9005, tags: h("g", [["e", add.id]]) }));
    const replay = await connect("6.6.6.6").publish(add);
    expect(replay[3]).toMatch(/^duplicate:/);
    expect((await relay.groups.get("g"))?.memberList.some((m) => m.pubkey === bob.pk)).toBe(false);
  });

  test("a NIP-09 deleted control event replayed later does not re-apply its change", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g") }));
    const add = sign(admin, { kind: 9000, tags: h("g", [["p", bob.pk]]) });
    await c.publish(add);
    await c.publish(sign(admin, { kind: 9001, tags: h("g", [["p", bob.pk]]) }));
    await c.publish(sign(admin, { kind: 5, tags: [["e", add.id]] }));
    await connect("6.6.6.6").publish(add);
    expect((await relay.groups.get("g"))?.memberList.some((m) => m.pubkey === bob.pk)).toBe(false);
  });

  test("relay-signed group metadata can't be re-injected by clients", async () => {
    const { connect } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("ghost") }));
    const { events } = await c.req("m", { kinds: [39000], "#d": ["ghost"] });
    expect(events.length).toBe(1);
    const res = await connect("4.4.4.4").publish(events[0]);
    expect(res[3]).toMatch(/^(restricted:|duplicate:)/);
    await c.publish(sign(admin, { kind: 9008, tags: h("ghost") }));
    const again = await connect("4.4.4.5").publish(events[0]);
    expect(again[2]).toBe(false);
    expect(again[3]).toMatch(/^restricted: group metadata events are generated by the relay/);
  });

  test("old group control events are refused from plugins and sync too", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("aged") }));
    const old = sign(admin, { kind: 9000, tags: h("aged", [["p", keypair().pk]]), created_at: now() - 3600 });
    expect((await relay.publish(old, "plugin")).message).toMatch(/^invalid: group control events must be recent/);
    expect((await relay.publish(old, "sync")).message).toMatch(/^invalid: group control events must be recent/);
  });

  test("a failed group deletion keeps the group's content hidden", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("doomed", [["private"]]) }));
    const post = sign(admin, { kind: 9, content: "private stuff", tags: h("doomed") });
    await c.publish(post);
    const orig = stores.events.deleteByFilter.bind(stores.events);
    stores.events.deleteByFilter = async () => {
      throw new Error("disk full");
    };
    expect((await c.publish(sign(admin, { kind: 9008, tags: h("doomed") })))[2]).toBe(false);
    stores.events.deleteByFilter = orig;
    const outsider = connect("3.3.3.3");
    await outsider.auth(keypair());
    expect((await outsider.req("x", { "#h": ["doomed"] })).events).toEqual([]);
  });

  test("hidden groups don't confirm their existence or membership to outsiders", async () => {
    const { connect } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("shadow", [["hidden"], ["closed"]]) }));
    await c.publish(sign(admin, { kind: 9000, tags: h("shadow", [["p", bob.pk]]) }));
    const outsider = connect("2.2.2.2");
    const kp = keypair();
    await outsider.auth(kp);
    expect((await outsider.publish(sign(kp, { kind: 9, tags: h("shadow") })))[3]).toBe("invalid: group not found");
    expect((await outsider.publish(sign(kp, { kind: 9021, tags: h("shadow") })))[3]).toBe("invalid: group not found");
    expect((await outsider.publish(sign(kp, { kind: 9001, tags: h("shadow", [["p", bob.pk]]) })))[3]).toBe("invalid: group not found");
    expect((await outsider.publish(sign(kp, { kind: 9, tags: h("nonexistent") })))[3]).toBe("invalid: group not found");
    expect((await outsider.req("m", { kinds: [9000, 9001], "#h": ["shadow"] })).events).toEqual([]);
    const member = connect("2.2.2.3");
    await member.auth(bob);
    expect((await member.req("m", { kinds: [9000], "#h": ["shadow"] })).events.length).toBeGreaterThan(0);
  });
});

describe("whitelist inbound", () => {
  test("only inbox kinds may reach members from non-members", async () => {
    const member = keypair();
    const { connect, stores } = await setup({ settings: { access: { mode: "whitelist" } } });
    await stores.users.upsert(member.pk, { allowed: true });
    const c = connect();
    const stranger = keypair();
    expect((await c.publish(sign(stranger, { kind: 1, tags: [["p", member.pk]] })))[2]).toBe(true);
    const profile = await c.publish(sign(stranger, { kind: 0, content: "{}", tags: [["p", member.pk]] }));
    expect(profile[2]).toBe(false);
    expect(profile[3]).toMatch(/^restricted:/);
    const longform = await c.publish(sign(stranger, { kind: 30023, tags: [["d", "x"], ["p", member.pk]] }));
    expect(longform[2]).toBe(false);
  });
});

describe("NIP-62 request to vanish", () => {
  test("an old event re-sent while the vanish request is processed doesn't survive it", async () => {
    const { connect, hooks, stores } = await setup();
    const kp = keypair();
    const c = connect();
    const t = now();
    await c.publish(sign(kp, { content: "first", created_at: t - 200 }));
    const old = sign(kp, { content: "old copy", created_at: t - 100 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    hooks.onWrite(async (e) => {
      if (e.id === old.id) await gate; // passes the vanished check, then waits before being stored
      return undefined;
    }, "test");
    const pending = connect("1.1.1.2").publish(old);
    await tick(20);
    expect((await c.publish(sign(kp, { kind: 62, content: "", tags: [["relay", RELAY]], created_at: t - 50 })))[2]).toBe(true);
    release();
    const res = await pending;
    expect(res[2]).toBe(false);
    expect(res[3]).toMatch(/requested to vanish/);
    expect(await stores.events.getById(old.id)).toBeUndefined();
  });

  test("vanish requests from unknown throwaway keys leave no lasting marker", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const throwaway = keypair();
    expect((await c.publish(sign(throwaway, { kind: 62, content: "", tags: [["relay", RELAY]] })))[2]).toBe(true);
    expect(await stores.kv.list("core-vanish")).toEqual({});
    const known = keypair();
    await c.publish(sign(known, { content: "hi", created_at: now() - 10 }));
    await c.publish(sign(known, { kind: 62, content: "", tags: [["relay", RELAY]] }));
    expect(Object.keys(await stores.kv.list("core-vanish"))).toEqual([known.pk]);
  });
});

describe("NIP-56 auto-ban", () => {
  test("a flood of reports from non-members neither counts nor hides members' reports", async () => {
    const { connect, stores } = await setup({ settings: { moderation: { autoBanReportThreshold: 2 } } });
    const target = keypair();
    const m1 = keypair();
    const m2 = keypair();
    await stores.users.upsert(m1.pk, { allowed: true });
    await stores.users.upsert(m2.pk, { allowed: true });
    const c = connect();
    await c.publish(sign(m1, { kind: 1984, tags: [["p", target.pk, "spam"]] }));
    for (let i = 0; i < 30; i++) {
      const kp = keypair();
      await stores.users.upsert(kp.pk, {}); // known but not a member
      await connect(`10.0.0.${i}`).publish(sign(kp, { kind: 1984, tags: [["p", target.pk, "spam"]] }));
    }
    expect((await stores.users.get(target.pk))?.status).not.toBe("banned");
    await c.publish(sign(m2, { kind: 1984, tags: [["p", target.pk, "spam"]] }));
    await eventually(async () => (await stores.users.get(target.pk))?.status === "banned");
  });
});
