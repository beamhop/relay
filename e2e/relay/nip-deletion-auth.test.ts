/**
 * NIP conformance probes for deletion (NIP-09), request to vanish (NIP-62), reports (NIP-56), protected events
 * (NIP-70), AUTH (NIP-42) and DM / gift wrap read gating (NIP-04/17/44/59). Complements core-kinds,
 * core-access, policy-auth and policy-moderation (no duplicates of what those already cover).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import type { Relay } from "../harness/relay";
import { RelayClient, newUser, type Msg } from "../harness/client";
import { clients, ids, isEventFor, isOk, now, publishOk, rand, sign, startCoreRelay } from "./core-helpers";

let relay: Relay;
const cs = clients();
beforeAll(async () => {
  relay = await startCoreRelay();
});
afterEach(() => cs.closeAll());
afterAll(() => relay?.stop());

const sub = () => `nd-${rand(4)}`;
const q = async (c: RelayClient, filters: Record<string, unknown>[]) => (await c.query(sub(), filters)).events;

async function count(c: RelayClient, filters: Record<string, unknown>[]): Promise<Msg> {
  const s = sub();
  c.send(["COUNT", s, ...filters]);
  return c.waitFor((m) => (m[0] === "COUNT" || m[0] === "CLOSED") && m[1] === s);
}

async function authed(...sks: Uint8Array[]): Promise<RelayClient> {
  const c = await cs.connect(relay.ws);
  const ch = (await c.waitFor((m) => m[0] === "AUTH"))[1] as string;
  for (const sk of sks) {
    const r = await sendAuth(c, authEvent(sk, relay.ws, ch));
    if (!r.ok) throw new Error(`AUTH failed: ${r.message}`);
  }
  // leave the challenge for tests that need it
  c.inbox.push(["AUTH", ch]);
  return c;
}

async function challenge(c: RelayClient): Promise<string> {
  const m = await c.waitFor((f) => f[0] === "AUTH");
  c.inbox.push(m);
  return m[1] as string;
}

function authEvent(sk: Uint8Array, relayUrl: string | undefined, ch: string | undefined, extra: { created_at?: number; kind?: number } = {}): Event {
  const tags: string[][] = [];
  if (relayUrl !== undefined) tags.push(["relay", relayUrl]);
  if (ch !== undefined) tags.push(["challenge", ch]);
  return sign(sk, { kind: extra.kind ?? 22242, tags, ...(extra.created_at !== undefined ? { created_at: extra.created_at } : {}) });
}

async function sendAuth(c: RelayClient, ev: Event): Promise<{ ok: boolean; message: string }> {
  c.send(["AUTH", ev]);
  const m = await c.waitFor(isOk(ev.id));
  return { ok: m[2] as boolean, message: m[3] as string };
}

/** A NIP-59 gift wrap addressed to `recipient`, signed by a throwaway key. */
function giftWrap(recipient: string, kind = 1059, created_at = now() - 3600): Event {
  return sign(newUser().sk, { kind, created_at, content: `sealed-${rand()}`, tags: [["p", recipient]] });
}

// ------------------------------------------------------------------ NIP-09

