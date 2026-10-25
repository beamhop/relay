import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { createHarness, newKey } from "./fakes";
import { isSecretKeyName } from "@beamhop/sdk/secrets";
import { maskSecrets } from "../src/routes/plugins";
import { totpCode } from "../src/util/totp";

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const trustedCookieFrom = (res: Response) => {
  const m = /bh_td=([^;]*)/.exec(res.headers.get("set-cookie") ?? "");
  return m && m[1] ? `bh_td=${m[1]}` : undefined;
};

describe("first password and passkey re-auth", () => {
  test("a stale session can't mint a first password to vouch for a passkey", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    h.clock.now += 20 * 60_000; // session no longer fresh
    expect((await h.withCookie(cookie, "/auth/passkey/register/options", { method: "POST", body: {} })).status).toBe(403);
    const set = await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "attacker-chosen" } });
    expect(set.status).toBe(403);
    expect(((await set.json()) as { code: string }).code).toBe("reauth_required");
    const reg = await h.withCookie(cookie, "/auth/passkey/register/options", { method: "POST", body: { currentPassword: "attacker-chosen" } });
    expect(reg.status).toBe(403);
  });

  test("a password set during this session can't re-auth it later; one from an earlier session can", async () => {
    const h = await createHarness();
    const first = await h.login(h.owner);
    expect((await h.withCookie(first, "/auth/password/set", { method: "POST", body: { password: "set-while-fresh" } })).status).toBe(200);
    h.clock.now += 20 * 60_000;
    const same = await h.withCookie(first, "/auth/passkey/register/options", { method: "POST", body: { currentPassword: "set-while-fresh" } });
    expect(same.status).toBe(403);
    expect(((await same.json()) as { code: string }).code).toBe("reauth_required");

    h.clock.now += 1000;
    const second = await h.login(h.owner);
    h.clock.now += 20 * 60_000;
    expect((await h.withCookie(second, "/auth/passkey/register/options", { method: "POST", body: { currentPassword: "set-while-fresh" } })).status).toBe(200);
  });
});

describe("account lockout", () => {
  test("strangers can't lock the owner's trusted browser out of password login", async () => {
    const h = await createHarness({ trustProxy: true });
    const cookie = await h.login(h.owner);
    expect((await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "correct horse battery" } })).status).toBe(200);
    // the owner's browser got a trusted-device marker on that login
    const first = await h.req("/auth/password", { ...json({ login: h.owner.pk, password: "correct horse battery" }), headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" } });
    expect(first.status).toBe(200);
    const trusted = trustedCookieFrom(first)!;
    expect(trusted).toBeTruthy();

    const attempt = (ip: string, password: string, extra: Record<string, string> = {}) =>
      h.req("/auth/password", { ...json({ login: h.owner.pk, password }), headers: { "content-type": "application/json", "x-forwarded-for": ip, ...extra } });
    for (let i = 0; i < 10; i++) expect((await attempt(`203.0.113.${i + 1}`, "wrong-guess")).status).toBe(401);
    // an unknown browser is locked out of this account for now…
    expect((await attempt("198.51.100.7", "correct horse battery")).status).toBe(429);
    // …the owner's trusted browser is not
    expect((await attempt("198.51.100.8", "correct horse battery", { cookie: trusted })).status).toBe(200);
  });

  test("a forged or foreign trusted-device cookie doesn't bypass the lockout", async () => {
    const h = await createHarness({ trustProxy: true });
    const cookie = await h.login(h.owner);
    await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "correct horse battery" } });
    const attempt = (ip: string, password: string, extra: Record<string, string> = {}) =>
      h.req("/auth/password", { ...json({ login: h.owner.pk, password }), headers: { "content-type": "application/json", "x-forwarded-for": ip, ...extra } });
    for (let i = 0; i < 10; i++) await attempt(`203.0.113.${i + 1}`, "wrong-guess");
    const forged = `bh_td=${h.owner.pk}.${Math.floor(h.clock.now / 1000)}.${"A".repeat(43)}`;
    expect((await attempt("198.51.100.9", "correct horse battery", { cookie: forged })).status).toBe(429);
  });
});

