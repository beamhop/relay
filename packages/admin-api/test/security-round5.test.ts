import { describe, expect, test } from "bun:test";
import type { ReportView } from "@beamhop/sdk";
import { totpCode } from "../src/util/totp";
import { createHarness, newKey, nip98Header, PUBLIC_URL, signEvent, type Key } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;
type View = ReportView & { claimedPubkey?: string };

const profile = (k: Key, name: string) => signEvent(k, 0, [], JSON.stringify({ name }));
const statusOf = async (h: Harness, pk: string) => (await h.stores.users.get(pk))?.status ?? "active";

// ------------------------------------------------------------------ reports: who gets banned

describe("report resolution bans the reported content's author", () => {
  /** Bob's spam, reported by someone whose `p` tag names Alice instead. */
  async function mismatched(h: Harness) {
    const bob = newKey();
    const alice = newKey();
    const spam = signEvent(bob, 1, [], "buy now");
    await h.events.save(spam);
    const report = signEvent(newKey(), 1984, [["e", spam.id, "spam"], ["p", alice.pk]]);
    await h.events.save(report);
    return { bob, alice, spam, report };
  }

  test("the view names the author and flags the `p` pubkey as a claim", async () => {
    const h = await createHarness();
    const { bob, alice, report } = await mismatched(h);
    const view = (await (await h.asKey(h.owner, `/reports/${report.id}`)).json()) as View;
    expect(view.targetPubkey).toBe(bob.pk);
    expect(view.claimedPubkey).toBe(alice.pk);
    const list = (await (await h.asKey(h.owner, "/reports")).json()) as { items: View[] };
    expect(list.items[0]).toMatchObject({ targetPubkey: bob.pk, claimedPubkey: alice.pk });
  });

  test("delete & ban deletes Bob's spam and bans Bob, not Alice", async () => {
    const h = await createHarness();
    const { bob, alice, spam, report } = await mismatched(h);
    const res = await h.asKey(h.owner, `/reports/${report.id}/resolve`, { method: "POST", body: { action: "delete-and-ban" } });
    expect(res.status).toBe(200);
    expect(await h.events.getById(spam.id)).toBeUndefined();
    expect(await statusOf(h, bob.pk)).toBe("banned");
    expect(await statusOf(h, alice.pk)).toBe("active");
    expect(h.audit.entries.find((e) => e.action === "report.resolve")?.details).toMatchObject({ banned: bob.pk, claimedPubkey: alice.pk });
  });

  test("bulk resolve picks the same target", async () => {
    const h = await createHarness();
    const a = await mismatched(h);
    const b = await mismatched(h);
    const res = await h.asKey(h.owner, "/reports/bulk-resolve", { method: "POST", body: { ids: [a.report.id, b.report.id], action: "ban-user" } });
    expect(((await res.json()) as { ok: number }).ok).toBe(2);
    for (const r of [a, b]) {
      expect(await statusOf(h, r.bob.pk)).toBe("banned");
      expect(await statusOf(h, r.alice.pk)).toBe("active");
    }
  });

  test("the rank check covers the author, whoever the `p` tag names", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const user = newKey();
    // the admin's post reported under a nobody's name: a moderator can't ban (or delete) it through the report
    const post = signEvent(admin, 1, [], "admin post");
    await h.events.save(post);
    const r1 = signEvent(newKey(), 1984, [["e", post.id, "spam"], ["p", user.pk]]);
    await h.events.save(r1);
    for (const action of ["ban-user", "delete-and-ban"])
      expect((await h.asKey(mod, `/reports/${r1.id}/resolve`, { method: "POST", body: { action } })).status).toBe(403);
    expect(await statusOf(h, user.pk)).toBe("active");
    expect(await h.events.getById(post.id)).toBeTruthy();
    // a nobody's post reported under the admin's name: the nobody is banned, the admin untouched
    const spam = signEvent(user, 1, [], "spam");
    await h.events.save(spam);
    const r2 = signEvent(newKey(), 1984, [["e", spam.id, "spam"], ["p", admin.pk]]);
    await h.events.save(r2);
    expect((await h.asKey(mod, `/reports/${r2.id}/resolve`, { method: "POST", body: { action: "ban-user" } })).status).toBe(200);
    expect(await statusOf(h, user.pk)).toBe("banned");
    expect(await statusOf(h, admin.pk)).toBe("active");
  });

  test("an event report without a `p` tag bans the author", async () => {
    const h = await createHarness();
    const bob = newKey();
    const spam = signEvent(bob, 1, [], "x");
    await h.events.save(spam);
    const report = signEvent(newKey(), 1984, [["e", spam.id, "spam"]]);
    await h.events.save(report);
    expect((await h.asKey(h.owner, `/reports/${report.id}/resolve`, { method: "POST", body: { action: "ban-user" } })).status).toBe(200);
    expect(await statusOf(h, bob.pk)).toBe("banned");
  });

  test("`p`-only reports, and reports of events no longer stored, still go by the `p` tag", async () => {
    const h = await createHarness();
    const carol = newKey();
    const dave = newKey();
    const pOnly = signEvent(newKey(), 1984, [["p", carol.pk, "impersonation"]]);
    const gone = signEvent(newKey(), 1984, [["e", "a".repeat(64), "spam"], ["p", dave.pk]]);
    for (const r of [pOnly, gone]) await h.events.save(r);
    const view = (await (await h.asKey(h.owner, `/reports/${gone.id}`)).json()) as View;
    expect(view.targetPubkey).toBe(dave.pk);
    expect(view.claimedPubkey).toBeUndefined();
    const res = await h.asKey(h.owner, "/reports/bulk-resolve", { method: "POST", body: { ids: [pOnly.id, gone.id], action: "ban-user" } });
    expect(((await res.json()) as { ok: number }).ok).toBe(2);
    expect(await statusOf(h, carol.pk)).toBe("banned");
    expect(await statusOf(h, dave.pk)).toBe("banned");
  });

  test("blob reports: the uploader is the target, a `p` tag naming someone else is not", async () => {
    const h = await createHarness();
    const bob = newKey();
    const alice = newKey();
    const blob = (sha: string, owners: string[]) =>
      h.blossom!.blobs.set(sha, { sha256: sha, size: 1, type: "image/png", owners, createdAt: 1, status: "approved", hasThumbnail: false, url: "" });
    const [solo, shared, both] = ["1", "2", "3"].map((c) => c.repeat(64));
    blob(solo, [bob.pk]);
    blob(shared, [bob.pk, newKey().pk]);
    blob(both, [bob.pk, alice.pk]);
    const report = (sha: string) => signEvent(newKey(), 1984, [["x", sha, "nudity"], ["p", alice.pk]]);
    const [rSolo, rShared, rBoth] = [report(solo), report(shared), report(both)];
    for (const r of [rSolo, rShared, rBoth]) await h.events.save(r);

    expect((await (await h.asKey(h.owner, `/reports/${rSolo.id}`)).json()) as View).toMatchObject({ targetPubkey: bob.pk, claimedPubkey: alice.pk });
    // several uploaders, none of them the named pubkey: nobody to ban from the report
    expect((await (await h.asKey(h.owner, `/reports/${rShared.id}`)).json()) as View).toMatchObject({ targetPubkey: "", claimedPubkey: alice.pk });
    expect((await h.asKey(h.owner, `/reports/${rShared.id}/resolve`, { method: "POST", body: { action: "ban-user" } })).status).toBe(400);
    expect(await statusOf(h, alice.pk)).toBe("active");
    expect(await statusOf(h, bob.pk)).toBe("active");

    expect((await h.asKey(h.owner, `/reports/${rSolo.id}/resolve`, { method: "POST", body: { action: "ban-user" } })).status).toBe(200);
    expect(await statusOf(h, bob.pk)).toBe("banned");
    expect(await statusOf(h, alice.pk)).toBe("active");
    // the named pubkey is one of the uploaders: it stands
    expect((await h.asKey(h.owner, `/reports/${rBoth.id}/resolve`, { method: "POST", body: { action: "ban-user" } })).status).toBe(200);
    expect(await statusOf(h, alice.pk)).toBe("banned");
  });

  test("push notifications name the author", async () => {
    const bodies: string[] = [];
    const h = await createHarness({ pushSender: async (_s, payload) => void bodies.push((JSON.parse(payload) as { body: string }).body) });
    const sub = { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/o", keys: { p256dh: "k", auth: "a" } } };
    expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub })).status).toBe(200);
    const bob = newKey();
    const alice = newKey();
    await h.events.save(profile(bob, "Bob"));
    await h.events.save(profile(alice, "Alice"));
    const spam = signEvent(bob, 1, [], "buy now");
    await h.events.save(spam);
    await h.relay.publish(signEvent(newKey(), 1984, [["e", spam.id, "spam"], ["p", alice.pk]]), "api");
    await Bun.sleep(20);
    expect(bodies).toEqual(["Bob"]);
  });
});

