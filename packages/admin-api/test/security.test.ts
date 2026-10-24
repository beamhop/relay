import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { createAdminApi } from "../src";
import { ExpiringMap } from "../src/util/lru";
import { totpCode } from "../src/util/totp";
import { createHarness, newKey, nip98Header, PUBLIC_URL, signEvent, type Key } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const passwordLogin = (h: Harness, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  h.req("/auth/password", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

/** owner with a password; returns a fresh nostr session cookie */
async function withPassword(h: Harness, password = "the-password") {
  const cookie = await h.login(h.owner);
  expect((await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password } })).status).toBe(200);
  return cookie;
}

/** enables TOTP for the owner; returns the secret and the (consumed) enabling step */
async function enableTotp(h: Harness, cookie: string) {
  const { secret } = (await (await h.withCookie(cookie, "/auth/totp/setup", { method: "POST" })).json()) as { secret: string };
  const step = Math.floor(h.clock.now / 30_000);
  expect((await h.withCookie(cookie, "/auth/totp/enable", { method: "POST", body: { code: totpCode(secret, step) } })).status).toBe(200);
  return { secret, step };
}

describe("client IP behind a proxy", () => {
  test("the rightmost X-Forwarded-For hop is used, so spoofed leftmost entries can't dodge the lockout", async () => {
    const h = await createHarness({ trustProxy: true });
    await withPassword(h);
    for (let i = 0; i < 5; i++) {
      const res = await passwordLogin(h, { login: h.owner.pk, password: "wrong" }, { "x-forwarded-for": `10.0.0.${i}, 203.0.113.9` });
      expect(res.status).toBe(401);
    }
    const res = await passwordLogin(h, { login: h.owner.pk, password: "the-password" }, { "x-forwarded-for": "10.9.9.9, 203.0.113.9" });
    expect(res.status).toBe(429);
  });

  test("the server-bound c.env.ip wins over forwarding headers", async () => {
    const h = await createHarness({ trustProxy: true });
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    const event = signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]]);
    const req = new Request("http://localhost/auth/nostr", { method: "POST", body: JSON.stringify({ event }), headers: { "x-forwarded-for": "6.6.6.6" } });
    await h.api.app.fetch(req, { ip: "192.0.2.10" });
    expect(h.audit.entries.find((e) => e.action === "auth.login")?.ip).toBe("192.0.2.10");
  });

  test("audit entries record the proxy-appended address", async () => {
    const h = await createHarness({ trustProxy: true });
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    const event = signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]]);
    await h.req("/auth/nostr", { method: "POST", body: JSON.stringify({ event }), headers: { "x-forwarded-for": "6.6.6.6, ::ffff:198.51.100.7" } });
    expect(h.audit.entries.find((e) => e.action === "auth.login")?.ip).toBe("198.51.100.7");
  });
});

describe("password login lockout", () => {
  test("per-account lockout applies across IPs", async () => {
    const h = await createHarness({ trustProxy: true });
    await withPassword(h);
    for (let i = 0; i < 10; i++) {
      const res = await passwordLogin(h, { login: h.owner.pk, password: "wrong" }, { "x-forwarded-for": `198.51.100.${i}` });
      expect(res.status).toBe(401);
    }
    const res = await passwordLogin(h, { login: h.owner.pk, password: "the-password" }, { "x-forwarded-for": "198.51.100.200" });
    expect(res.status).toBe(429);
  });
});

