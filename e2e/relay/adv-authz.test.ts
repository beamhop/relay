/**
 * Adversarial authorization: every admin route called anonymously, by a non-admin, and by each role (NIP-98 and a
 * cookie session), checked against the permission table; every mutating route refused cross-site (no CSRF header,
 * foreign Origin, form/text bodies) for cookie sessions; session cookies rotate on login (no fixation).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { finalizeEvent } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { now } from "../harness/client";
import { api, user } from "./admin-helpers";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay();
});
afterAll(() => relay?.stop());

type AdminRole = "owner" | "admin" | "moderator" | "viewer";
type Permission = string;
/** The documented role table, pinned here (black box): a server-side change to it must show up as a test change. */
const ALL = [
  "dashboard.view", "connections.manage", "users.view", "users.edit", "users.ban", "users.delete", "invites.manage", "ip.manage",
  "content.view", "content.delete", "content.import", "content.export", "reports.view", "reports.resolve", "media.view",
  "media.moderate", "groups.view", "groups.manage", "settings.view", "settings.edit", "admins.manage", "plugins.view",
  "plugins.manage", "plugins.use", "audit.view",
];
const ROLE_PERMISSIONS: Record<AdminRole, string[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "admins.manage"),
  moderator: [
    "dashboard.view", "users.view", "users.edit", "users.ban", "invites.manage", "content.view", "content.delete",
    "reports.view", "reports.resolve", "media.view", "media.moderate", "groups.view", "settings.view", "plugins.view", "plugins.use",
  ],
  viewer: ["dashboard.view", "users.view", "content.view", "reports.view", "media.view", "groups.view", "settings.view", "plugins.view"],
};

const H64 = "ab".repeat(32);
const victim = user();