describe("NIP-09 deletion", () => {
  test("one request with e, a and k tags deletes every referenced event of the author", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 50;
    const n1 = await publishOk(c, sign(u.sk, { kind: 1, content: "a", created_at: t }));
    const n2 = await publishOk(c, sign(u.sk, { kind: 7, content: "+", created_at: t }));
    const art = await publishOk(c, sign(u.sk, { kind: 30023, content: "art", tags: [["d", "x"]], created_at: t }));
    await publishOk(
      c,
      sign(u.sk, {
        kind: 5,
        tags: [["e", n1.id], ["e", n2.id], ["a", `30023:${u.pubkey}:x`], ["k", "1"], ["k", "7"], ["k", "30023"]],
      }),
    );
    expect(await q(c, [{ ids: [n1.id, n2.id, art.id] }])).toEqual([]);
  });

  test("an a-tag deletion older than the current version leaves that version in place", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    const v2 = await publishOk(c, sign(u.sk, { kind: 30023, content: "v2", tags: [["d", "p"]], created_at: t + 20 }));
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["a", `30023:${u.pubkey}:p`]], created_at: t + 10 }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [30023] }]))).toEqual([v2.id]);
  });

  test("an a-tag deletion covers a version with exactly its created_at", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    await publishOk(c, sign(u.sk, { kind: 30000, content: "", tags: [["d", "l"]], created_at: t }));
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["a", `30000:${u.pubkey}:l`]], created_at: t }));
    expect(await q(c, [{ authors: [u.pubkey], kinds: [30000] }])).toEqual([]);
    const same = await c.publish(sign(u.sk, { kind: 30000, content: "again", tags: [["d", "l"]], created_at: t }));
    expect(same.ok).toBe(false);
  });

  test("a deleted replaceable event's id stays deleted, a newer replacement is accepted", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const t = now() - 100;
    const v1 = await publishOk(c, sign(u.sk, { kind: 0, content: "{}", created_at: t }));
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", v1.id], ["k", "0"]], created_at: t + 1 }));
    expect((await c.publish(v1)).ok).toBe(false);
    const v2 = await publishOk(c, sign(u.sk, { kind: 0, content: '{"name":"x"}', created_at: t + 2 }));
    expect(ids(await q(c, [{ authors: [u.pubkey], kinds: [0] }]))).toEqual([v2.id]);
  });

  test("a deletion request against a request to vanish has no effect (NIP-62)", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 1, content: "known", created_at: now() - 10 }));
    const vanish = await publishOk(c, sign(u.sk, { kind: 62, content: "", tags: [["relay", relay.ws]], created_at: now() - 5 }));
    expect(ids(await q(c, [{ ids: [vanish.id] }]))).toEqual([vanish.id]);
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", vanish.id], ["k", "62"]] }));
    expect(ids(await q(c, [{ ids: [vanish.id] }]))).toEqual([vanish.id]);
  });

  // regression: a kind 5 naming a request to vanish that arrived first left a tombstone that made the store refuse the
  // vanish request, although NIP-62 says "Publishing a deletion request event (Kind 5) against a request to vanish has no effect"
  test("a deletion request published before the request to vanish it names doesn't get the vanish refused", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const note = await publishOk(c, sign(u.sk, { kind: 1, content: "x", created_at: now() - 20 }));
    const vanish = sign(u.sk, { kind: 62, content: "", tags: [["relay", relay.ws]], created_at: now() - 5 });
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", vanish.id], ["k", "62"]], created_at: now() - 10 }));
    expect(await c.publish(vanish)).toEqual({ ok: true, message: "" });
    expect(await q(c, [{ ids: [note.id] }])).toEqual([]);
  });

  test("NIP-59: the p-tagged recipient can delete a gift wrap; a re-broadcast is refused; others can't delete it", async () => {
    const c = await cs.connect(relay.ws);
    const [bob, mallory] = [newUser(), newUser()];
    const wrap = await publishOk(c, giftWrap(bob.pubkey));
    const keep = await publishOk(c, giftWrap(bob.pubkey));
    await publishOk(c, sign(mallory.sk, { kind: 5, tags: [["e", keep.id], ["k", "1059"]] }));
    await publishOk(c, sign(bob.sk, { kind: 5, tags: [["e", wrap.id], ["k", "1059"]] }));
    const bobConn = await authed(bob.sk);
    expect(ids(await q(bobConn, [{ kinds: [1059], "#p": [bob.pubkey] }]))).toEqual([keep.id]);
    expect((await c.publish(wrap)).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ NIP-62

describe("NIP-62 request to vanish", () => {
  test("deletes the author's events up to created_at (incl. deletions) and gift wraps to them; old copies are refused", async () => {
    const c = await cs.connect(relay.ws);
    const [u, other] = [newUser(), newUser()];
    const t = now() - 100;
    const n1 = await publishOk(c, sign(u.sk, { kind: 1, content: "old", created_at: t }));
    const n2 = await publishOk(c, sign(u.sk, { kind: 1, content: "to delete", created_at: t }));
    const del = await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", n2.id]], created_at: t + 1 }));
    const prof = await publishOk(c, sign(u.sk, { kind: 0, content: "{}", created_at: t + 2 }));
    const wrap = await publishOk(c, giftWrap(u.pubkey, 1059, t - 1000));
    const othersNote = await publishOk(c, sign(other.sk, { kind: 1, content: "not mine", tags: [["p", u.pubkey]], created_at: t }));
    const later = await publishOk(c, sign(u.sk, { kind: 1, content: "after", created_at: t + 60 }));
    // the relay tag spelled with another scheme and a trailing slash still names this relay
    const vanishUrl = `${relay.ws.replace(/^ws:/, "wss:")}/`;
    expect((await c.publish(sign(u.sk, { kind: 62, content: "bye", tags: [["relay", vanishUrl]], created_at: t + 30 }))).ok).toBe(true);

    const reader = await authed(u.sk);
    expect(await q(reader, [{ ids: [n1.id, del.id, prof.id, wrap.id] }])).toEqual([]);
    expect(ids(await q(reader, [{ ids: [later.id, othersNote.id] }])).sort()).toEqual([later.id, othersNote.id].sort());
    for (const ev of [n1, del, prof, wrap]) {
      const r = await c.publish(ev);
      expect(r.ok).toBe(false);
      expect(r.message).toStartWith("blocked:");
    }
    // a new event older than the request is refused too; a newer one is accepted
    expect((await c.publish(sign(u.sk, { kind: 1, content: "backdated", created_at: t + 29 }))).ok).toBe(false);
    await publishOk(c, sign(u.sk, { kind: 1, content: "new", created_at: now() }));
  });

  test("ALL_RELAYS is honoured; a lowercase variant, another relay's URL or no relay tag are refused and delete nothing", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    const n = await publishOk(c, sign(u.sk, { kind: 1, content: "x", created_at: now() - 10 }));
    for (const tags of [[["relay", "all_relays"]], [["relay", "wss://relay.example.com"]], []]) {
      const r = await c.publish(sign(u.sk, { kind: 62, content: "", tags, created_at: now() - 5 }));
      expect(r.ok).toBe(false);
      expect(r.message).toStartWith("invalid:");
    }
    expect(ids(await q(c, [{ ids: [n.id] }]))).toEqual([n.id]);
    await publishOk(c, sign(u.sk, { kind: 62, content: "", tags: [["relay", "ALL_RELAYS"]], created_at: now() - 5 }));
    expect(await q(c, [{ ids: [n.id] }])).toEqual([]);
  });

  test("only the requester's events are deleted", async () => {
    const c = await cs.connect(relay.ws);
    const [u, other] = [newUser(), newUser()];
    await publishOk(c, sign(u.sk, { kind: 1, content: "x", created_at: now() - 10 }));
    const keep = await publishOk(c, sign(other.sk, { kind: 1, content: "keep", created_at: now() - 10 }));
    await publishOk(c, sign(u.sk, { kind: 62, content: "", tags: [["relay", relay.ws]], created_at: now() - 5 }));
    expect(ids(await q(c, [{ ids: [keep.id] }]))).toEqual([keep.id]);
  });

  // regression: NIP-70 "Relays that want to accept such events MUST first require that the client perform the NIP-42
  // AUTH flow and then check if the authenticated client has the same pubkey". A protected request to vanish re-sent by
  // anyone still takes effect (NIP-62), but must not be stored or relayed.
  test("a protected request to vanish from an unauthenticated connection is not stored or relayed", async () => {
    const c = await cs.connect(relay.ws);
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 1, content: "x", created_at: now() - 10 }));
    const vanish = sign(u.sk, { kind: 62, content: "", tags: [["relay", relay.ws], ["-"]], created_at: now() - 5 });
    await c.publish(vanish);
    expect(await q(c, [{ ids: [vanish.id] }])).toEqual([]);
  });
});

