/** NIP-42 AUTH and the auth-gated access settings (authForRead / authForWrite / mode auth-required / NIP-70 / DM gating). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser, now, sign } from "../harness/client";
import { challengeOf, connectAuthed, nextSub, note, ownerApi, sendAuth, withSettings } from "./policy-helpers";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay();
});
afterAll(() => relay?.stop());

const authEvent = (sk: Uint8Array, relayUrl: string, challenge: string, extra: { created_at?: number; kind?: number } = {}) =>
  sign(sk, { kind: extra.kind ?? 22242, tags: [["relay", relayUrl], ["challenge", challenge]], ...(extra.created_at ? { created_at: extra.created_at } : {}) });

describe("NIP-42 challenge", () => {
  test("relay sends an AUTH challenge on connect, unique per connection", async () => {
    const a = await RelayClient.connect(relay.ws);
    const b = await RelayClient.connect(relay.ws);
    const ca = await challengeOf(a);
    const cb = await challengeOf(b);
    expect(ca).toMatch(/^[0-9a-f]{32}$/);
    expect(cb).not.toBe(ca);
    a.close();
    b.close();
  });

  test("valid AUTH is accepted", async () => {
    const c = await RelayClient.connect(relay.ws);
    const r = await c.auth(newUser().sk, relay.ws);
    expect(r).toEqual({ ok: true, message: "" });
    c.close();
  });

  test("relay tag comparison ignores scheme and trailing slash", async () => {
    const c = await RelayClient.connect(relay.ws);
    const ch = await challengeOf(c);
    const r = await sendAuth(c, authEvent(newUser().sk, `${relay.http}/`, ch));
    expect(r.ok).toBe(true);
    c.close();
  });

  test("wrong challenge is rejected", async () => {
    const c = await RelayClient.connect(relay.ws);
    await challengeOf(c);
    const r = await sendAuth(c, authEvent(newUser().sk, relay.ws, "00".repeat(16)));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid: challenge does not match");
    c.close();
  });

  test("a challenge from another connection is rejected", async () => {
    const a = await RelayClient.connect(relay.ws);
    const b = await RelayClient.connect(relay.ws);
    const chA = await challengeOf(a);
    await challengeOf(b);
    const r = await sendAuth(b, authEvent(newUser().sk, relay.ws, chA));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid: challenge");
    a.close();
    b.close();
  });

  test("wrong relay tag is rejected", async () => {
    const c = await RelayClient.connect(relay.ws);
    const ch = await challengeOf(c);
    const r = await sendAuth(c, authEvent(newUser().sk, "wss://other-relay.example.com", ch));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid: relay tag does not match");
    c.close();
  });

  test("stale AUTH (created_at > 10 min old) is rejected", async () => {
    const c = await RelayClient.connect(relay.ws);
    const ch = await challengeOf(c);
    const r = await sendAuth(c, authEvent(newUser().sk, relay.ws, ch, { created_at: now() - 700 }));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid: AUTH event created_at");
    c.close();
  });

  test("AUTH with a non-22242 kind is rejected", async () => {
    const c = await RelayClient.connect(relay.ws);
    const ch = await challengeOf(c);
    const r = await sendAuth(c, authEvent(newUser().sk, relay.ws, ch, { kind: 1 }));
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid: AUTH event must be kind 22242");
    c.close();
  });

  test("AUTH with a forged signature is rejected", async () => {
    const c = await RelayClient.connect(relay.ws);
    const ch = await challengeOf(c);
    const ev = authEvent(newUser().sk, relay.ws, ch);
    const forged = { ...ev, sig: ev.sig.replace(/^./, (x) => (x === "0" ? "1" : "0")) };
    const r = await sendAuth(c, forged);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
    c.close();
  });

  test("kind 22242 sent as EVENT is refused (never stored)", async () => {
    const c = await RelayClient.connect(relay.ws);
    const ch = await challengeOf(c);
    const ev = authEvent(newUser().sk, relay.ws, ch);
    const r = await c.publish(ev);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid: AUTH events must be sent in an AUTH message");
    c.close();
  });

  test("banned pubkey cannot AUTH", async () => {
    const u = newUser();
    await ownerApi(relay, "POST", `/users/${u.pubkey}/ban`, { reason: "spam" });
    const c = await RelayClient.connect(relay.ws);
    const r = await c.auth(u.sk, relay.ws);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("blocked:");
    c.close();
  });

  test("one connection can authenticate several pubkeys and publish as each", async () => {
    const a = newUser();
    const b = newUser();
    const c = await RelayClient.connect(relay.ws);
    const ch = await challengeOf(c);
    expect((await sendAuth(c, authEvent(a.sk, relay.ws, ch))).ok).toBe(true);
    expect((await sendAuth(c, authEvent(b.sk, relay.ws, ch))).ok).toBe(true);
    await withSettings(relay, { access: { mode: "auth-required" } }, async () => {
      expect((await c.publish(note(a.sk))).ok).toBe(true);
      expect((await c.publish(note(b.sk))).ok).toBe(true);
    });
    c.close();
  });
});

describe("auth-gated access settings", () => {
  test("authForWrite: unauthenticated EVENT gets auth-required, authenticated succeeds", async () => {
    const u = newUser();
    await withSettings(relay, { access: { authForWrite: true } }, async () => {
      const anon = await RelayClient.connect(relay.ws);
      const r = await anon.publish(note(u.sk));
      expect(r.ok).toBe(false);
      expect(r.message).toStartWith("auth-required:");
      const authed = await connectAuthed(relay, u.sk);
      expect((await authed.publish(note(u.sk))).ok).toBe(true);
      // reading is not gated by authForWrite
      const q = await anon.query(nextSub(), [{ authors: [u.pubkey] }]);
      expect(q.closed).toBeUndefined();
      expect(q.events.length).toBe(1);
      anon.close();
      authed.close();
    });
  });

  test("authForRead: unauthenticated REQ and COUNT are CLOSED auth-required; authenticated REQ works", async () => {
    const u = newUser();
    const w = await RelayClient.connect(relay.ws);
    const ev = note(u.sk);
    expect((await w.publish(ev)).ok).toBe(true);
    await withSettings(relay, { access: { authForRead: true } }, async () => {
      const anon = await RelayClient.connect(relay.ws);
      const q = await anon.query(nextSub(), [{ ids: [ev.id] }]);
      expect(q.closed).toStartWith("auth-required:");
      const cs = nextSub();
      anon.send(["COUNT", cs, { ids: [ev.id] }]);
      const cm = await anon.waitFor((m) => m[1] === cs);
      expect(cm[0]).toBe("CLOSED");
      expect(cm[2] as string).toStartWith("auth-required:");
      // writing still open
      expect((await anon.publish(note(u.sk))).ok).toBe(true);
      const authed = await connectAuthed(relay, newUser().sk);
      const q2 = await authed.query(nextSub(), [{ ids: [ev.id] }]);
      expect(q2.events.map((e) => e.id)).toEqual([ev.id]);
      anon.close();
      authed.close();
    });
    w.close();
  });

  test("mode auth-required: reads and writes need AUTH, and the author must match the authed pubkey", async () => {
    const me = newUser();
    const other = newUser();
    await withSettings(relay, { access: { mode: "auth-required" } }, async () => {
      const anon = await RelayClient.connect(relay.ws);
      const r = await anon.publish(note(me.sk));
      expect(r.message).toStartWith("auth-required:");
      expect((await anon.query(nextSub(), [{ kinds: [1], limit: 1 }])).closed).toStartWith("auth-required:");
      const c = await connectAuthed(relay, me.sk);
      expect((await c.publish(note(me.sk))).ok).toBe(true);
      const foreign = await c.publish(note(other.sk));
      expect(foreign.ok).toBe(false);
      expect(foreign.message).toStartWith("restricted: event author must match");
      anon.close();
      c.close();
    });
  });

  test("enabling authForRead at runtime closes already-open anonymous subscriptions (regression)", async () => {
    const u = newUser();
    const anon = await RelayClient.connect(relay.ws);
    const sub = nextSub();
    await anon.query(sub, [{ authors: [u.pubkey] }], false);
    const w = await RelayClient.connect(relay.ws);
    await withSettings(relay, { access: { authForRead: true } }, async () => {
      const ev = note(u.sk, "after the switch");
      expect((await w.publish(ev)).ok).toBe(true);
      await anon.expectNone((m) => m[0] === "EVENT" && m[1] === sub && (m[2] as any).id === ev.id, 300);
      const closed = await anon.waitFor((m) => m[0] === "CLOSED" && m[1] === sub);
      expect(closed[2] as string).toStartWith("auth-required:");
    });
    anon.close();
    w.close();
  });

  test("NIP-11 advertises auth_required / restricted_writes as the settings change", async () => {
    const doc = async () => (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json();
    const before = await doc();
    expect(before.limitation.auth_required).toBe(false);
    await withSettings(relay, { access: { mode: "auth-required" } }, async () => {
      const d = await doc();
      expect(d.limitation.auth_required).toBe(true);
      expect(d.limitation.restricted_writes).toBe(true);
    });
  });
});

describe("NIP-70 protected events and DM gating", () => {
  test("protected event: refused unauthenticated, refused when authed as someone else, accepted from its author", async () => {
    const author = newUser();
    const ev = sign(author.sk, { kind: 1, content: "protected", tags: [["-"]] });
    const anon = await RelayClient.connect(relay.ws);
    const r1 = await anon.publish(ev);
    expect(r1.ok).toBe(false);
    expect(r1.message).toStartWith("auth-required:");
    const otherConn = await connectAuthed(relay, newUser().sk);
    const r2 = await otherConn.publish(ev);
    expect(r2.ok).toBe(false);
    expect(r2.message).toStartWith("restricted:");
    const mine = await connectAuthed(relay, author.sk);
    expect((await mine.publish(ev)).ok).toBe(true);
    anon.close();
    otherConn.close();
    mine.close();
  });

  test("kind 4 DMs are only delivered to authenticated sender/recipient", async () => {
    const alice = newUser();
    const bob = newUser();
    const dm = sign(alice.sk, { kind: 4, content: "ciphertext?iv=x", tags: [["p", bob.pubkey]] });
    const w = await RelayClient.connect(relay.ws);
    expect((await w.publish(dm)).ok).toBe(true);
    const anon = await RelayClient.connect(relay.ws);
    expect((await anon.query(nextSub(), [{ kinds: [4], "#p": [bob.pubkey] }])).closed).toStartWith("auth-required:");
    // a mixed filter is not refused, but the DM is not disclosed
    const mixed = await anon.query(nextSub(), [{ ids: [dm.id] }]);
    expect(mixed.events).toEqual([]);
    const stranger = await connectAuthed(relay, newUser().sk);
    expect((await stranger.query(nextSub(), [{ ids: [dm.id] }])).events).toEqual([]);
    const bobConn = await connectAuthed(relay, bob.sk);
    expect((await bobConn.query(nextSub(), [{ ids: [dm.id] }])).events.map((e) => e.id)).toEqual([dm.id]);
    const aliceConn = await connectAuthed(relay, alice.sk);
    expect((await aliceConn.query(nextSub(), [{ ids: [dm.id] }])).events.map((e) => e.id)).toEqual([dm.id]);
    for (const c of [w, anon, stranger, bobConn, aliceConn]) c.close();
  });
});