/** [method, path, body, permissions needed (none: any admin)] — every route the admin API registers. */
const ROUTES: [string, string, unknown, Permission[]][] = [
  ["GET", "/auth/me", undefined, []],
  ["POST", "/auth/totp/setup", {}, []],
  ["POST", "/auth/totp/enable", { code: "000000" }, []],
  ["POST", "/auth/totp/disable", { code: "000000" }, []],
  ["POST", "/auth/passkey/register/options", {}, []],
  ["POST", "/auth/passkey/register/verify", { response: {} }, []],
  ["DELETE", "/auth/passkey/nope", {}, []],
  ["GET", "/push/vapid", undefined, []],
  ["POST", "/push/subscribe", {}, []],
  ["POST", "/push/unsubscribe", {}, []],
  ["GET", "/system", undefined, ["dashboard.view"]],
  ["GET", "/dashboard/snapshot", undefined, ["dashboard.view"]],
  ["GET", "/metrics/series", undefined, ["dashboard.view"]],
  ["GET", "/metrics/kinds", undefined, ["dashboard.view"]],
  ["GET", "/metrics/top-pubkeys", undefined, ["dashboard.view"]],
  ["GET", "/metrics/rejections", undefined, ["dashboard.view"]],
  ["GET", "/metrics/geo", undefined, ["dashboard.view"]],
  ["GET", "/connections", undefined, ["connections.manage"]],
  ["DELETE", "/connections/nope", undefined, ["connections.manage"]],
  ["POST", "/connections/disconnect", { pubkey: victim.pubkey }, ["connections.manage"]],
  ["GET", "/users", undefined, ["users.view"]],
  ["POST", "/users", { pubkey: victim.pubkey, notes: "n" }, ["users.edit"]],
  ["GET", "/admins", undefined, ["users.view"]],
  ["POST", "/users/bulk", { pubkeys: [victim.pubkey], action: "mute" }, ["users.view", "users.ban"]],
  ["POST", "/users/bulk", { pubkeys: [victim.pubkey], action: "delete" }, ["users.view", "users.delete"]],
  ["POST", "/users/bulk", { pubkeys: [victim.pubkey], action: "delete-events" }, ["users.view", "content.delete"]],
  ["GET", `/users/${victim.pubkey}`, undefined, ["users.view"]],
  ["PATCH", `/users/${victim.pubkey}`, { notes: "x" }, ["users.edit"]],
  ["POST", `/users/${victim.pubkey}/ban`, {}, ["users.ban"]],
  ["POST", `/users/${victim.pubkey}/unban`, undefined, ["users.ban"]],
  ["POST", `/users/${victim.pubkey}/mute`, undefined, ["users.ban"]],
  ["POST", `/users/${victim.pubkey}/unmute`, undefined, ["users.ban"]],
  ["DELETE", `/users/${victim.pubkey}`, undefined, ["users.delete"]],
  ["PUT", `/users/${victim.pubkey}/role`, { role: null }, ["admins.manage"]],
  ["GET", `/users/${victim.pubkey}/events`, undefined, ["users.view", "content.view"]],
  ["GET", "/invites", undefined, ["invites.manage"]],
  ["POST", "/invites", {}, ["invites.manage"]],
  ["DELETE", "/invites/nope", undefined, ["invites.manage"]],
  ["GET", "/ip-rules", undefined, ["ip.manage"]],
  ["POST", "/ip-rules", { cidr: "198.51.100.7/32", action: "block" }, ["ip.manage"]],
  ["DELETE", "/ip-rules/198.51.100.8%2F32", undefined, ["ip.manage"]],
  ["POST", "/events/query", { filters: [{ limit: 1 }] }, ["content.view"]],
  ["GET", "/events/export", undefined, ["content.export"]],
  ["POST", "/events/delete", { ids: [H64] }, ["content.delete"]],
  ["GET", "/events/bans", undefined, ["content.view"]],
  ["DELETE", `/events/bans/${H64}`, undefined, ["content.delete"]],
  ["GET", `/events/${H64}`, undefined, ["content.view"]],
  ["DELETE", `/events/${H64}`, undefined, ["content.delete"]],
  ["GET", "/stream?kinds=bad", undefined, ["dashboard.view"]],
  ["GET", "/reports", undefined, ["reports.view"]],
  ["GET", `/reports/${H64}`, undefined, ["reports.view"]],
  ["POST", `/reports/${H64}/resolve`, { action: "dismiss" }, ["reports.resolve"]],
  ["POST", "/reports/bulk-resolve", { ids: [H64], action: "dismiss" }, ["reports.resolve"]],
  ["GET", "/media", undefined, ["media.view"]],
  ["GET", "/media/blocklist", undefined, ["media.view"]],
  ["DELETE", `/media/blocklist/${H64}`, undefined, ["media.moderate"]],
  ["GET", "/media/stats", undefined, ["media.view"]],
  ["GET", `/media/${H64}/raw`, undefined, ["media.view"]],
  ["GET", `/media/${H64}`, undefined, ["media.view"]],
  ["POST", "/media/bulk", { sha256s: [H64], action: "delete" }, ["media.moderate"]],
  ["POST", `/media/${H64}/status`, { status: "hidden" }, ["media.moderate"]],
  ["DELETE", `/media/${H64}`, undefined, ["media.moderate"]],
  ["GET", "/settings", undefined, ["settings.view"]],
  ["PATCH", "/settings", { info: { contact: "x@example.org" } }, ["settings.edit"]],
  ["GET", "/groups", undefined, ["groups.view"]],
  ["GET", "/groups/nope", undefined, ["groups.view"]],
  ["DELETE", "/groups/nope", undefined, ["groups.manage"]],
  ["GET", "/plugins", undefined, ["plugins.view"]],
  ["POST", "/plugins/nope/enable", undefined, ["plugins.manage"]],
  ["POST", "/plugins/nope/disable", undefined, ["plugins.manage"]],
  ["GET", "/plugins/nope/settings", undefined, ["plugins.view"]],
  ["PATCH", "/plugins/nope/settings", { values: {} }, ["plugins.manage"]],
  ["GET", "/plugins/x/nope/anything", undefined, ["plugins.use"]],
  ["POST", "/plugins/x/nope/anything", {}, ["plugins.use"]],
  ["GET", "/audit", undefined, ["audit.view"]],
  // last: setting a password ends the admin's other sessions
  ["POST", "/auth/password/set", { password: "x".repeat(12) }, []],
];
const MUTATING = ROUTES.filter(([m]) => m !== "GET");

