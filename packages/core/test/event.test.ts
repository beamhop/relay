import { describe, expect, test } from "bun:test";
import type { BusEvents } from "@beamhop/sdk";
import { finalizeEvent } from "nostr-tools/pure";
import { createRelay } from "../src";
import { FakeSocket, keypair, now, setup, sign, tick } from "./fakes";

describe("EVENT", () => {
  test("accepts a valid event, stores it and emits bus events", async () => {
    const { connect, stores, bus } = await setup();
    const accepted: BusEvents["event.accepted"][] = [];
    bus.on("event.accepted", (e) => accepted.push(e));
    const c = connect();
    const kp = keypair();
    const ev = sign(kp);
    expect(await c.publish(ev)).toEqual(["OK", ev.id, true, ""]);
    expect(stores.events.events.has(ev.id)).toBe(true);
    expect(accepted[0]).toMatchObject({ status: "saved", source: "ws" });
    expect((await c.publish(ev))[3]).toMatch(/^duplicate:/);
  });

  test("rejects bad signatures and bad shapes", async () => {
    const { connect } = await setup();
    const c = connect();
    const ev = sign(keypair());
    const forged = { ...ev, content: "tampered" };
    expect(await c.publish(forged)).toEqual(["OK", ev.id, false, "invalid: bad event id or signature"]);
    c.send(["EVENT", { ...ev, kind: "1" }]);
    const ok = await c.socket.waitFor((m) => m[0] === "OK" && m[2] === false && String(m[3]).includes("kind"));
    expect(ok[3]).toMatch(/^invalid:/);
    c.send(["EVENT"]);
    await c.socket.waitFor((m) => m[0] === "NOTICE");
  });

  test("rejects AUTH events sent as EVENT", async () => {
    const { connect } = await setup();
    const c = connect();
    const ev = sign(keypair(), { kind: 22242, tags: [["relay", "wss://relay.example.com"], ["challenge", c.challenge]] });
    expect((await c.publish(ev))[3]).toMatch(/^invalid:/);
  });

  test("size limits", async () => {
    const { connect } = await setup({ settings: { limits: { maxContentLength: 10, maxEventTags: 2, maxMessageBytes: 2000 } } });
    const c = connect();
    const kp = keypair();
    expect((await c.publish(sign(kp, { content: "x".repeat(11) })))[3]).toMatch(/^invalid: content/);
    expect((await c.publish(sign(kp, { tags: [["t", "a"], ["t", "b"], ["t", "c"]] })))[3]).toMatch(/^invalid: too many tags/);
    c.send(["EVENT", sign(kp, { tags: [["x", "y".repeat(3000)]] })]);
    expect((await c.socket.waitFor((m) => m[0] === "OK" && m[2] === false && /message too large/.test(String(m[3]))))[3]).toMatch(/^invalid:/);
  });

  test("created_at bounds", async () => {
    const { connect } = await setup({ settings: { limits: { createdAtLowerSec: 3600 } } });
    const c = connect();
    const kp = keypair();
    expect((await c.publish(sign(kp, { created_at: now() + 3600 })))[3]).toMatch(/future/);
    expect((await c.publish(sign(kp, { created_at: now() - 7200 })))[3]).toMatch(/past/);
  });

  test("NIP-13 proof of work", async () => {
    const { connect } = await setup({ settings: { limits: { minPowDifficulty: 8 } } });
    const c = connect();
    const kp = keypair();
    const weak = sign(kp, { content: "no pow" });
    if (!weak.id.startsWith("00")) expect((await c.publish(weak))[3]).toMatch(/^pow:/);
    // mine 8 bits
    let mined;
    for (let n = 0; ; n++) {
      mined = finalizeEvent({ kind: 1, content: "pow", created_at: now(), tags: [["nonce", String(n), "8"]] }, kp.sk);
      if (mined.id.startsWith("00")) break;
    }
    expect((await c.publish(mined))[2]).toBe(true);
  });

  test("NIP-40: rejects already-expired events; purge job deletes expired", async () => {
    const { connect, stores, relay } = await setup();
    const c = connect();
    const kp = keypair();
    expect((await c.publish(sign(kp, { tags: [["expiration", String(now() - 10)]] })))[3]).toMatch(/expired/);
    const soon = sign(kp, { tags: [["expiration", String(now() + 1)]] });
    expect((await c.publish(soon))[2]).toBe(true);
    stores.events.events.set(soon.id, { ...soon, tags: [["expiration", String(now() - 5)]] });
    await relay.start();
    await tick(20);
    expect(stores.events.events.has(soon.id)).toBe(false);
    await relay.stop();
  });

  test("replaceable events", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const kp = keypair();
    const a = sign(kp, { kind: 0, content: "{}", created_at: now() - 10 });
    const b = sign(kp, { kind: 0, content: '{"name":"x"}', created_at: now() });
    expect((await c.publish(a))[2]).toBe(true);
    expect((await c.publish(b))[2]).toBe(true);
    expect(stores.events.events.has(a.id)).toBe(false);
    const old = sign(kp, { kind: 0, content: "{}", created_at: now() - 100 });
    expect((await c.publish(old))[3]).toMatch(/^duplicate:/);
    const { events } = await c.req("p", { kinds: [0], authors: [kp.pk] });
    expect(events.map((e) => e.id)).toEqual([b.id]);
  });

  test("NIP-09 deletion", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const kp = keypair();
    const note = sign(kp);
    await c.publish(note);
    const other = sign(keypair());
    await c.publish(other);
    const del = sign(kp, { kind: 5, tags: [["e", note.id], ["e", other.id]] });
    expect((await c.publish(del))[2]).toBe(true);
    expect(stores.events.events.has(note.id)).toBe(false);
    expect(stores.events.events.has(other.id)).toBe(true); // not the author's
    expect(stores.events.events.has(del.id)).toBe(true);
    expect((await c.publish(note))[2]).toBe(false); // tombstoned
  });

  test("NIP-62 request to vanish", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const kp = keypair();
    const note = sign(kp, { created_at: now() - 5 });
    await c.publish(note);
    expect((await c.publish(sign(kp, { kind: 62, tags: [["relay", "wss://other.relay"]] })))[3]).toMatch(/^invalid:/);
    const vanish = sign(kp, { kind: 62, tags: [["relay", "wss://relay.example.com/"]] });
    expect((await c.publish(vanish))[2]).toBe(true);
    expect(stores.events.events.has(note.id)).toBe(false);
    expect(stores.events.events.has(vanish.id)).toBe(true);
    expect((await c.publish(note))[3]).toMatch(/^blocked: .*vanish/);
  });

  test("verifier cache never vouches for a tampered copy of a known event", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const ev = sign(keypair(), { content: "original" });
    expect((await c.publish(ev))[2]).toBe(true);
    stores.events.events.delete(ev.id);
    for (const forged of [{ ...ev, content: "tampered" }, { ...ev, kind: 7 }, { ...ev, tags: [["t", "x"]] }]) {
      expect(await c.publish(forged)).toEqual(["OK", ev.id, false, "invalid: bad event id or signature"]);
    }
    expect(stores.events.events.has(ev.id)).toBe(false);
  });

  test("oversized EVENT is answered with OK false, oversized REQ with CLOSED", async () => {
    const { connect } = await setup({ settings: { limits: { maxMessageBytes: 2000 } } });
    const c = connect();
    const ev = sign(keypair(), { tags: [["x", "y".repeat(3000)]] });
    c.send(["EVENT", ev]);
    const ok = await c.socket.waitFor((m) => m[0] === "OK");
    expect(ok.slice(0, 3)).toEqual(["OK", ev.id, false]);
    expect(ok[3]).toMatch(/^invalid: message too large/);
    c.send(["REQ", "big", { "#t": ["z".repeat(3000)] }]);
    expect((await c.socket.waitFor((m) => m[0] === "CLOSED" && m[1] === "big"))[2]).toMatch(/^invalid: message too large/);
  });

  test("max_content_length counts unicode characters", async () => {
    const { connect } = await setup({ settings: { limits: { maxContentLength: 3 } } });
    const c = connect();
    const kp = keypair();
    expect((await c.publish(sign(kp, { content: "😀😀😀" })))[2]).toBe(true);
    expect((await c.publish(sign(kp, { content: "😀😀😀😀" })))[3]).toMatch(/^invalid: content/);
  });

  test("NIP-62 vanish is honoured for banned, muted and non-member users", async () => {
    const { connect, stores } = await setup({ settings: { access: { mode: "whitelist" }, limits: { minPowDifficulty: 30 } } });
    const c = connect();
    for (const status of ["banned", "muted", undefined] as const) {
      const kp = keypair();
      const note = sign(kp, { created_at: now() - 5 });
      await stores.events.save(note);
      if (status) await stores.users.upsert(kp.pk, { status });
      const vanish = sign(kp, { kind: 62, tags: [["relay", "ALL_RELAYS"]] });
      expect(await c.publish(vanish)).toEqual(["OK", vanish.id, true, ""]);
      expect(stores.events.events.has(note.id)).toBe(false);
    }
  });

  test("NIP-62 deletes only up to the request and tombstones gift wraps to the user", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const kp = keypair();
    const old = sign(kp, { created_at: now() - 10 });
    const future = sign(kp, { created_at: now() + 60 });
    const wrap = sign(keypair(), { kind: 1059, tags: [["p", kp.pk]], created_at: now() - 100 });
    for (const e of [old, future, wrap]) await stores.events.save(e);
    expect((await c.publish(sign(kp, { kind: 62, tags: [["relay", "ALL_RELAYS"]] })))[2]).toBe(true);
    expect(stores.events.events.has(old.id)).toBe(false);
    expect(stores.events.events.has(future.id)).toBe(true);
    expect(stores.events.events.has(wrap.id)).toBe(false);
    expect((await c.publish(wrap))[2]).toBe(false);
  });

  test("NIP-09: banned and muted users can delete their events; recipients can delete gift wraps", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    for (const status of ["banned", "muted"] as const) {
      const kp = keypair();
      const note = sign(kp);
      await stores.events.save(note);
      await stores.users.upsert(kp.pk, { status });
      expect((await c.publish(sign(kp, { kind: 5, tags: [["e", note.id]] })))[2]).toBe(true);
      expect(stores.events.events.has(note.id)).toBe(false);
    }
    const bob = keypair();
    const wrap = sign(keypair(), { kind: 1059, tags: [["p", bob.pk]] });
    const notForBob = sign(keypair(), { kind: 1059, tags: [["p", keypair().pk]] });
    await c.publish(wrap);
    await c.publish(notForBob);
    expect((await c.publish(sign(bob, { kind: 5, tags: [["e", wrap.id], ["e", notForBob.id]] })))[2]).toBe(true);
    expect(stores.events.events.has(wrap.id)).toBe(false);
    expect(stores.events.events.has(notForBob.id)).toBe(true);
    expect((await c.publish(wrap))[2]).toBe(false);
  });

  test("NIP-70: reposts embedding a protected event are rejected", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    const prot = sign(kp, { tags: [["-"]] });
    expect((await c.publish(sign(keypair(), { kind: 6, content: JSON.stringify(prot), tags: [["e", prot.id]] })))[3]).toMatch(/^blocked: reposts/);
    expect((await c.publish(sign(keypair(), { kind: 6, content: "", tags: [["e", prot.id]] })))[2]).toBe(true);
  });

  test("bans, deny list and mutes", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const banned = keypair();
    const muted = keypair();
    const denied = keypair();
    await stores.users.upsert(banned.pk, { status: "banned" });
    await stores.users.upsert(muted.pk, { status: "muted" });
    await stores.users.upsert(denied.pk, { denied: true });
    expect((await c.publish(sign(banned)))[3]).toMatch(/^blocked:/);
    expect((await c.publish(sign(denied)))[3]).toMatch(/^blocked:/);
    const m = sign(muted);
    expect(await c.publish(m)).toEqual(["OK", m.id, true, ""]);
    expect(stores.events.events.has(m.id)).toBe(false);
  });

  test("ephemeral events are broadcast but not stored", async () => {
    const { connect, stores } = await setup();
    const a = connect();
    const b = connect();
    await b.req("eph", { kinds: [20001] });
    const ev = sign(keypair(), { kind: 20001 });
    expect((await a.publish(ev))[2]).toBe(true);
    expect(stores.events.events.has(ev.id)).toBe(false);
    await b.socket.waitFor((m) => m[0] === "EVENT" && m[1] === "eph");
  });

  test("whitelist mode with inbound-to-members", async () => {
    const { connect, stores } = await setup({ settings: { access: { mode: "whitelist" } } });
    const c = connect();
    const member = keypair();
    const stranger = keypair();
    await stores.users.upsert(member.pk, { allowed: true });
    expect((await c.publish(sign(member)))[2]).toBe(true);
    expect((await c.publish(sign(stranger)))[3]).toMatch(/^restricted:/);
    expect((await c.publish(sign(stranger, { kind: 1059, tags: [["p", member.pk]] })))[2]).toBe(true);
    const admin = keypair();
    await stores.users.upsert(admin.pk, { role: "moderator" });
    expect((await c.publish(sign(admin)))[2]).toBe(true);
  });

  test("auth-required mode", async () => {
    const { connect } = await setup({ settings: { access: { mode: "auth-required" } } });
    const c = connect();
    const kp = keypair();
    expect((await c.publish(sign(kp)))[3]).toMatch(/^auth-required:/);
    expect((await c.auth(kp))[2]).toBe(true);
    expect((await c.publish(sign(kp)))[2]).toBe(true);
    expect((await c.publish(sign(keypair())))[3]).toMatch(/^restricted:/);
    expect((await c.publish(sign(keypair(), { kind: 1059, tags: [["p", kp.pk]] })))[2]).toBe(true);
  });

  test("authForWrite flag", async () => {
    const { connect } = await setup({ settings: { access: { authForWrite: true } } });
    const c = connect();
    const kp = keypair();
    expect((await c.publish(sign(kp)))[3]).toMatch(/^auth-required:/);
    await c.auth(kp);
    expect((await c.publish(sign(keypair())))[2]).toBe(true); // public mode: any author once authed
  });

  test("NIP-70 protected events", async () => {
    const { connect } = await setup();
    const c = connect();
    const kp = keypair();
    const ev = sign(kp, { tags: [["-"]] });
    expect((await c.publish(ev))[3]).toMatch(/^auth-required:/);
    await c.auth(keypair());
    expect((await c.publish(ev))[3]).toMatch(/^restricted:/);
    await c.auth(kp);
    expect((await c.publish(ev))[2]).toBe(true);
  });

  test("rate limiting with per-user override", async () => {
    const { connect, stores } = await setup({ settings: { limits: { eventsPerMinute: 3 } } });
    const c = connect();
    const kp = keypair();
    for (let i = 0; i < 3; i++) expect((await c.publish(sign(kp, { content: `n${i}` })))[2]).toBe(true);
    expect((await c.publish(sign(kp, { content: "n4" })))[3]).toMatch(/^rate-limited:/);
    const vip = keypair();
    await stores.users.upsert(vip.pk, { rateLimit: { eventsPerMinute: 100 } });
    for (let i = 0; i < 6; i++) expect((await c.publish(sign(vip, { content: `v${i}` })))[2]).toBe(true);
  });

  test("plugin write hooks: reject, shadow, replace, accept bypasses content policy", async () => {
    const { connect, hooks, stores } = await setup({ settings: { moderation: { kindBlocklist: [7] } } });
    const c = connect();
    const kp = keypair();
    const replacement = sign(kp, { content: "replaced" });
    hooks.onWrite((e) => {
      if (e.content === "spam") return { action: "reject", reason: "no spam" };
      if (e.content === "hide") return { action: "shadow" };
      if (e.content === "swap") return { action: "replace", event: replacement };
      if (e.kind === 7 && e.content === "vip") return { action: "accept" };
    }, "test");
    expect((await c.publish(sign(kp, { content: "spam" })))[3]).toBe("blocked: no spam");
    const hidden = sign(kp, { content: "hide" });
    expect((await c.publish(hidden))[2]).toBe(true);
    expect(stores.events.events.has(hidden.id)).toBe(false);
    expect((await c.publish(sign(kp, { content: "swap" })))[2]).toBe(true);
    expect(stores.events.events.has(replacement.id)).toBe(true);
    expect((await c.publish(sign(kp, { kind: 7, content: "+" })))[3]).toMatch(/^blocked: kind 7/);
    expect((await c.publish(sign(kp, { kind: 7, content: "vip" })))[2]).toBe(true);
  });

  test("word filters: reject, shadow, report; recompiled on settings change", async () => {
    const { connect, stores, settings, bus } = await setup({
      settings: {
        moderation: {
          wordFilters: [
            { id: "a", pattern: "badword", isRegex: false, kinds: [], action: "reject", enabled: true },
            { id: "b", pattern: "^shh+$", isRegex: true, kinds: [1], action: "shadow", enabled: true },
            { id: "c", pattern: "watch", isRegex: false, kinds: [], action: "report", enabled: true },
          ],
        },
      },
    });
    const alerts: unknown[] = [];
    bus.on("alert", (a) => alerts.push(a));
    const c = connect();
    const kp = keypair();
    expect((await c.publish(sign(kp, { content: "a BADWORD here" })))[3]).toMatch(/^blocked:/);
    const sh = sign(kp, { content: "shhhh" });
    expect((await c.publish(sh))[2]).toBe(true);
    expect(stores.events.events.has(sh.id)).toBe(false);
    const w = sign(kp, { content: "watch this" });
    expect((await c.publish(w))[2]).toBe(true);
    expect(stores.events.events.has(w.id)).toBe(true);
    expect(alerts.length).toBe(1);
    await settings.update({ moderation: { wordFilters: [] } });
    expect((await c.publish(sign(kp, { content: "badword again" })))[2]).toBe(true);
  });

  test("reports emit report.created; auto-ban after threshold of member reports", async () => {
    const { connect, stores, bus } = await setup({ settings: { moderation: { autoBanReportThreshold: 2 } } });
    const reports: unknown[] = [];
    bus.on("report.created", (r) => reports.push(r));
    const c = connect();
    const target = keypair();
    const r1 = keypair();
    const r2 = keypair();
    await stores.users.upsert(r1.pk, { allowed: true });
    await stores.users.upsert(r2.pk, { allowed: true });
    await c.publish(sign(r1, { kind: 1984, tags: [["p", target.pk, "spam"]] }));
    expect(reports.length).toBe(1);
    expect((await stores.users.get(target.pk))?.status).not.toBe("banned");
    await c.publish(sign(r2, { kind: 1984, tags: [["p", target.pk, "spam"]] }));
    expect((await stores.users.get(target.pk))?.status).toBe("banned");
    expect((await c.publish(sign(target)))[3]).toMatch(/^blocked:/);
  });

  test("publish() runs the pipeline without a connection", async () => {
    const { relay, stores } = await setup({ settings: { access: { mode: "whitelist" } } });
    const ev = sign(keypair());
    expect(await relay.publish(ev, "api")).toEqual({ ok: true, message: "" });
    expect(stores.events.events.has(ev.id)).toBe(true);
    expect((await relay.publish({ ...ev, sig: "00".repeat(64) }, "import")).ok).toBe(false);
  });
});