describe("re-auth checks", () => {
  test("TOTP setup while enabled requires a current code", async () => {
    const h = await createHarness();
    const cookie = await withPassword(h);
    const { secret, step } = await enableTotp(h, cookie);
    const noCode = await h.withCookie(cookie, "/auth/totp/setup", { method: "POST" });
    expect(noCode.status).toBe(400);
    expect(((await noCode.json()) as { code: string }).code).toBe("totp_required");
    expect((await h.withCookie(cookie, "/auth/totp/setup", { method: "POST", body: { code: "000000" } })).status).toBe(400);
    expect((await h.withCookie(cookie, "/auth/totp/setup", { method: "POST", body: { code: totpCode(secret, step + 1) } })).status).toBe(200);
  });

  test("TOTP disable codes are rate limited", async () => {
    const h = await createHarness();
    const cookie = await withPassword(h);
    const { secret, step } = await enableTotp(h, cookie);
    for (let i = 0; i < 5; i++) {
      expect((await h.withCookie(cookie, "/auth/totp/disable", { method: "POST", body: { code: String(100000 + i) } })).status).toBe(400);
    }
    const res = await h.withCookie(cookie, "/auth/totp/disable", { method: "POST", body: { code: totpCode(secret, step + 1) } });
    expect(res.status).toBe(429);
  });

  test("current-password checks on a stale session are rate limited", async () => {
    const h = await createHarness();
    const cookie = await withPassword(h);
    h.clock.now += 11 * 60_000; // no longer a fresh nostr login
    for (let i = 0; i < 5; i++) {
      const res = await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "new-password", currentPassword: `guess-${i}` } });
      expect(res.status).toBe(403);
    }
    const res = await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "new-password", currentPassword: "the-password" } });
    expect(res.status).toBe(429);
  });

  test("a used TOTP code stays used after a restart", async () => {
    const h = await createHarness();
    const cookie = await withPassword(h);
    const { secret, step } = await enableTotp(h, cookie);
    const code = totpCode(secret, step + 1);
    expect((await passwordLogin(h, { login: h.owner.pk, password: "the-password", totp: code })).status).toBe(200);
    const restarted = await createAdminApi(h.deps, { now: () => h.clock.now });
    const res = await restarted.app.request("/auth/password", {
      method: "POST",
      body: JSON.stringify({ login: h.owner.pk, password: "the-password", totp: code }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("adding a passkey needs a recent login or the current password", async () => {
    const h = await createHarness();
    await withPassword(h);
    // a password set in the same session can't vouch for it later, so use a later session
    h.clock.now += 1000;
    const cookie = await h.login(h.owner);
    expect((await h.withCookie(cookie, "/auth/passkey/register/options", { method: "POST" })).status).toBe(200);
    h.clock.now += 16 * 60_000;
    const stale = await h.withCookie(cookie, "/auth/passkey/register/options", { method: "POST" });
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe("reauth_required");
    expect((await h.withCookie(cookie, "/auth/passkey/register/options", { method: "POST", body: { currentPassword: "nope" } })).status).toBe(403);
    expect((await h.withCookie(cookie, "/auth/passkey/register/options", { method: "POST", body: { currentPassword: "the-password" } })).status).toBe(200);
  });
});

describe("sessions", () => {
  test("sliding renewal stops at the absolute lifetime", async () => {
    const h = await createHarness();
    const cookie = await h.login(h.owner);
    for (let day = 1; day < 30; day++) {
      h.clock.now += 24 * 3600_000;
      expect((await h.withCookie(cookie, "/auth/me")).status).toBe(200);
    }
    h.clock.now += 24 * 3600_000;
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(401);
  });
});

describe("nostr login URL", () => {
  test("only the publicUrl-based URL is accepted, whatever Host the request arrived on", async () => {
    const h = await createHarness();
    const post = async (u: string, reqUrl = "http://192.168.1.5:3000/auth/nostr") => {
      const { challenge, url } = (await (await h.req("/auth/challenge")).json()) as { challenge: string; url: string };
      expect(url).toBe(`${PUBLIC_URL}/admin/api/auth/nostr`);
      const event = signEvent(h.owner, 27235, [["u", u], ["method", "POST"], ["challenge", challenge]]);
      return h.api.app.request(new Request(reqUrl, { method: "POST", body: JSON.stringify({ event }) }));
    };
    // panel opened via a LAN IP: the client signs the server-provided publicUrl URL
    expect((await post(`${PUBLIC_URL}/admin/api/auth/nostr`)).status).toBe(200);
    // a login event signed "for" another host can't be replayed with a matching Host header
    expect((await post("http://192.168.1.5:3000/admin/api/auth/nostr")).status).toBe(401);
    expect((await post("https://evil.test/admin/api/auth/nostr", "https://evil.test/auth/nostr")).status).toBe(401);
  });
});

describe("challenge floods", () => {
  test("ExpiringMap refuses new entries when full instead of evicting live ones", () => {
    let now = 0;
    const m = new ExpiringMap<true>(2, () => now);
    expect(m.set("a", true, 1000)).toBe(true);
    expect(m.set("b", true, 1000)).toBe(true);
    expect(m.set("c", true, 1000)).toBe(false);
    expect(m.has("a")).toBe(true);
    now = 2000; // expired entries make room again
    expect(m.set("c", true, 1000)).toBe(true);
  });

  test("unauthenticated challenge issuance is rate limited per IP", async () => {
    const h = await createHarness();
    for (let i = 0; i < 60; i++) expect((await h.req("/auth/challenge")).status).toBe(200);
    expect((await h.req("/auth/challenge")).status).toBe(429);
    h.clock.now += 61_000;
    expect((await h.req("/auth/challenge")).status).toBe(200);
  });
});

describe("NIP-98 payload bodies", () => {
  const post = (h: Harness, k: Key, body: string, payloadOf = body) =>
    h.req("/users", {
      method: "POST",
      body,
      headers: { authorization: nip98Header(k, h.url("/users"), "POST", payloadOf, [], Math.floor(h.clock.now / 1000)), "content-type": "application/json" },
    });

  test("non-admins are refused before their body is read", async () => {
    const h = await createHarness();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    const stranger = newKey();
    const header = nip98Header(stranger, h.url("/events/import"), "POST", "x", [], Math.floor(h.clock.now / 1000));
    const res = await h.req("/events/import", { method: "POST", body: stream, headers: { authorization: header }, duplex: "half" } as RequestInit);
    expect(res.status).toBe(403);
    expect(pulled).toBeLessThan(5);
  });

  test("admin payloads are verified and size-capped", async () => {
    const h = await createHarness();
    const target = newKey();
    expect((await post(h, h.owner, JSON.stringify({ pubkey: target.pk }))).status).toBe(201);
    expect((await post(h, h.owner, JSON.stringify({ pubkey: target.pk }), "other")).status).toBe(401);
    const big = JSON.stringify({ pubkey: target.pk, notes: "x".repeat(2 * 1024 * 1024) });
    expect((await post(h, h.owner, big)).status).toBe(413);
  });

  test("NIP-86 stops reading a chunked body past the cap", async () => {
    const h = await createHarness();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > 10 * 1024 * 1024) return c.close();
        sent += 16 * 1024;
        c.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const res = await h.api.nip86(new Request(`${PUBLIC_URL}/`, { method: "POST", body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(200 * 1024);
  });
});

describe("role checks on user records", () => {
  test("moderators can't raise their own limits or access, but can edit their notes", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const patch = (body: unknown) => h.asKey(mod, `/users/${mod.pk}`, { method: "PATCH", body });
    expect((await patch({ blossomQuota: null })).status).toBe(403);
    expect((await patch({ rateLimit: { eventsPerMinute: 1_000_000 } })).status).toBe(403);
    expect((await patch({ allowed: true })).status).toBe(403);
    expect((await patch({ notes: "me" })).status).toBe(200);
    const bulk = (await (await h.asKey(mod, "/users/bulk", { method: "POST", body: { pubkeys: [mod.pk], action: "allow" } })).json()) as { ok: number };
    expect(bulk.ok).toBe(0);
    // owners may change their own record
    expect((await h.asKey(h.owner, `/users/${h.owner.pk}`, { method: "PATCH", body: { blossomQuota: null } })).status).toBe(200);
  });

  test("lifting a ban/mute/deny needs rank over the target", async () => {
    const h = await createHarness();
    const admin = await h.addAdmin("admin");
    const mod = await h.addAdmin("moderator");
    expect((await h.asKey(h.owner, `/users/${admin.pk}/ban`, { method: "POST", body: {} })).status).toBe(200);
    expect((await h.asKey(mod, `/users/${admin.pk}/unban`, { method: "POST" })).status).toBe(403);
    expect((await h.stores.users.get(admin.pk))?.status).toBe("banned");
    const bulk = (await (await h.asKey(mod, "/users/bulk", { method: "POST", body: { pubkeys: [admin.pk], action: "unban" } })).json()) as { ok: number };
    expect(bulk.ok).toBe(0);
    const undeny = (await (await h.asKey(mod, "/users/bulk", { method: "POST", body: { pubkeys: [admin.pk], action: "undeny" } })).json()) as { ok: number };
    expect(undeny.ok).toBe(0);
    expect((await h.asKey(h.owner, `/users/${admin.pk}/unban`, { method: "POST" })).status).toBe(200);
  });

  test("POST /users can't overwrite a higher-ranked user's record", async () => {
    const h = await createHarness();
    const admin = await h.addAdmin("admin");
    const mod = await h.addAdmin("moderator");
    expect((await h.asKey(mod, "/users", { method: "POST", body: { pubkey: admin.pk, notes: "x" } })).status).toBe(403);
    expect((await h.asKey(mod, "/users", { method: "POST", body: { pubkey: newKey().pk, notes: "x" } })).status).toBe(201);
  });

  test("NIP-86 allowpubkey keeps notes and checks rank; unbanpubkey checks rank", async () => {
    const h = await createHarness();
    const rpc = (k: Key, body: unknown) => {
      const text = JSON.stringify(body);
      const headers = { authorization: nip98Header(k, PUBLIC_URL, "POST", text, [], Math.floor(h.clock.now / 1000)) };
      return h.api.nip86(new Request(`${PUBLIC_URL}/`, { method: "POST", body: text, headers }));
    };
    const target = newKey();
    await h.stores.users.upsert(target.pk, { notes: "operator notes" });
    expect(await (await rpc(h.owner, { method: "allowpubkey", params: [target.pk, "friend"] })).json()).toEqual({ result: true });
    expect(await h.stores.users.get(target.pk)).toMatchObject({ allowed: true, notes: "operator notes" });
    const admin = await h.addAdmin("admin");
    const mod = await h.addAdmin("moderator");
    expect(((await (await rpc(mod, { method: "allowpubkey", params: [mod.pk] })).json()) as { error?: string }).error).toBeTruthy();
    await h.stores.users.upsert(admin.pk, { status: "banned" });
    expect(((await (await rpc(mod, { method: "unbanpubkey", params: [admin.pk] })).json()) as { error?: string }).error).toBeTruthy();
    expect((await h.stores.users.get(admin.pk))?.status).toBe("banned");
  });
});

describe("content", () => {
  const mk = (id: string, pubkey: string, created_at: number): NostrEvent => ({ id, pubkey, created_at, kind: 1, tags: [], content: "", sig: "0".repeat(128) });

  test("filter delete reports only the events it deleted", async () => {
    const h = await createHarness();
    const pk = newKey().pk;
    for (let i = 0; i < 5; i++) await h.events.save(mk(String(i).padStart(64, "0"), pk, 100 + i));
    const deleted: string[][] = [];
    h.bus.on("event.deleted", (e) => void deleted.push(e.ids));
    const res = await h.asKey(h.owner, "/events/delete", { method: "POST", body: { filters: [{ authors: [pk], limit: 2 }] } });
    expect(((await res.json()) as { deleted: number }).deleted).toBe(2);
    expect(deleted[0].sort()).toEqual([String(4).padStart(64, "0"), String(3).padStart(64, "0")].sort());
  });

  const exportIds = async (h: Harness, filters: unknown[]) => {
    const res = await h.asKey(h.owner, `/events/export?filters=${encodeURIComponent(JSON.stringify(filters))}`);
    expect(res.status).toBe(200);
    return (await res.text()).trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as NostrEvent).id);
  };

  test("export with several filters doesn't skip events after a page of duplicates", async () => {
    const h = await createHarness();
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    // a: 999 events at 2000..1002 plus one at 1001; b: one at 1001 that sorts after a's (id tie-break)
    for (let i = 0; i < 999; i++) await h.events.save(mk(`0${String(i).padStart(63, "0")}`, a, 2000 - i));
    await h.events.save(mk(`1${"0".repeat(63)}`, a, 1001));
    await h.events.save(mk(`f${"0".repeat(63)}`, b, 1001));
    const ids = await exportIds(h, [{ authors: [a] }, { kinds: [1] }]);
    expect(ids).toContain(`f${"0".repeat(63)}`);
    expect(new Set(ids).size).toBe(1001);
  });

  test("export includes more than a page of events sharing one second", async () => {
    const h = await createHarness();
    const pk = "c".repeat(64);
    for (let i = 0; i < 1005; i++) await h.events.save(mk(String(i).padStart(64, "0"), pk, 500));
    await h.events.save(mk("e".repeat(64), pk, 400));
    const ids = await exportIds(h, [{ authors: [pk] }]);
    expect(new Set(ids).size).toBe(1006);
  });
});

describe("plugins", () => {
  test("a plugin named x can be managed; the proxy still works", async () => {
    const h = await createHarness();
    h.deps.plugins.list().push({ name: "x", version: "1.0.0", description: "", source: "local", enabled: false, status: "stopped" } as never);
    const res = await h.asKey(h.owner, "/plugins/x/enable", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string; enabled: boolean }).enabled).toBe(true);
    expect((await h.asKey(h.owner, "/plugins/x/demo/hello")).status).toBe(200);
  });

  test("viewers get secret-looking plugin settings masked", async () => {
    const h = await createHarness();
    expect((await h.asKey(h.owner, "/plugins/demo/settings", { method: "PATCH", body: { values: { apiKey: "s3cret", a: 1 } } })).status).toBe(200);
    const viewer = await h.addAdmin("viewer");
    const seen = (await (await h.asKey(viewer, "/plugins/demo/settings")).json()) as { values: Record<string, unknown> };
    expect(seen.values.a).toBe(1);
    expect(seen.values.apiKey).not.toBe("s3cret");
    const owner = (await (await h.asKey(h.owner, "/plugins/demo/settings")).json()) as { values: Record<string, unknown> };
    expect(owner.values.apiKey).toBe("s3cret");
  });
});