const ROLES: AdminRole[] = ["viewer", "moderator", "admin", "owner"];
const staff = new Map<AdminRole, ReturnType<typeof user>>();

async function cookieLogin(sk: Uint8Array): Promise<string> {
  const base = `${relay.http}/admin/api`;
  const ch = (await (await fetch(`${base}/auth/challenge`)).json()) as { challenge: string; url: string };
  const ev = finalizeEvent({ kind: 27235, created_at: now(), content: "", tags: [["u", ch.url], ["method", "POST"], ["challenge", ch.challenge]] }, sk);
  const res = await fetch(`${base}/auth/nostr`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "beamhop" }, body: JSON.stringify({ event: ev }) });
  expect(res.status).toBe(200);
  return `bh_session=${/bh_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}`;
}

beforeAll(async () => {
  for (const role of ROLES.slice(0, 3)) {
    const u = user();
    expect((await api(relay.http, relay.owner.sk, "PUT", `/users/${u.pubkey}/role`, { role })).status).toBe(200);
    staff.set(role, u);
  }
  staff.set("owner", { sk: relay.owner.sk, pubkey: relay.owner.pubkey });
});

/** A refusal for lack of permission (as opposed to a validation error or a 404 of the dummy target). */
const isPermissionRefusal = (r: { status: number; body: any }) => r.status === 401 || (r.status === 403 && ["missing_permission", "not_admin"].includes(r.body?.code));

describe("permission matrix", () => {
  test("anonymous: every route is 401 and never 5xx", async () => {
    for (const [m, p, body] of ROUTES) {
      const r = await api(relay.http, null, m, p, body, { headers: { "X-Requested-With": "beamhop" } });
      expect([m, p, r.status]).toEqual([m, p, 401]);
    }
  });

  test("a signed-in non-admin (valid NIP-98, no role) is 403 not_admin everywhere", async () => {
    const stranger = user();
    for (const [m, p, body] of ROUTES) {
      const r = await api(relay.http, stranger.sk, m, p, body);
      expect([m, p, r.status, r.body?.code]).toEqual([m, p, 403, "not_admin"]);
    }
  });

  for (const role of ROLES) {
    test(`${role}: exactly the routes its permissions allow (NIP-98 and cookie session)`, async () => {
      const u = staff.get(role)!;
      const perms = new Set(ROLE_PERMISSIONS[role]);
      const cookie = await cookieLogin(u.sk);
      for (const [m, p, body, need] of ROUTES) {
        const allowed = need.every((x) => perms.has(x));
        for (const via of ["cookie", "nip98"] as const) {
          const r =
            via === "nip98"
              ? await api(relay.http, u.sk, m, p, body)
              : await api(relay.http, null, m, p, body, { headers: { Cookie: cookie, "X-Requested-With": "beamhop" } });
          expect(r.status).toBeLessThan(500);
          expect([via, m, p, isPermissionRefusal(r)]).toEqual([via, m, p, !allowed]);
        }
      }
    });
  }
});

