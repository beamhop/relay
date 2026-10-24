/** Moderation actions from the admin API and moderation settings, verified over the websocket. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser, sign } from "../harness/client";
import { api, connectAuthed, fetchIds, nextSub, note, ownerApi, waitClosed, withSettings } from "./policy-helpers";

let relay: Relay;
let reader: RelayClient;
beforeAll(async () => {
  relay = await startRelay();
  reader = await RelayClient.connect(relay.ws);
});
afterAll(async () => {
  reader?.close();
  await relay?.stop();
});

async function publishOk(c: RelayClient, sk: Uint8Array, content?: string) {
  const ev = note(sk, content);
  const r = await c.publish(ev);
  expect(r).toEqual({ ok: true, message: "" });
  return ev;
}

describe("ban / unban", () => {
  test("banned pubkey's EVENTs are rejected with blocked: and the ban reason", async () => {
    const u = newUser();
    const c = await RelayClient.connect(relay.ws);
    await publishOk(c, u.sk);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/ban`, { reason: "spam bot" });
    const r = await c.publish(note(u.sk));
    expect(r.ok).toBe(false);
    expect(r.message).toBe("blocked: pubkey is banned (spam bot)");
    c.close();
  });

  test("ban without deleteEvents keeps existing events readable; deleteEvents removes them", async () => {
    const keep = newUser();
    const wipe = newUser();
    const c = await RelayClient.connect(relay.ws);
    const k1 = await publishOk(c, keep.sk);
    const w1 = await publishOk(c, wipe.sk);
    const w2 = await publishOk(c, wipe.sk);
    await ownerApi(relay, "POST", `/users/${keep.pubkey}/ban`, {});
    await ownerApi(relay, "POST", `/users/${wipe.pubkey}/ban`, { deleteEvents: true });
    expect(await fetchIds(reader, [k1.id])).toEqual([k1.id]);
    expect(await fetchIds(reader, [w1.id, w2.id])).toEqual([]);
    const q = await reader.query(nextSub(), [{ authors: [wipe.pubkey] }]);
    expect(q.events).toEqual([]);
    c.close();
  });

  test("ban disconnects the user's authenticated sessions by default; anonymous sessions stay", async () => {
    const u = newUser();
    const authed = await connectAuthed(relay, u.sk);
    const anon = await RelayClient.connect(relay.ws);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/ban`, {});
    await waitClosed(authed);
    expect(authed.inbox.some((m) => m[0] === "NOTICE" && String(m[1]).startsWith("blocked:"))).toBe(true);
    expect(authed.closeCode).toBe(1008);
    await Bun.sleep(100);
    expect(anon.closed).toBe(false);
    // but nothing they sign is accepted through it
    expect((await anon.publish(note(u.sk))).message).toStartWith("blocked:");
    anon.close();
  });

  test("ban with disconnect:false keeps the session open but its EVENTs are refused", async () => {
    const u = newUser();
    const authed = await connectAuthed(relay, u.sk);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/ban`, { disconnect: false });
    await Bun.sleep(100);
    expect(authed.closed).toBe(false);
    expect((await authed.publish(note(u.sk))).message).toStartWith("blocked: pubkey is banned");
    authed.close();
  });

  test("unban restores publishing immediately", async () => {
    const u = newUser();
    const c = await RelayClient.connect(relay.ws);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/ban`, {});
    expect((await c.publish(note(u.sk))).ok).toBe(false);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/unban`);
    await publishOk(c, u.sk);
    c.close();
  });

  test("a banned user can still delete their own events (NIP-09) — deletion applies but isn't stored", async () => {
    const u = newUser();
    const c = await RelayClient.connect(relay.ws);
    const ev = await publishOk(c, u.sk);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/ban`, {});
    const del = sign(u.sk, { kind: 5, tags: [["e", ev.id]] });
    const r = await c.publish(del);
    expect(r.ok).toBe(true);
    expect(await fetchIds(reader, [ev.id, del.id])).toEqual([]);
    c.close();
  });

  test("live subscribers stop receiving a pubkey's events once it is banned", async () => {
    const u = newUser();
    const sub = nextSub();
    const live = await RelayClient.connect(relay.ws);
    await live.query(sub, [{ authors: [u.pubkey] }], false);
    const c = await RelayClient.connect(relay.ws);
    const before = await publishOk(c, u.sk);
    await live.waitFor((m) => m[0] === "EVENT" && m[1] === sub && (m[2] as any).id === before.id);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/ban`, {});
    const after = note(u.sk);
    await c.publish(after);
    await live.expectNone((m) => m[0] === "EVENT" && (m[2] as any).id === after.id, 200);
    live.close();
    c.close();
  });

  test("admin disconnect by pubkey closes that user's authenticated connections only", async () => {
    const u = newUser();
    const mine = await connectAuthed(relay, u.sk);
    const other = await connectAuthed(relay, newUser().sk);
    const r = await ownerApi(relay, "POST", "/connections/disconnect", { pubkey: u.pubkey });
    expect(r.closed).toBe(1);
    await waitClosed(mine);
    expect(other.closed).toBe(false);
    other.close();
  });
});

describe("NIP-56 auto-ban / NIP-62 vanish", () => {
  test("autoBanReportThreshold bans a pubkey after reports from that many distinct members", async () => {
    const target = newUser();
    const r1 = newUser();
    const r2 = newUser();
    const outsider = newUser();
    for (const r of [r1, r2]) await ownerApi(relay, "POST", "/users", { pubkey: r.pubkey, allowed: true });
    await withSettings(relay, { moderation: { autoBanReportThreshold: 2 } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      const report = (by: typeof r1) => sign(by.sk, { kind: 1984, content: "spam", tags: [["p", target.pubkey, "spam"]] });
      // a non-member's report doesn't count
      expect((await c.publish(report(outsider))).ok).toBe(true);
      expect((await c.publish(report(r1))).ok).toBe(true);
      await Bun.sleep(100);
      expect((await c.publish(note(target.sk))).ok).toBe(true);
      expect((await c.publish(report(r2))).ok).toBe(true);
      let msg = "";
      for (let i = 0; i < 100; i++) {
        msg = (await c.publish(note(target.sk))).message;
        if (msg.startsWith("blocked:")) break;
        await Bun.sleep(20);
      }
      expect(msg).toStartWith("blocked: pubkey is banned");
      c.close();
    });
  });

  test("a banned user's request to vanish still deletes their events", async () => {
    const u = newUser();
    const c = await RelayClient.connect(relay.ws);
    const ev = await publishOk(c, u.sk);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/ban`, {});
    const vanish = sign(u.sk, { kind: 62, content: "bye", tags: [["relay", relay.ws]] });
    expect((await c.publish(vanish)).ok).toBe(true);
    expect(await fetchIds(reader, [ev.id])).toEqual([]);
    c.close();
  });
});

describe("mute / deny", () => {
  test("muted pubkey gets OK true but the event is neither stored nor fanned out; unmute restores", async () => {
    const u = newUser();
    const sub = nextSub();
    const live = await RelayClient.connect(relay.ws);
    await live.query(sub, [{ authors: [u.pubkey] }], false);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/mute`);
    const c = await RelayClient.connect(relay.ws);
    const shadowed = note(u.sk);
    expect(await c.publish(shadowed)).toEqual({ ok: true, message: "" });
    await live.expectNone((m) => m[0] === "EVENT" && m[1] === sub, 200);
    expect(await fetchIds(reader, [shadowed.id])).toEqual([]);
    await ownerApi(relay, "POST", `/users/${u.pubkey}/unmute`);
    const visible = await publishOk(c, u.sk);
    await live.waitFor((m) => m[0] === "EVENT" && m[1] === sub && (m[2] as any).id === visible.id);
    expect(await fetchIds(reader, [visible.id])).toEqual([visible.id]);
    live.close();
    c.close();
  });

  test("unban does not lift a mute", async () => {
    const u = newUser();
    await ownerApi(relay, "POST", `/users/${u.pubkey}/mute`);
    const view = await ownerApi(relay, "POST", `/users/${u.pubkey}/unban`);
    expect(view.status).toBe("muted");
    const c = await RelayClient.connect(relay.ws);
    const ev = note(u.sk);
    expect((await c.publish(ev)).ok).toBe(true);
    expect(await fetchIds(reader, [ev.id])).toEqual([]);
    c.close();
  });

  test("deny-listed pubkey is refused; undeny restores", async () => {
    const u = newUser();
    const c = await RelayClient.connect(relay.ws);
    await ownerApi(relay, "PATCH", `/users/${u.pubkey}`, { denied: true });
    const r = await c.publish(note(u.sk));
    expect(r.ok).toBe(false);
    expect(r.message).toBe("blocked: pubkey is not allowed on this relay");
    await ownerApi(relay, "PATCH", `/users/${u.pubkey}`, { denied: false });
    await publishOk(c, u.sk);
    c.close();
  });

  test("bulk ban applies to every listed pubkey", async () => {
    const a = newUser();
    const b = newUser();
    const res = await ownerApi(relay, "POST", "/users/bulk", { pubkeys: [a.pubkey, b.pubkey], action: "ban" });
    expect(res.ok).toBe(2);
    const c = await RelayClient.connect(relay.ws);
    expect((await c.publish(note(a.sk))).message).toStartWith("blocked:");
    expect((await c.publish(note(b.sk))).message).toStartWith("blocked:");
    c.close();
  });

  test("a moderator cannot ban an owner, and the owner keeps publishing", async () => {
    const mod = newUser();
    await ownerApi(relay, "PUT", `/users/${mod.pubkey}/role`, { role: "moderator" });
    const r = await api(relay, mod.sk, "POST", `/users/${relay.owner.pubkey}/ban`, {});
    expect(r.status).toBe(403);
    const c = await RelayClient.connect(relay.ws);
    await publishOk(c, relay.owner.sk);
    c.close();
  });
});

describe("admin content deletion", () => {
  test("DELETE /events/:id removes the event from REQ results", async () => {
    const u = newUser();
    const c = await RelayClient.connect(relay.ws);
    const ev = await publishOk(c, u.sk);
    const r = await ownerApi(relay, "DELETE", `/events/${ev.id}`);
    expect(r.deleted).toBe(1);
    expect(await fetchIds(reader, [ev.id])).toEqual([]);
    c.close();
  });

  test("POST /events/delete by filter removes matching events only", async () => {
    const u = newUser();
    const other = newUser();
    const c = await RelayClient.connect(relay.ws);
    const a = await publishOk(c, u.sk);
    const b = await publishOk(c, u.sk);
    const keep = await publishOk(c, other.sk);
    await ownerApi(relay, "POST", "/events/delete", { filters: [{ authors: [u.pubkey] }] });
    expect(await fetchIds(reader, [a.id, b.id, keep.id])).toEqual([keep.id]);
    c.close();
  });
});

describe("access modes", () => {
  test("whitelist: non-members are restricted until allow-listed, then restricted again when removed", async () => {
    const u = newUser();
    await withSettings(relay, { access: { mode: "whitelist" } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      const r = await c.publish(note(u.sk));
      expect(r.ok).toBe(false);
      expect(r.message).toBe("restricted: you are not a member of this relay");
      await ownerApi(relay, "POST", "/users", { pubkey: u.pubkey, allowed: true });
      await publishOk(c, u.sk);
      await ownerApi(relay, "PATCH", `/users/${u.pubkey}`, { allowed: false });
      expect((await c.publish(note(u.sk))).message).toStartWith("restricted:");
      // the configured owner is always a member
      await publishOk(c, relay.owner.sk);
      c.close();
    });
  });

  test("whitelist inbound: a non-member may p-tag a member with a note, not with other kinds", async () => {
    const member = newUser();
    const outsider = newUser();
    await withSettings(relay, { access: { mode: "whitelist", allowInboundToMembers: true } }, async () => {
      await ownerApi(relay, "POST", "/users", { pubkey: member.pubkey, allowed: true });
      const c = await RelayClient.connect(relay.ws);
      const reply = sign(outsider.sk, { kind: 1, content: "hi member", tags: [["p", member.pubkey]] });
      expect((await c.publish(reply)).ok).toBe(true);
      const profile = sign(outsider.sk, { kind: 0, content: "{}", tags: [["p", member.pubkey]] });
      expect((await c.publish(profile)).message).toStartWith("restricted:");
      c.close();
    });
    await withSettings(relay, { access: { mode: "whitelist", allowInboundToMembers: false } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      const reply = sign(outsider.sk, { kind: 1, content: "hi again", tags: [["p", member.pubkey]] });
      expect((await c.publish(reply)).message).toStartWith("restricted:");
      c.close();
    });
  });

  test("invite mode refuses non-members with an invite hint", async () => {
    await withSettings(relay, { access: { mode: "invite" } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      const r = await c.publish(note(newUser().sk));
      expect(r.ok).toBe(false);
      expect(r.message).toStartWith("restricted: this relay is invite-only");
      c.close();
    });
  });
});

describe("content policies (moderation settings)", () => {
  test("kind blocklist rejects that kind only", async () => {
    const u = newUser();
    await withSettings(relay, { moderation: { kindBlocklist: [7] } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      const r = await c.publish(sign(u.sk, { kind: 7, content: "+" }));
      expect(r).toEqual({ ok: false, message: "blocked: kind 7 is not allowed on this relay" });
      await publishOk(c, u.sk);
      c.close();
    });
  });

  test("kind allowlist rejects every kind not listed", async () => {
    const u = newUser();
    await withSettings(relay, { moderation: { kindAllowlist: [1] } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      await publishOk(c, u.sk);
      expect((await c.publish(sign(u.sk, { kind: 30023, content: "x", tags: [["d", "a"]] }))).message).toBe("blocked: kind 30023 is not allowed on this relay");
      c.close();
    });
  });

  test("plain word filter rejects case-insensitively; disabled filter is ignored", async () => {
    const u = newUser();
    const wordFilters = [
      { id: "wf-casino", pattern: "casino", action: "reject" },
      { id: "wf-off", pattern: "harmless", action: "reject", enabled: false },
    ];
    await withSettings(relay, { moderation: { wordFilters } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      const r = await c.publish(note(u.sk, "Visit our CASINO now"));
      expect(r).toEqual({ ok: false, message: "blocked: content not allowed by relay policy" });
      await publishOk(c, u.sk, "harmless words");
      c.close();
    });
  });

  test("regex word filter, scoped to kinds", async () => {
    const u = newUser();
    const wordFilters = [{ id: "wf-btc", pattern: "bc1[a-z0-9]{8,}", isRegex: true, kinds: [1], action: "reject" }];
    await withSettings(relay, { moderation: { wordFilters } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      expect((await c.publish(note(u.sk, "send to bc1qxyzabcdef0123"))).ok).toBe(false);
      // other kinds are not filtered
      const longform = sign(u.sk, { kind: 30023, content: "send to bc1qxyzabcdef0123", tags: [["d", "x"]] });
      expect((await c.publish(longform)).ok).toBe(true);
      c.close();
    });
  });

  test("shadow word filter: OK true, but not stored", async () => {
    const u = newUser();
    await withSettings(relay, { moderation: { wordFilters: [{ id: "wf-shadow", pattern: "shadowme", action: "shadow" }] } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      const ev = note(u.sk, "please shadowme");
      expect((await c.publish(ev)).ok).toBe(true);
      expect(await fetchIds(reader, [ev.id])).toEqual([]);
      c.close();
    });
  });

  test("report word filter: stored, and a report about it shows up for moderators", async () => {
    const u = newUser();
    await withSettings(relay, { moderation: { wordFilters: [{ id: "wf-report", pattern: "flagword", action: "report" }] } }, async () => {
      const c = await RelayClient.connect(relay.ws);
      const ev = await publishOk(c, u.sk, "this has a flagword in it");
      expect(await fetchIds(reader, [ev.id])).toEqual([ev.id]);
      let found = false;
      for (let i = 0; i < 100 && !found; i++) {
        const reps = await ownerApi(relay, "GET", `/reports?target=${ev.id}`);
        found = reps.items.some((r: any) => r.targetEventId === ev.id);
        if (!found) await Bun.sleep(20);
      }
      expect(found).toBe(true);
      c.close();
    });
  });

  test("a catastrophic-backtracking regex is refused at save time", async () => {
    const r = await api(relay, relay.owner.sk, "PATCH", "/settings", { moderation: { wordFilters: [{ id: "bad", pattern: "(a+)+$", isRegex: true }] } });
    expect(r.status).toBe(400);
  });
});