// ------------------------------------------------------------------ SSE stream revocation

/** Reads until the stream ends; false if it is still open after `ms`. */
async function endsWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms = 1500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!r) break;
    if (r.done) return true;
  }
  await reader.cancel().catch(() => {});
  return false;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, ms = 1500): Promise<string> {
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  while (!buf.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timeout; got: ${buf}`);
    const r = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!r || r.done) break;
    buf += dec.decode(r.value, { stream: true });
  }
  return buf;
}

describe("SSE stream ends when its authorization does", () => {
  const open = async (res: Response | Promise<Response>) => {
    const r = await res;
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    await readUntil(reader, "event: snapshot");
    return reader;
  };

  test("logout closes the session's stream; an authorized one stays open", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    const other = await h.login(h.owner);
    const reader = await open(h.req("/stream", { headers: { cookie } }));
    const kept = await open(h.req("/stream", { headers: { cookie: other } }));
    await Bun.sleep(150); // a few re-checks pass while still authorized
    h.bus.emit("alert", { level: "info", title: "still here", message: "" });
    expect(await readUntil(reader, "still here")).toContain("event: alert");
    expect((await h.withCookie(cookie, "/auth/logout", { method: "POST" })).status).toBe(200);
    expect(await endsWithin(reader)).toBe(true);
    h.bus.emit("alert", { level: "info", title: "other session", message: "" });
    expect(await readUntil(kept, "other session")).toContain("event: alert");
    await kept.cancel();
  });

  test("a password change ends the other sessions' streams", async () => {
    const h = await createHarness();
    const stolen = await h.login(h.owner);
    const reader = await open(h.req("/stream?events=1", { headers: { cookie: stolen } }));
    const mine = await h.login(h.owner);
    expect((await h.withCookie(mine, "/auth/password/set", { method: "POST", body: { password: "brand-new-password" } })).status).toBe(200);
    expect(await endsWithin(reader)).toBe(true);
  });

  test("removing the role ends the stream", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const reader = await open(h.req("/stream", { headers: { cookie: await h.login(mod) } }));
    expect((await h.asKey(h.owner, `/users/${mod.pk}/role`, { method: "PUT", body: { role: null } })).status).toBe(200);
    expect(await endsWithin(reader)).toBe(true);
  });

  test("a downgrade that loses IP visibility ends the stream; reconnecting gives the reduced view", async () => {
    const h = await createHarness();
    const admin = await h.addAdmin("admin");
    const cookie = await h.login(admin);
    const reader = await open(h.req("/stream?events=1", { headers: { cookie } }));
    expect((await h.asKey(h.owner, `/users/${admin.pk}/role`, { method: "PUT", body: { role: "moderator" } })).status).toBe(200);
    expect(await endsWithin(reader)).toBe(true);
    const again = await open(h.req("/stream?events=1", { headers: { cookie } }));
    h.bus.emit("event.accepted", { event: signEvent(newKey(), 1, [], "hi"), status: "saved", ip: "1.2.3.4", source: "ws" });
    const out = await readUntil(again, "event: event");
    expect(out).not.toContain("1.2.3.4");
    await again.cancel();
  });

  test("a ban ends a NIP-98 stream", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const reader = await open(h.asKey(mod, "/stream"));
    expect((await h.asKey(h.owner, `/users/${mod.pk}/ban`, { method: "POST", body: {} })).status).toBe(200);
    expect(await endsWithin(reader)).toBe(true);
  });
});

// ------------------------------------------------------------------ banned admins

describe("banned or deny-listed admins lose admin access", () => {
  test("cookie, NIP-98, login and NIP-86 are refused; lifting the ban restores access", async () => {
    const h = await createHarness();
    const admin = await h.addAdmin("admin");
    const cookie = await h.login(admin);
    expect((await h.asKey(h.owner, `/users/${admin.pk}/ban`, { method: "POST", body: {} })).status).toBe(200);
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(403);
    expect((await h.asKey(admin, "/users")).status).toBe(403);
    await expect(h.login(admin)).rejects.toThrow(/403/);
    const rpc = JSON.stringify({ method: "supportedmethods", params: [] });
    const headers = { authorization: nip98Header(admin, PUBLIC_URL, "POST", rpc, [], Math.floor(h.clock.now / 1000)) };
    expect((await h.api.nip86(new Request(`${PUBLIC_URL}/`, { method: "POST", body: rpc, headers }))).status).toBe(403);

    expect((await h.asKey(h.owner, `/users/${admin.pk}/unban`, { method: "POST" })).status).toBe(200);
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(200);
    expect((await h.stores.users.get(admin.pk))?.role).toBe("admin");
  });

  test("deny-listed staff are refused too", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    expect((await h.asKey(h.owner, `/users/${mod.pk}`, { method: "PATCH", body: { denied: true } })).status).toBe(200);
    expect((await h.asKey(mod, "/auth/me")).status).toBe(403);
  });

  test("config owners are unaffected by a stored ban", async () => {
    const h = await createHarness();
    await h.stores.users.upsert(h.owner.pk, { status: "banned", denied: true });
    expect((await h.asKey(h.owner, "/auth/me")).status).toBe(200);
  });

  test("a banned admin still outranks a moderator for deletes", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    await h.stores.users.upsert(admin.pk, { status: "banned" });
    const post = signEvent(admin, 1, [], "x");
    await h.events.save(post);
    expect((await h.asKey(mod, `/events/${post.id}`, { method: "DELETE", body: {} })).status).toBe(403);
    expect(await h.events.getById(post.id)).toBeTruthy();
  });
});

// ------------------------------------------------------------------ login factors need a fresh login

describe("TOTP enrollment and passkey removal need a fresh login", () => {
  /** owner with a password set in an earlier session, and a later session that has gone stale */
  async function staleSession(h: Harness, password = "the-password") {
    const first = await h.login(h.owner);
    expect((await h.withCookie(first, "/auth/password/set", { method: "POST", body: { password } })).status).toBe(200);
    h.clock.now += 1000;
    const cookie = await h.login(h.owner);
    h.clock.now += 20 * 60_000;
    return cookie;
  }

  test("a stale session can't enroll an authenticator without the current password", async () => {
    const h = await createHarness();
    const cookie = await staleSession(h);
    const res = await h.withCookie(cookie, "/auth/totp/setup", { method: "POST", body: {} });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("reauth_required");
    expect((await h.withCookie(cookie, "/auth/totp/setup", { method: "POST", body: { currentPassword: "wrong" } })).status).toBe(403);
    const ok = await h.withCookie(cookie, "/auth/totp/setup", { method: "POST", body: { currentPassword: "the-password" } });
    expect(ok.status).toBe(200);
    const { secret } = (await ok.json()) as { secret: string };
    expect((await h.withCookie(cookie, "/auth/totp/enable", { method: "POST", body: { code: totpCode(secret, Math.floor(h.clock.now / 30_000)) } })).status).toBe(200);
  });

  test("a password set during the stale session can't vouch for it", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "set-while-fresh" } });
    h.clock.now += 20 * 60_000;
    const res = await h.withCookie(cookie, "/auth/totp/setup", { method: "POST", body: { currentPassword: "set-while-fresh" } });
    expect(((await res.json()) as { code: string }).code).toBe("reauth_required");
  });

  test("only the session that passed setup can enable its secret", async () => {
    const h = await createHarness();
    const stale = await staleSession(h);
    const fresh = await h.login(h.owner);
    const { secret } = (await (await h.withCookie(fresh, "/auth/totp/setup", { method: "POST", body: {} })).json()) as { secret: string };
    const code = totpCode(secret, Math.floor(h.clock.now / 30_000));
    expect((await h.withCookie(stale, "/auth/totp/enable", { method: "POST", body: { code } })).status).toBe(400);
    expect((await h.stores.db.get<{ totp_secret: string | null }>("SELECT totp_secret FROM admin_credentials WHERE pubkey = ?", [h.owner.pk]))?.totp_secret).toBeNull();
    expect((await h.withCookie(fresh, "/auth/totp/enable", { method: "POST", body: { code } })).status).toBe(200);
  });

  test("a stale session can't remove passkeys without the current password", async () => {
    const h = await createHarness();
    const cookie = await staleSession(h);
    const add = (id: string) =>
      h.stores.db.run("INSERT INTO admin_passkeys (id, pubkey, public_key, counter, transports, name, created_at) VALUES (?, ?, 'pk', 0, '[]', 'key', 1)", [id, h.owner.pk]);
    await add("k1");
    await add("k2");
    const del = (c: string, id: string, body: unknown = {}) => h.withCookie(c, `/auth/passkey/${id}`, { method: "DELETE", body });
    const res = await del(cookie, "k1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("reauth_required");
    expect(await h.stores.db.all("SELECT id FROM admin_passkeys")).toHaveLength(2);
    expect((await del(cookie, "k1", { currentPassword: "wrong" })).status).toBe(403);
    expect((await del(cookie, "k1", { currentPassword: "the-password" })).status).toBe(200);
    // a fresh login (or NIP-98) needs no password
    expect((await del(await h.login(h.owner), "k2", undefined)).status).toBe(200);
    expect(await h.stores.db.all("SELECT id FROM admin_passkeys")).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ push subscriptions follow sessions

describe("push subscriptions don't outlive the session that registered them", () => {
  const sub = (i: number | string) => ({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: { p256dh: "k", auth: "a" } } });
  const endpoints = async (h: Harness, pk: string) =>
    (await h.stores.db.all<{ endpoint: string }>("SELECT endpoint FROM admin_push_subscriptions WHERE pubkey = ? ORDER BY endpoint", [pk])).map((r) =>
      r.endpoint.split("/").pop(),
    );

  test("logout drops only that session's devices; a password change drops all other devices", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    const a = await h.login(h.owner);
    const b = await h.login(h.owner);
    const c = await h.login(h.owner);
    for (const [cookie, i] of [[a, "a"], [b, "b"], [c, "c"]] as const) expect((await h.withCookie(cookie, "/push/subscribe", { method: "POST", body: sub(i) })).status).toBe(200);
    expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub("nip98") })).status).toBe(200);

    await h.withCookie(a, "/auth/logout", { method: "POST" });
    expect(await endpoints(h, h.owner.pk)).toEqual(["b", "c", "nip98"]);

    expect((await h.withCookie(b, "/auth/password/set", { method: "POST", body: { password: "new-password-1" } })).status).toBe(200);
    expect(await endpoints(h, h.owner.pk)).toEqual(["b"]);
  });

  test("removing the role drops the admin's devices", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    const admin = await h.addAdmin("admin");
    await h.withCookie(await h.login(admin), "/push/subscribe", { method: "POST", body: sub(1) });
    await h.asKey(admin, "/push/subscribe", { method: "POST", body: sub(2) });
    expect((await h.asKey(h.owner, `/users/${admin.pk}/role`, { method: "PUT", body: { role: null } })).status).toBe(200);
    expect(await endpoints(h, admin.pk)).toEqual([]);
  });

  test("banned or deny-listed admins get no pushes", async () => {
    const sent: string[] = [];
    const h = await createHarness({ pushSender: async (s) => void sent.push(s.endpoint.split("/").pop()!) });
    const banned = await h.addAdmin("admin");
    const denied = await h.addAdmin("moderator");
    const fine = await h.addAdmin("viewer");
    for (const [k, i] of [[banned, "banned"], [denied, "denied"], [fine, "fine"]] as const) await h.asKey(k, "/push/subscribe", { method: "POST", body: sub(i) });
    await h.stores.users.upsert(banned.pk, { status: "banned" });
    await h.stores.users.upsert(denied.pk, { denied: true });
    await h.relay.publish(signEvent(newKey(), 1984, [["p", newKey().pk, "spam"]]), "api");
    await Bun.sleep(20);
    expect(sent).toEqual(["fine"]);
  });
});

// ------------------------------------------------------------------ admin media preview headers

describe("admin media preview", () => {
  test("XML-based audio/video stays sandboxed and downloads; only plain media skips the sandbox", async () => {
    const h = await createHarness();
    const cases: [type: string, sandboxed: boolean, download: boolean][] = [
      ["video/x+xml", true, true],
      ["audio/xml", true, true],
      ["Video/X+XML; charset=utf-8", true, true],
      ["image/svg+xml", true, true],
      ["text/html", true, true],
      ["application/octet-stream", true, true],
      ["video/mp4", false, false],
      ["audio/mpeg", false, false],
      ["image/png", true, false],
      ["text/plain", true, false],
    ];
    for (const [i, [type, sandboxed, download]] of cases.entries()) {
      const sha = i.toString(16).padStart(64, "0");
      h.blossom!.blobs.set(sha, { sha256: sha, size: 1, type, createdAt: 1, owners: [], status: "pending", hasThumbnail: false, url: "" });
      const res = await h.asKey(h.owner, `/media/${sha}/raw`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect([type, csp.includes("sandbox")]).toEqual([type, sandboxed]);
      if (!sandboxed) expect(csp).toBe("default-src 'none'; media-src 'self'");
      expect([type, res.headers.get("content-disposition")]).toEqual([type, download ? `attachment; filename="${sha}"` : null]);
    }
  });
});