// ------------------------------------------------------------------ NIP-56

describe("NIP-56 reports", () => {
  test("kind 1984 reports are stored and queryable by #p, #e and kind", async () => {
    const c = await cs.connect(relay.ws);
    const [reporter, target] = [newUser(), newUser()];
    const bad = await publishOk(c, sign(target.sk, { kind: 1, content: "spam spam" }));
    const rep = await publishOk(c, sign(reporter.sk, { kind: 1984, content: "", tags: [["e", bad.id, "spam"], ["p", target.pubkey]] }));
    const prof = await publishOk(c, sign(reporter.sk, { kind: 1984, content: "", tags: [["p", target.pubkey, "impersonation"]] }));
    expect(ids(await q(c, [{ kinds: [1984], "#e": [bad.id] }]))).toEqual([rep.id]);
    expect(ids(await q(c, [{ kinds: [1984], "#p": [target.pubkey] }])).sort()).toEqual([rep.id, prof.id].sort());
    expect(ids(await q(c, [{ kinds: [1984], authors: [reporter.pubkey] }])).sort()).toEqual([rep.id, prof.id].sort());
  });
});

// ------------------------------------------------------------------ NIP-70

describe("NIP-70 protected events", () => {
  test("accepted from a connection authenticated as several pubkeys including the author", async () => {
    const author = newUser();
    const c = await authed(newUser().sk, author.sk);
    await publishOk(c, sign(author.sk, { kind: 1, content: "members only", tags: [["-"]] }));
  });

  test("a protected deletion request needs AUTH as its author too", async () => {
    const author = newUser();
    const anon = await cs.connect(relay.ws);
    const n = await publishOk(anon, sign(author.sk, { kind: 1, content: "x" }));
    const del = sign(author.sk, { kind: 5, tags: [["e", n.id], ["-"]] });
    const r = await anon.publish(del);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("auth-required:");
    expect(ids(await q(anon, [{ ids: [n.id] }]))).toEqual([n.id]);
    const mine = await authed(author.sk);
    await publishOk(mine, del);
    expect(await q(anon, [{ ids: [n.id] }])).toEqual([]);
  });

  test("a repost embedding a protected event is refused; one that doesn't embed it is accepted", async () => {
    const [author, reposter] = [newUser(), newUser()];
    const c = await authed(author.sk);
    const prot = await publishOk(c, sign(author.sk, { kind: 1, content: "secret", tags: [["-"]] }));
    const anon = await cs.connect(relay.ws);
    const embed = await anon.publish(sign(reposter.sk, { kind: 6, content: JSON.stringify(prot), tags: [["e", prot.id], ["p", author.pubkey]] }));
    expect(embed.ok).toBe(false);
    await publishOk(anon, sign(reposter.sk, { kind: 6, content: "", tags: [["e", prot.id], ["p", author.pubkey]] }));
  });
});