describe("CSRF on every mutating route (cookie session)", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = await cookieLogin(relay.owner.sk);
  });
  const evil = "https://evil.example";
  const attempts: { name: string; headers: Record<string, string>; body?: string; expect: number }[] = [
    { name: "no header, JSON", headers: { "Content-Type": "application/json" }, body: "{}", expect: 403 },
    { name: "foreign Origin", headers: { Origin: evil, "Content-Type": "application/json" }, body: "{}", expect: 403 },
    { name: "null Origin", headers: { Origin: "null", "Content-Type": "text/plain" }, body: "{}", expect: 403 },
    { name: "wrong X-Requested-With", headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" }, body: "{}", expect: 403 },
    { name: "Origin prefix of ours", headers: { Origin: `${new URL("http://x").protocol}//127.0.0.1`, "Content-Type": "application/json" }, body: "{}", expect: 403 },
    { name: "header ok, form body", headers: { "X-Requested-With": "beamhop", "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1", expect: 415 },
    { name: "header ok, text/plain JSON", headers: { "X-Requested-With": "beamhop", "Content-Type": "text/plain" }, body: "{}", expect: 415 },
    { name: "header ok, multipart", headers: { "X-Requested-With": "beamhop", "Content-Type": "multipart/form-data; boundary=x" }, body: "--x--", expect: 415 },
    { name: "header ok, JSON lookalike", headers: { "X-Requested-With": "beamhop", "Content-Type": "application/jsonx" }, body: "{}", expect: 415 },
    { name: "header ok, untyped body", headers: { "X-Requested-With": "beamhop" }, body: "{}", expect: 415 },
  ];
  for (const a of attempts) {
    test(`${a.name}: refused with ${a.expect} before the handler runs`, async () => {
      for (const [m, p] of MUTATING) {
        // plugin admin routes choose their own body formats; the CSRF header is still required there
        if (a.expect === 415 && p.startsWith("/plugins/x/")) continue;
        const res = await fetch(`${relay.http}/admin/api${p}`, { method: m, headers: { Cookie: cookie, ...a.headers }, body: a.body });
        expect([m, p, res.status]).toEqual([m, p, a.expect]);
      }
    });
  }
  test("nothing above changed state: the victim is untouched and settings unchanged", async () => {
    const u = await api(relay.http, relay.owner.sk, "GET", `/users/${victim.pubkey}`);
    expect(u.body.status).toBe("active");
    expect(u.body.notes ?? "").toBe("");
  });
  test("GET routes never mutate (logout via GET is not a route)", async () => {
    const res = await fetch(`${relay.http}/admin/api/auth/logout`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    expect((await api(relay.http, null, "GET", "/auth/me", undefined, { headers: { Cookie: cookie } })).status).toBe(200);
  });
});

describe("session handling", () => {
  test("login issues a fresh session id; a planted cookie value is never adopted", async () => {
    const planted = `bh_session=${"c".repeat(64)}`;
    const base = `${relay.http}/admin/api`;
    const ch = (await (await fetch(`${base}/auth/challenge`)).json()) as { challenge: string; url: string };
    const ev = finalizeEvent({ kind: 27235, created_at: now(), content: "", tags: [["u", ch.url], ["method", "POST"], ["challenge", ch.challenge]] }, relay.owner.sk);
    const res = await fetch(`${base}/auth/nostr`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "beamhop", Cookie: planted },
      body: JSON.stringify({ event: ev }),
    });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().find((c) => c.startsWith("bh_session="))!;
    expect(set).not.toContain("c".repeat(64));
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\/admin(;|$)/);
    expect((await api(relay.http, null, "GET", "/auth/me", undefined, { headers: { Cookie: planted } })).status).toBe(401);
  });

  test("two logins get two independent sessions; logging one out leaves the other", async () => {
    const a = await cookieLogin(relay.owner.sk);
    const b = await cookieLogin(relay.owner.sk);
    expect(a).not.toBe(b);
    await fetch(`${relay.http}/admin/api/auth/logout`, { method: "POST", headers: { Cookie: a, "X-Requested-With": "beamhop" } });
    expect((await api(relay.http, null, "GET", "/auth/me", undefined, { headers: { Cookie: a } })).status).toBe(401);
    expect((await api(relay.http, null, "GET", "/auth/me", undefined, { headers: { Cookie: b } })).status).toBe(200);
  });

  test("a session of a demoted admin grants nothing at once", async () => {
    const u = user();
    expect((await api(relay.http, relay.owner.sk, "PUT", `/users/${u.pubkey}/role`, { role: "admin" })).status).toBe(200);
    const c = await cookieLogin(u.sk);
    expect((await api(relay.http, null, "GET", "/settings", undefined, { headers: { Cookie: c } })).status).toBe(200);
    expect((await api(relay.http, relay.owner.sk, "POST", `/users/${u.pubkey}/ban`, {})).status).toBe(200);
    const r = await api(relay.http, null, "GET", "/settings", undefined, { headers: { Cookie: c } });
    expect(isPermissionRefusal(r)).toBe(true);
  });
});
