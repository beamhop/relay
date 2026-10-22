import { describe, expect, test } from "bun:test";
import { nip19 } from "nostr-tools";
import { cookieFrom, createHarness, newKey, nip98Header, signEvent } from "./fakes";

describe("auth: nostr login", () => {
  test("challenge login creates a session usable for /auth/me", async () => {
    const h = await createHarness();
    const res0 = await h.req("/auth/challenge");
    expect(res0.status).toBe(200);
    const cookie = await h.login(h.owner);
    const me = await h.withCookie(cookie, "/auth/me");
    expect(me.status).toBe(200);
    const body = (await me.json()) as { pubkey: string; role: string; permissions: string[]; hasPassword: boolean };
    expect(body.pubkey).toBe(h.owner.pk);
    expect(body.role).toBe("owner");
    expect(body.permissions).toContain("admins.manage");
    expect(body.hasPassword).toBe(false);
    expect(h.audit.entries.some((e) => e.action === "auth.login" && e.actor === h.owner.pk)).toBe(true);
  });

  test("session cookie attributes", async () => {
    const h = await createHarness();
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    const event = signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]]);
    const res = await h.req("/auth/nostr", { method: "POST", body: JSON.stringify({ event }) });
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    expect(sc).toContain("Secure");
    expect(sc).toContain("Path=/admin");
  });

  test("challenge is single use and must match", async () => {
    const h = await createHarness();
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    const mk = (ch: string) => signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", ch]]);
    const post = (event: unknown) => h.req("/auth/nostr", { method: "POST", body: JSON.stringify({ event }) });
    expect((await post(mk("nope"))).status).toBe(401);
    expect((await post(mk(challenge))).status).toBe(200);
    expect((await post(mk(challenge))).status).toBe(401);
  });

  test("expired challenge rejected", async () => {
    const h = await createHarness();
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    h.clock.now += 6 * 60_000;
    const event = signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]], "", Math.floor(h.clock.now / 1000));
    const res = await h.req("/auth/nostr", { method: "POST", body: JSON.stringify({ event }) });
    expect(res.status).toBe(401);
  });

  test("non-admin cannot log in (403)", async () => {
    const h = await createHarness();
    const stranger = newKey();
    await expect(h.login(stranger)).rejects.toThrow("403");
  });

  test("wrong url / tampered signature rejected", async () => {
    const h = await createHarness();
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    const bad = signEvent(h.owner, 27235, [["u", "https://evil.test/admin/api/auth/nostr"], ["method", "POST"], ["challenge", challenge]]);
    expect((await h.req("/auth/nostr", { method: "POST", body: JSON.stringify({ event: bad }) })).status).toBe(401);
    const good = signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]]);
    const tampered = { ...good, content: "x" };
    expect((await h.req("/auth/nostr", { method: "POST", body: JSON.stringify({ event: tampered }) })).status).toBe(401);
  });
});

describe("auth: NIP-98 header", () => {
  test("valid header authenticates per request", async () => {
    const h = await createHarness();
    const res = await h.asKey(h.owner, "/auth/me");
    expect(res.status).toBe(200);
  });

  test("u must include query; method must match; replay rejected; stale rejected", async () => {
    const h = await createHarness();
    const path = "/users?limit=5";
    const wrongUrl = nip98Header(h.owner, h.url("/users"), "GET");
    expect((await h.req(path, { headers: { authorization: wrongUrl } })).status).toBe(401);
    const wrongMethod = nip98Header(h.owner, h.url(path), "POST");
    expect((await h.req(path, { headers: { authorization: wrongMethod } })).status).toBe(401);
    const ok = nip98Header(h.owner, h.url(path), "GET");
    expect((await h.req(path, { headers: { authorization: ok } })).status).toBe(200);
    expect((await h.req(path, { headers: { authorization: ok } })).status).toBe(401);
    const stale = nip98Header(h.owner, h.url(path), "GET", undefined, [], Math.floor(Date.now() / 1000) - 120);
    expect((await h.req(path, { headers: { authorization: stale } })).status).toBe(401);
  });

  test("payload tag must match body", async () => {
    const h = await createHarness();
    const target = newKey();
    const body = JSON.stringify({ reason: "spam" });
    const auth = nip98Header(h.owner, h.url(`/users/${target.pk}/ban`), "POST", JSON.stringify({ reason: "other" }));
    const res = await h.req(`/users/${target.pk}/ban`, { method: "POST", body, headers: { authorization: auth } });
    expect(res.status).toBe(401);
    const res2 = await h.asKey(h.owner, `/users/${target.pk}/ban`, { method: "POST", body });
    expect(res2.status).toBe(200);
  });

  test("works when routes are mounted under /admin/api", async () => {
    const h = await createHarness();
    const { Hono } = await import("hono");
    const root = new Hono();
    root.route("/admin/api", h.api.app);
    const auth = nip98Header(h.owner, h.url("/auth/me"), "GET");
    const res = await root.request(h.url("/auth/me"), { headers: { authorization: auth } });
    expect(res.status).toBe(200);
  });

  test("anonymous → 401, non-admin → 403", async () => {
    const h = await createHarness();
    expect((await h.req("/users")).status).toBe(401);
    const res = await h.asKey(newKey(), "/users");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBeString();
  });
});