// ------------------------------------------------------------------ NIP-42

describe("NIP-42 AUTH", () => {
  test("created_at far in the future is refused, a few minutes off is accepted", async () => {
    const c = await cs.connect(relay.ws);
    const ch = await challenge(c);
    const u = newUser();
    expect((await sendAuth(c, authEvent(u.sk, relay.ws, ch, { created_at: now() + 3600 }))).ok).toBe(false);
    expect((await sendAuth(c, authEvent(u.sk, relay.ws, ch, { created_at: now() - 120 }))).ok).toBe(true);
  });

  test("AUTH without a relay tag or without a challenge tag is refused with OK false", async () => {
    const c = await cs.connect(relay.ws);
    const ch = await challenge(c);
    const u = newUser();
    expect((await sendAuth(c, authEvent(u.sk, undefined, ch))).ok).toBe(false);
    expect((await sendAuth(c, authEvent(u.sk, relay.ws, undefined))).ok).toBe(false);
    // nothing was granted: DMs still need AUTH
    expect((await c.query(sub(), [{ kinds: [4] }])).closed).toStartWith("auth-required:");
  });

  test("a malformed AUTH event (bad id) is still answered with OK false", async () => {
    const c = await cs.connect(relay.ws);
    const ch = await challenge(c);
    const ev = authEvent(newUser().sk, relay.ws, ch);
    const bad = { ...ev, content: "tampered" };
    c.send(["AUTH", bad]);
    const m = await c.waitFor(isOk(ev.id));
    expect(m[2]).toBe(false);
  });

  test("AUTH events are never stored nor broadcast", async () => {
    const watcher = await cs.connect(relay.ws);
    const u = newUser();
    const s = sub();
    await watcher.query(s, [{ kinds: [22242] }], false);
    const c = await cs.connect(relay.ws);
    const ch = await challenge(c);
    const ev = authEvent(u.sk, relay.ws, ch);
    expect((await sendAuth(c, ev)).ok).toBe(true);
    await watcher.expectNone(isEventFor(s));
    expect(await q(watcher, [{ ids: [ev.id] }])).toEqual([]);
    expect(await q(watcher, [{ authors: [u.pubkey] }])).toEqual([]);
  });

  test("all pubkeys of a multi-AUTH connection are treated as authenticated for DMs and COUNT", async () => {
    const [alice, bob, carol] = [newUser(), newUser(), newUser()];
    const w = await cs.connect(relay.ws);
    const toAlice = await publishOk(w, sign(carol.sk, { kind: 4, content: "x?iv=y", tags: [["p", alice.pubkey]] }));
    const toBob = await publishOk(w, giftWrap(bob.pubkey));
    const c = await authed(alice.sk, bob.sk);
    expect(ids(await q(c, [{ ids: [toAlice.id, toBob.id] }])).sort()).toEqual([toAlice.id, toBob.id].sort());
    const m = await count(c, [{ kinds: [1059], "#p": [alice.pubkey, bob.pubkey] }]);
    expect(m[0]).toBe("COUNT");
    expect((m[2] as { count: number }).count).toBe(1);
  });
});