describe("media blocklist", () => {
  test("list and unblock blocked hashes", async () => {
    const h = await createHarness();
    const sha = "a".repeat(64);
    h.blossom!.blocked.add(sha);
    expect(await (await h.asKey(h.owner, "/media/blocklist")).json()).toEqual({ items: [{ sha256: sha, reason: "deleted by admin", createdAt: 1 }] });
    const viewer = await h.addAdmin("viewer");
    expect((await h.asKey(viewer, `/media/blocklist/${sha}`, { method: "DELETE" })).status).toBe(403);
    expect((await h.asKey(h.owner, `/media/blocklist/${sha}`, { method: "DELETE" })).status).toBe(200);
    expect(h.blossom!.blocked.has(sha)).toBe(false);
    expect((await h.asKey(h.owner, `/media/blocklist/${sha}`, { method: "DELETE" })).status).toBe(404);
  });

  test("501 when the blossom service has no blocklist", async () => {
    const h = await createHarness();
    delete (h.blossom as { blocklist?: unknown }).blocklist;
    delete (h.blossom as { unblock?: unknown }).unblock;
    expect((await h.asKey(h.owner, "/media/blocklist")).status).toBe(501);
    expect((await h.asKey(h.owner, `/media/blocklist/${"a".repeat(64)}`, { method: "DELETE" })).status).toBe(501);
  });
});

describe("push topics", () => {
  test("the never-sent users topic is dropped", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "k", auth: "a" } };
    const res = await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: { subscription: sub, topics: ["users", "reports"] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { topics: string[] }).topics).toEqual(["reports"]);
    const all = (await (await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: { subscription: sub } })).json()) as { topics: string[] };
    expect(all.topics).toEqual(["reports", "alerts"]);
  });
});