describe("auth: password", () => {
  test("set password then login with npub; wrong password → 401", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    const set = await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "correct horse battery" } });
    expect(set.status).toBe(200);
    const npub = nip19.npubEncode(h.owner.pk);
    const bad = await h.req("/auth/password", { method: "POST", body: JSON.stringify({ login: npub, password: "nope-nope" }) });
    expect(bad.status).toBe(401);
    const ok = await h.req("/auth/password", { method: "POST", body: JSON.stringify({ login: npub, password: "correct horse battery" }) });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { me: { hasPassword: boolean } };
    expect(body.me.hasPassword).toBe(true);
    expect(cookieFrom(ok)).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("scrypt$");
  });

  test("changing an existing password requires currentPassword unless fresh nostr login", async () => {
    const h = await createHarness();
    const nostrCookie = await h.login(h.owner);
    await h.withCookie(nostrCookie, "/auth/password/set", { method: "POST", body: { password: "first-password" } });
    const pwLogin = await h.req("/auth/password", { method: "POST", body: JSON.stringify({ login: h.owner.pk, password: "first-password" }) });
    const pwCookie = cookieFrom(pwLogin)!;
    const noCurrent = await h.withCookie(pwCookie, "/auth/password/set", { method: "POST", body: { password: "second-password" } });
    expect(noCurrent.status).toBe(400);
    const wrong = await h.withCookie(pwCookie, "/auth/password/set", { method: "POST", body: { password: "second-password", currentPassword: "xxxxxxxxx" } });
    expect(wrong.status).toBe(403);
    const ok = await h.withCookie(pwCookie, "/auth/password/set", { method: "POST", body: { password: "second-password", currentPassword: "first-password" } });
    expect(ok.status).toBe(200);
  });

  test("lockout after repeated failures", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "the-password" } });
    const attempt = (password: string) =>
      h.req("/auth/password", { method: "POST", body: JSON.stringify({ login: h.owner.pk, password }) });
    for (let i = 0; i < 5; i++) expect((await attempt("wrong")).status).toBe(401);
    const locked = await attempt("the-password");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    h.clock.now += 61_000;
    expect((await attempt("the-password")).status).toBe(200);
  });
});

describe("auth: sessions", () => {
  test("logout destroys the session", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    expect((await h.withCookie(cookie, "/auth/logout", { method: "POST" })).status).toBe(200);
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(401);
  });

  test("session expires after 7 days without use, slides when used", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    h.clock.now += 6 * 86400_000;
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(200);
    h.clock.now += 6 * 86400_000;
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(200);
    h.clock.now += 8 * 86400_000;
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(401);
  });

  test("CSRF: cookie mutation without X-Requested-With or Origin is rejected", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    const target = newKey();
    const bare = await h.req(`/users/${target.pk}/mute`, { method: "POST", headers: { cookie } });
    expect(bare.status).toBe(403);
    const withOrigin = await h.req(`/users/${target.pk}/mute`, { method: "POST", headers: { cookie, origin: "https://relay.test" } });
    expect(withOrigin.status).toBe(200);
    const evilOrigin = await h.req(`/users/${target.pk}/mute`, { method: "POST", headers: { cookie, origin: "https://evil.test" } });
    expect(evilOrigin.status).toBe(403);
  });

  test("demoted admin loses access immediately", async () => {
    const h = await createHarness();
    const admin = await h.addAdmin("admin");
    const cookie = await h.login(admin);
    expect((await h.withCookie(cookie, "/users")).status).toBe(200);
    await h.stores.users.upsert(admin.pk, { role: null });
    expect((await h.withCookie(cookie, "/users")).status).toBe(403);
  });
});