// ------------------------------------------------------------------ NIP-04/17/44/59 read gating

describe("DM and gift wrap read gating", () => {
  test("gift wraps are served only to the authenticated p-tagged recipient (not the wrap's signer, not strangers)", async () => {
    const bob = newUser();
    const signer = newUser();
    const wrap = sign(signer.sk, { kind: 1059, created_at: now() - 3600, content: "sealed", tags: [["p", bob.pubkey]] });
    const w = await cs.connect(relay.ws);
    await publishOk(w, wrap);
    expect((await w.query(sub(), [{ kinds: [1059], "#p": [bob.pubkey] }])).closed).toStartWith("auth-required:");
    expect(await q(w, [{ ids: [wrap.id] }])).toEqual([]);
    expect(await q(await authed(newUser().sk), [{ ids: [wrap.id] }])).toEqual([]);
    expect(await q(await authed(signer.sk), [{ ids: [wrap.id] }])).toEqual([]);
    expect(ids(await q(await authed(bob.sk), [{ kinds: [1059], "#p": [bob.pubkey] }]))).toEqual([wrap.id]);
  });

  test("live: gift wraps (1059 and ephemeral 21059) and kind 4 only reach their recipients", async () => {
    const [alice, bob] = [newUser(), newUser()];
    const anon = await cs.connect(relay.ws);
    const stranger = await authed(newUser().sk);
    const bobConn = await authed(bob.sk);
    const sA = sub();
    const sS = sub();
    const sB = sub();
    await anon.query(sA, [{ authors: [alice.pubkey] }, { "#p": [bob.pubkey] }], false);
    await stranger.query(sS, [{ kinds: [4, 1059, 21059] }], false);
    await bobConn.query(sB, [{ kinds: [4, 1059, 21059], "#p": [bob.pubkey] }], false);
    const w = await cs.connect(relay.ws);
    const dm = await publishOk(w, sign(alice.sk, { kind: 4, content: "x?iv=y", tags: [["p", bob.pubkey]] }));
    const wrap = await publishOk(w, giftWrap(bob.pubkey));
    const eph = await publishOk(w, giftWrap(bob.pubkey, 21059, now()));
    for (const id of [dm.id, wrap.id, eph.id]) await bobConn.waitFor(isEventFor(sB, id));
    await anon.expectNone(isEventFor(sA));
    await stranger.expectNone(isEventFor(sS), 50);
  });

  test("mixed REQ without AUTH: gated filters are dropped or filtered, the rest is served", async () => {
    const [alice, bob] = [newUser(), newUser()];
    const w = await cs.connect(relay.ws);
    const t = now() - 30;
    const note = await publishOk(w, sign(alice.sk, { kind: 1, content: "public", created_at: t }));
    const dm = await publishOk(w, sign(alice.sk, { kind: 4, content: "x?iv=y", tags: [["p", bob.pubkey]], created_at: t + 1 }));
    const r1 = await w.query(sub(), [{ kinds: [4], authors: [alice.pubkey] }, { ids: [note.id] }]);
    expect(r1.closed).toBeUndefined();
    expect(ids(r1.events)).toEqual([note.id]);
    expect(ids(await q(w, [{ kinds: [1, 4], authors: [alice.pubkey] }]))).toEqual([note.id]);
    // limit counts visible events only: the newer hidden DM doesn't take the only slot
    expect(ids(await q(w, [{ authors: [alice.pubkey], limit: 1 }]))).toEqual([note.id]);
    void dm;
  });

  test("COUNT: gift wraps only for your own #p, kind 4 for own authors/#p, hidden events subtracted from broad counts", async () => {
    const [alice, bob] = [newUser(), newUser()];
    const w = await cs.connect(relay.ws);
    await publishOk(w, giftWrap(bob.pubkey));
    await publishOk(w, sign(alice.sk, { kind: 4, content: "x?iv=y", tags: [["p", bob.pubkey]] }));
    await publishOk(w, sign(alice.sk, { kind: 1, content: "hi", tags: [["p", bob.pubkey]] }));

    const anon = await cs.connect(relay.ws);
    expect((await count(anon, [{ kinds: [1059], "#p": [bob.pubkey] }]))[2]).toStartWith("auth-required:");
    expect((await count(anon, [{ "#p": [bob.pubkey] }]))[2]).toEqual({ count: 1 });

    const aliceConn = await authed(alice.sk);
    expect((await count(aliceConn, [{ kinds: [1059], "#p": [bob.pubkey] }]))[2]).toStartWith("restricted:");
    expect((await count(aliceConn, [{ kinds: [4], authors: [alice.pubkey] }]))[2]).toEqual({ count: 1 });
    expect((await count(aliceConn, [{ "#p": [bob.pubkey] }]))[2]).toEqual({ count: 2 });

    const bobConn = await authed(bob.sk);
    expect((await count(bobConn, [{ kinds: [1059], "#p": [bob.pubkey] }]))[2]).toEqual({ count: 1 });
    expect((await count(bobConn, [{ kinds: [4], "#p": [bob.pubkey] }]))[2]).toEqual({ count: 1 });
    expect((await count(bobConn, [{ "#p": [bob.pubkey] }]))[2]).toEqual({ count: 3 });
  });

  test("kind 10050 DM relay lists are public", async () => {
    const u = newUser();
    const c = await cs.connect(relay.ws);
    const ev = await publishOk(c, sign(u.sk, { kind: 10050, content: "", tags: [["relay", "wss://inbox.example.com"]] }));
    const anon = await cs.connect(relay.ws);
    expect(ids(await q(anon, [{ kinds: [10050], authors: [u.pubkey] }]))).toEqual([ev.id]);
  });
});