describe("connections", () => {
  test("blocked IPs (CIDR v4/v6) are rejected with NOTICE + close", async () => {
    const { deps, stores } = await setup();
    await stores.ipRules.add({ cidr: "10.0.0.0/8", action: "block", reason: "abuse" });
    await stores.ipRules.add({ cidr: "2001:db8::/32", action: "block", reason: "" });
    const relay = await createRelay(deps); // rules are loaded at creation and refreshed on an interval
    const s1 = new FakeSocket();
    relay.handleConnection(s1, { ip: "10.9.8.7" });
    expect(s1.of("NOTICE")[0][1]).toBe("blocked: abuse");
    expect(s1.closed).not.toBeNull();
    const s2 = new FakeSocket();
    relay.handleConnection(s2, { ip: "2001:db8:1::5" });
    expect(s2.closed).not.toBeNull();
    const s3 = new FakeSocket();
    relay.handleConnection(s3, { ip: "::ffff:192.168.0.1" });
    expect(s3.closed).toBeNull();
    expect(relay.connections().length).toBe(1);
  });

  test("connectionsPerIp limit", async () => {
    const { connect, relay } = await setup({ settings: { limits: { connectionsPerIp: 2 } } });
    const a = connect("5.5.5.5");
    connect("5.5.5.5");
    const c = connect("5.5.5.5");
    expect(c.socket.closed).not.toBeNull();
    expect(c.socket.of("NOTICE")[0][1]).toMatch(/^rate-limited:/);
    a.handle.onClose();
    expect(connect("5.5.5.5").socket.closed).toBeNull();
    expect(relay.connections().length).toBe(2);
  });

  test("disconnect by pubkey / ip and stop()", async () => {
    const { connect, relay } = await setup();
    const kp = keypair();
    const a = connect("7.7.7.7");
    await a.auth(kp);
    const b = connect("8.8.8.8");
    expect(relay.connections().find((x) => x.id === a.handle.id)?.authedPubkeys).toEqual([kp.pk]);
    expect(relay.disconnect({ pubkey: kp.pk })).toBe(1);
    expect(a.socket.closed).not.toBeNull();
    expect(a.socket.of("NOTICE").length).toBe(1);
    expect(relay.disconnect({ ip: "8.8.8.8" })).toBe(1);
    expect(b.socket.closed).not.toBeNull();
    const c = connect();
    await relay.stop();
    expect(c.socket.closed?.code).toBe(1001);
    expect(relay.connections().length).toBe(0);
  });
});