describe("TOTP code reuse", () => {
  test("re-using the code that just enabled 2FA is reported as totp_reused and not counted as a failure", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "the-password" } });
    const { secret } = (await (await h.withCookie(cookie, "/auth/totp/setup", { method: "POST" })).json()) as { secret: string };
    const code = totpCode(secret, Math.floor(h.clock.now / 30_000));
    expect((await h.withCookie(cookie, "/auth/totp/enable", { method: "POST", body: { code } })).status).toBe(200);
    for (let i = 0; i < 7; i++) {
      const res = await h.withCookie(cookie, "/auth/totp/disable", { method: "POST", body: { code } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("totp_reused");
    }
    // the re-auth limiter wasn't tripped by those: the next code works
    h.clock.now += 30_000;
    expect((await h.withCookie(cookie, "/auth/totp/disable", { method: "POST", body: { code: totpCode(secret, Math.floor(h.clock.now / 30_000)) } })).status).toBe(200);
  });
});

describe("filter deletes below owner", () => {
  const id = (n: number) => n.toString(16).padStart(64, "0");
  const mk = (n: number, pubkey: string, created_at = 1000, tags: string[][] = [["t", "spam"]]): NostrEvent => ({
    id: id(n), pubkey, created_at, kind: 1, tags, content: "", sig: "0".repeat(128),
  });

  test("more matches than one page are all deleted, nothing is truncated", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const user = newKey().pk;
    for (let i = 1; i <= 12_000; i++) await h.events.save(mk(i, user, 1000 + (i % 50)));
    const res = await h.asKey(mod, "/events/delete", { method: "POST", body: { filters: [{ "#t": ["spam"] }] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 12_000 });
    expect(await h.events.count([{ "#t": ["spam"] }])).toBe(0);
  });

  test("a refused filter deletes nothing, not even the ids sent alongside", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const user = newKey().pk;
    await h.events.save(mk(1, user));
    await h.events.save(mk(2, h.owner.pk));
    const res = await h.asKey(mod, "/events/delete", { method: "POST", body: { ids: [id(1)], filters: [{ since: 0 }] } });
    expect(res.status).toBe(403);
    expect(await h.events.getById(id(1))).toBeTruthy();
    expect(await h.events.getById(id(2))).toBeTruthy();
  });

  test("many authors are rank-checked against the staff set", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const users = Array.from({ length: 30 }, () => newKey().pk);
    for (const [i, pk] of users.entries()) await h.events.save(mk(i + 1, pk));
    await h.events.save(mk(99, admin.pk));
    const ids = [...users.map((_, i) => id(i + 1)), id(99)];
    expect((await h.asKey(mod, "/events/delete", { method: "POST", body: { ids } })).status).toBe(403);
    const ok = await h.asKey(mod, "/events/delete", { method: "POST", body: { ids: ids.slice(0, 30) } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { deleted: number }).deleted).toBe(30);
  });
});

describe("plugin settings masking", () => {
  test("only secret-named string values are masked (whole-word key match)", () => {
    expect(maskSecrets({ privateRelay: true, maxTokens: 100, tokenBucketSize: 5, apiKey: "abc", nested: { password: "x" } })).toEqual({
      privateRelay: true,
      maxTokens: 100,
      tokenBucketSize: 5,
      apiKey: "••••••••",
      nested: { password: "••••••••" },
    });
    for (const k of ["apiToken", "accessToken", "token", "clientSecret", "secretAccessKey", "privateKey", "api_key", "relayNsec", "mnemonic", "seedPhrase", "credentials", "S3_SECRET"])
      expect(isSecretKeyName(k)).toBe(true);
    for (const k of ["maxTokens", "tokenBucketSize", "privateRelay", "keyword", "passwordMinLength", "monkey", "publicKey", "tokenizer"])
      expect(isSecretKeyName(k)).toBe(false);
  });

  test("non-string values under secret keys stay readable; string arrays are masked", () => {
    expect(maskSecrets({ token: 5, apiTokens: ["a", "b"], password: "" })).toEqual({ token: 5, apiTokens: ["••••••••", "••••••••"], password: "" });
  });
});

describe("login rate buckets", () => {
  test("exhausting /auth/challenge doesn't block passkey login options", async () => {
    const h = await createHarness();
    const hit = (path: string, init?: RequestInit) =>
      h.api.app.request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-requested-with": "beamhop" } }, { ip: "198.51.100.20" });
    for (let i = 0; i < 60; i++) expect((await hit("/auth/challenge")).status).toBe(200);
    expect((await hit("/auth/challenge")).status).toBe(429);
    expect((await hit("/auth/passkey/login/options", json({}))).status).toBe(200);
  });
});
