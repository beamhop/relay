import { describe, expect, test } from "bun:test";
import {
  HookRegistry,
  type BlobRecord,
  type Db,
  type MediaStatusRequest,
  type NostrEvent,
  type NostrLoginRequest,
  type PasswordLoginRequest,
  type RoleRequest,
  type UserQuery,
  type UserRecord,
} from "@beamhop/sdk";
import { createTestStores } from "@beamhop/storage";
import { createAdminApi } from "../src";
import { CredentialService } from "../src/services/credentials";
import * as totp from "../src/util/totp";
import { cookieFrom, createHarness, newKey, nip98Header, PANEL_HEADERS, PUBLIC_URL, signEvent, type Key } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;
type Nip86 = (req: Request, env?: { ip?: string }) => Promise<Response>;

const rpc = async (h: Harness, k: Key, method: string, params: unknown[] = [], ip?: string) => {
  const body = JSON.stringify({ method, params });
  const headers = { "content-type": "application/nostr+json+rpc", authorization: nip98Header(k, PUBLIC_URL, "POST", body, [], Math.floor(h.clock.now / 1000)) };
  const res = await (h.api.nip86 as Nip86)(new Request(`${PUBLIC_URL}/`, { method: "POST", body, headers }), ip ? { ip } : undefined);
  return (await res.json()) as { result: unknown; error?: string };
};

const blob = (sha: string, owners: string[]): BlobRecord => ({
  sha256: sha, size: 1, type: "image/png", owners, createdAt: 1, status: "approved", hasThumbnail: false, url: `${PUBLIC_URL}/${sha}.png`,
});

/** what an auto-submitting `<form enctype="text/plain">` on another site sends: a JSON-looking body, no custom header */
const formBody = (o: Record<string, unknown>) => `${JSON.stringify(o).slice(0, -1)},"x":"="}`;

async function withPassword(h: Harness, password = "correct horse battery") {
  const cookie = await h.login(h.owner);
  expect((await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password } })).status).toBe(200);
  return cookie;
}

// ------------------------------------------------------------------ 1. media moderation follows the ranks

describe("media moderation ranks", () => {
  test("a moderator can't delete, block or hide an owner's blob; approving and lower-ranked uploaders are fine", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const own = "a".repeat(64);
    const spam = "b".repeat(64);
    h.blossom!.blobs.set(own, blob(own, [h.owner.pk]));
    h.blossom!.blobs.set(spam, blob(spam, [newKey().pk]));

    const del = await h.asKey(mod, `/media/${own}?block=true`, { method: "DELETE" });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { code: string }).code).toBe("forbidden_target");
    expect(h.blossom!.blobs.has(own)).toBe(true);
    expect((await h.asKey(mod, `/media/${own}/status`, { method: "POST", body: { status: "blocked" } })).status).toBe(403);
    expect((await h.asKey(mod, `/media/${own}/status`, { method: "POST", body: { status: "pending" } })).status).toBe(403);
    expect((await h.asKey(mod, `/media/${own}/status`, { method: "POST", body: { status: "approved" } })).status).toBe(200);

    expect((await h.asKey(mod, `/media/${spam}?block=true`, { method: "DELETE" })).status).toBe(200);
    expect(h.blossom!.blocked.has(spam)).toBe(true);
    // no stored blob, no uploader to protect: a known-bad hash can be blocked ahead of an upload
    expect((await h.asKey(mod, `/media/${"c".repeat(64)}?block=true`, { method: "DELETE" })).status).toBe(200);
    // the owner outranks everyone
    expect((await h.asKey(h.owner, `/media/${own}`, { method: "DELETE" })).status).toBe(200);
  });

  test("a co-uploaded blob is protected by its highest-ranked uploader", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const sha = "d".repeat(64);
    h.blossom!.blobs.set(sha, blob(sha, [newKey().pk, admin.pk]));
    expect((await h.asKey(mod, `/media/${sha}`, { method: "DELETE" })).status).toBe(403);
  });

  test("bulk: refused blobs are reported per hash (MediaBulkResult, no sha256 in `pubkey`), the rest proceed", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const own = "a".repeat(64);
    const spam = "b".repeat(64);
    h.blossom!.blobs.set(own, blob(own, [h.owner.pk]));
    h.blossom!.blobs.set(spam, blob(spam, [newKey().pk]));
    const res = await h.asKey(mod, "/media/bulk", { method: "POST", body: { sha256s: [own, spam], action: "delete" } });
    const r = (await res.json()) as { ok: number; failed: Record<string, string>[] };
    expect(r.ok).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].sha256).toBe(own);
    expect(r.failed[0].pubkey).toBeUndefined();
    expect(h.blossom!.blobs.has(own)).toBe(true);
    expect(h.blossom!.blobs.has(spam)).toBe(false);
    // approving takes nothing away from the uploader
    const ok = (await (await h.asKey(mod, "/media/bulk", { method: "POST", body: { sha256s: [own], action: "approve" } })).json()) as { ok: number };
    expect(ok.ok).toBe(1);
  });

  test("a report naming an owner's blob can't make a moderator delete it", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const sha = "e".repeat(64);
    h.blossom!.blobs.set(sha, blob(sha, [h.owner.pk]));
    const report = signEvent(newKey(), 1984, [["x", sha, "malware"], ["p", h.owner.pk]]);
    await h.relay.publish(report, "api");
    const res = await h.asKey(mod, `/reports/${report.id}/resolve`, { method: "POST", body: { action: "delete-media" } });
    expect(res.status).toBe(403);
    expect(h.blossom!.blobs.has(sha)).toBe(true);
    expect(h.blossom!.blocked.has(sha)).toBe(false);
    expect((await h.asKey(h.owner, `/reports/${report.id}/resolve`, { method: "POST", body: { action: "delete-media" } })).status).toBe(200);
    expect(h.blossom!.blocked.has(sha)).toBe(true);
  });
});

// ------------------------------------------------------------------ 2 + 3. deleting staff / removing roles

describe("removing admin access", () => {
  const addCredentials = async (h: Harness, pk: string) => {
    await h.stores.db.run("INSERT INTO admin_credentials (pubkey, password_hash, totp_secret, updated_at, password_set_at) VALUES (?, 'scrypt$x', 'SECRET', 1, 1)", [pk]);
    await h.stores.db.run("INSERT INTO admin_passkeys (id, pubkey, public_key, counter, transports, name, created_at) VALUES (?, ?, 'pk', 0, '[]', 'key', 1)", [`cred-${pk.slice(0, 8)}`, pk]);
    await h.stores.db.run("INSERT INTO admin_push_subscriptions (endpoint, pubkey, subscription, topics, created_at, session_id) VALUES (?, ?, '{}', '[]', 1, NULL)", [
      `https://fcm.googleapis.com/fcm/send/${pk.slice(0, 8)}`,
      pk,
    ]);
  };
  const leftovers = async (h: Harness, pk: string) => ({
    credentials: (await h.stores.db.all("SELECT pubkey FROM admin_credentials WHERE pubkey = ?", [pk])).length,
    passkeys: (await h.stores.db.all("SELECT id FROM admin_passkeys WHERE pubkey = ?", [pk])).length,
    push: (await h.stores.db.all("SELECT endpoint FROM admin_push_subscriptions WHERE pubkey = ?", [pk])).length,
  });

  test("deleting a user who has a role needs admins.manage (single and bulk); non-staff don't", async () => {
    const h = await createHarness();
    const admin = await h.addAdmin("admin");
    const mod = await h.addAdmin("moderator");
    const res = await h.asKey(admin, `/users/${mod.pk}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("missing_permission");
    expect((await h.stores.users.get(mod.pk))?.role).toBe("moderator");
    const bulk = (await (await h.asKey(admin, "/users/bulk", { method: "POST", body: { pubkeys: [mod.pk], action: "delete" } })).json()) as { ok: number; failed: unknown[] };
    expect(bulk).toMatchObject({ ok: 0, failed: [{ pubkey: mod.pk }] });
    expect((await h.stores.users.get(mod.pk))?.role).toBe("moderator");

    const plain = newKey();
    await h.stores.users.upsert(plain.pk, { notes: "x" });
    expect((await h.asKey(admin, `/users/${plain.pk}`, { method: "DELETE" })).status).toBe(200);

    expect((await h.asKey(h.owner, `/users/${mod.pk}`, { method: "DELETE" })).status).toBe(200);
    expect(h.audit.entries.find((e) => e.action === "user.delete" && e.target === mod.pk)?.details).toMatchObject({ role: "moderator" });
  });

  test("removing a role drops password, TOTP, passkeys and push devices, so re-granting it doesn't revive them", async () => {
    const h = await createHarness();
    const admin = await h.addAdmin("admin");
    await addCredentials(h, admin.pk);
    expect((await h.asKey(h.owner, `/users/${admin.pk}/role`, { method: "PUT", body: { role: null } })).status).toBe(200);
    expect(await leftovers(h, admin.pk)).toEqual({ credentials: 0, passkeys: 0, push: 0 });
    // a role change that keeps access keeps the factors
    const mod = await h.addAdmin("moderator");
    await addCredentials(h, mod.pk);
    expect((await h.asKey(h.owner, `/users/${mod.pk}/role`, { method: "PUT", body: { role: "viewer" } })).status).toBe(200);
    expect(await leftovers(h, mod.pk)).toEqual({ credentials: 1, passkeys: 1, push: 1 });
  });

  test("deleting a user (single or bulk) drops their login factors and push devices too", async () => {
    const h = await createHarness();
    const a = await h.addAdmin("viewer");
    const b = await h.addAdmin("viewer");
    await addCredentials(h, a.pk);
    await addCredentials(h, b.pk);
    expect((await h.asKey(h.owner, `/users/${a.pk}`, { method: "DELETE" })).status).toBe(200);
    expect(((await (await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: [b.pk], action: "delete" } })).json()) as { ok: number }).ok).toBe(1);
    expect(await leftovers(h, a.pk)).toEqual({ credentials: 0, passkeys: 0, push: 0 });
    expect(await leftovers(h, b.pk)).toEqual({ credentials: 0, passkeys: 0, push: 0 });
  });
});

// ------------------------------------------------------------------ 4. CSRF on every mutating route

describe("CSRF and body type on unauthenticated routes", () => {
  test("a cross-site text/plain form can't log a browser in (login CSRF)", async () => {
    const h = await createHarness();
    await withPassword(h);
    const body = formBody({ login: h.owner.pk, password: "correct horse battery" });
    const cross = await h.api.app.request("/auth/password", { method: "POST", body, headers: { "content-type": "text/plain", origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { code: string }).code).toBe("csrf");
    expect(cookieFrom(cross)).toBeUndefined();
    // a form can't send the custom header; with it, a non-JSON body is still refused
    const typed = await h.api.app.request("/auth/password", { method: "POST", body, headers: { "content-type": "text/plain", "x-requested-with": "beamhop" } });
    expect(typed.status).toBe(415);
    const urlencoded = await h.api.app.request("/auth/password", {
      method: "POST",
      body: "login=x&password=y",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL },
    });
    expect(urlencoded.status).toBe(415);
    // the panel: JSON plus the header (or its own Origin)
    const panel = { login: h.owner.pk, password: "correct horse battery" };
    expect((await h.api.app.request("/auth/password", { method: "POST", body: JSON.stringify(panel), headers: PANEL_HEADERS })).status).toBe(200);
    const sameOrigin = await h.api.app.request("/auth/password", {
      method: "POST",
      body: JSON.stringify(panel),
      headers: { "content-type": "application/json; charset=utf-8", origin: PUBLIC_URL },
    });
    expect(sameOrigin.status).toBe(200);
  });

  test("nostr and passkey logins need the CSRF proof too", async () => {
    const h = await createHarness();
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    const event = signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]], "", Math.floor(h.clock.now / 1000));
    const bare = await h.api.app.request("/auth/nostr", { method: "POST", body: JSON.stringify({ event }), headers: { "content-type": "application/json" } });
    expect(bare.status).toBe(403);
    expect((await h.api.app.request("/auth/passkey/login/options", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
    expect((await h.api.app.request("/auth/nostr", { method: "POST", body: JSON.stringify({ event }), headers: PANEL_HEADERS })).status).toBe(200);
  });

  test("NIP-98 callers (no Origin, no X-Requested-With) and bodyless panel DELETEs keep working; import takes NDJSON", async () => {
    const h = await createHarness();
    const target = newKey();
    const body = JSON.stringify({ reason: "x" });
    const nip98 = await h.api.app.request(`/users/${target.pk}/ban`, {
      method: "POST",
      body,
      headers: { authorization: nip98Header(h.owner, h.url(`/users/${target.pk}/ban`), "POST", body, [], Math.floor(h.clock.now / 1000)), "content-type": "application/json" },
    });
    expect(nip98.status).toBe(200);

    const cookie = await h.login(h.owner);
    const created = (await (await h.withCookie(cookie, "/invites", { method: "POST", body: {} })).json()) as { items: { code: string }[] };
    // what the panel's api.del sends without a body: the CSRF header, no Content-Type
    const del = await h.api.app.request(`/invites/${created.items[0].code}`, { method: "DELETE", headers: { cookie, "x-requested-with": "beamhop" } });
    expect(del.status).toBe(200);

    const ev = signEvent(newKey(), 1, [], "hi");
    const imp = await h.api.app.request("/events/import", {
      method: "POST",
      body: `${JSON.stringify(ev)}\n`,
      headers: { cookie, "x-requested-with": "beamhop", "content-type": "application/x-ndjson" },
    });
    expect(imp.status).toBe(200);
    // NDJSON is for the import route only
    const ndjsonElsewhere = await h.api.app.request(`/users/${target.pk}/mute`, { method: "POST", body: "{}", headers: { cookie, "x-requested-with": "beamhop", "content-type": "application/x-ndjson" } });
    expect(ndjsonElsewhere.status).toBe(415);
  });
});

// ------------------------------------------------------------------ 5. NIP-86 event bans carry the banner's rank

describe("NIP-86 event ban ranks", () => {
  test("a moderator can't lift an owner's ban (unbanevent / allowevent) and a refused allowevent changes nothing", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const ev = signEvent(newKey(), 1, [], "spam");
    await h.events.save(ev);
    const report = signEvent(newKey(), 1984, [["e", ev.id, "spam"], ["p", ev.pubkey]]);
    await h.relay.publish(report, "api");
    expect((await rpc(h, h.owner, "banevent", [ev.id, "owner ban"])).result).toBe(true);
    // banevent resolved the open report; reopen it to see that a refused allowevent doesn't dismiss it
    await h.stores.db.run("DELETE FROM admin_report_status WHERE report_id = ?", [report.id]);

    const unban = await rpc(h, mod, "unbanevent", [ev.id]);
    expect(unban.error).toContain("forbidden");
    const allow = await rpc(h, mod, "allowevent", [ev.id]);
    expect(allow.error).toContain("forbidden");
    expect(((await rpc(h, h.owner, "listbannedevents")).result as { id: string }[]).map((r) => r.id)).toEqual([ev.id]);
    expect(await h.stores.db.all("SELECT status FROM admin_report_status WHERE report_id = ?", [report.id])).toHaveLength(0);
    expect((await rpc(h, h.owner, "unbanevent", [ev.id])).result).toBe(true);
    expect((await rpc(h, h.owner, "listbannedevents")).result).toEqual([]);
  });

  test("re-banning by a lower role keeps the higher-ranked ban on record; peers can lift each other's", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const mod2 = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const ev = signEvent(newKey(), 1, [], "spam");
    await h.events.save(ev);
    expect((await rpc(h, admin, "banevent", [ev.id])).result).toBe(true);
    // stored again (e.g. a bypassPolicies import), then banned again by a moderator
    await h.events.save(ev);
    expect((await rpc(h, mod, "banevent", [ev.id])).result).toBe(true);
    expect((await rpc(h, mod, "unbanevent", [ev.id])).error).toContain("role admin");

    const ev2 = signEvent(newKey(), 1, [], "spam");
    await h.events.save(ev2);
    expect((await rpc(h, mod, "banevent", [ev2.id])).result).toBe(true);
    expect((await rpc(h, mod2, "unbanevent", [ev2.id])).result).toBe(true);
  });

  test("banning an id that isn't stored here needs the owner role", async () => {
    const h = await createHarness();
    const admin = await h.addAdmin("admin");
    const id = "9".repeat(64);
    expect((await rpc(h, admin, "banevent", [id])).error).toContain("owner");
    expect((await rpc(h, h.owner, "banevent", [id])).result).toBe(true);
  });

  test("bans from before roles were recorded fall back to the banner's current rank", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const id = "8".repeat(64);
    await h.stores.db.run("INSERT INTO admin_banned_events (id, reason, by, at) VALUES (?, '', ?, 1)", [id, h.owner.pk]);
    expect((await rpc(h, mod, "unbanevent", [id])).error).toContain("role owner");
  });
});

// ------------------------------------------------------------------ 6. report floods

describe("report push coalescing", () => {
  test("a flood of reports costs one push now and one digest per interval, not one per report", async () => {
    const sent: { title: string; tag: string }[] = [];
    const h = await createHarness({ pushSender: async (_s, payload) => void sent.push(JSON.parse(payload)), reportPushIntervalMs: 60 });
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "k", auth: "a" } };
    expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: { subscription: sub, topics: ["reports"] } })).status).toBe(200);
    for (let i = 0; i < 5; i++) await h.relay.publish(signEvent(newKey(), 1984, [["p", newKey().pk, `${"x".repeat(500)}${i}`]]), "api");
    await Bun.sleep(20);
    expect(sent).toHaveLength(1);
    // the reporter-chosen type is cut before it reaches the notification
    expect(sent[0].title.length).toBeLessThanOrEqual("New report: ".length + 32);
    await Bun.sleep(80);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ title: "4 more new reports", tag: "reports-digest" });
    // nothing pending: the next interval stays quiet, and the report after it is sent on its own again
    await Bun.sleep(80);
    expect(sent).toHaveLength(2);
    await h.relay.publish(signEvent(newKey(), 1984, [["p", newKey().pk, "spam"]]), "api");
    await Bun.sleep(20);
    expect(sent).toHaveLength(3);
    expect(sent[2].title).toBe("New report: spam");
  });

  test("report types are capped in listings too", async () => {
    const h = await createHarness();
    await h.relay.publish(signEvent(newKey(), 1984, [["p", newKey().pk, "y".repeat(5000)]]), "api");
    const list = (await (await h.asKey(h.owner, "/reports")).json()) as { items: { type: string }[] };
    expect(list.items[0].type).toBe("y".repeat(32));
  });
});

// ------------------------------------------------------------------ 7. audit completeness

describe("audit completeness", () => {
  test("bulk user actions record every target", async () => {
    const h = await createHarness();
    const pubkeys = Array.from({ length: 150 }, () => newKey().pk);
    expect((await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys, action: "mute" } })).status).toBe(200);
    const entry = h.audit.entries.find((e) => e.action === "user.bulk.mute")!;
    expect((entry.details.pubkeys as string[]).sort()).toEqual([...pubkeys].sort());
  });

  test("event deletes and report bulk-resolves record every id; report bulk failures carry `id`, not `pubkey`", async () => {
    const h = await createHarness();
    const evs = Array.from({ length: 120 }, (_, i) => signEvent(newKey(), 1, [], `e${i}`));
    for (const e of evs) await h.events.save(e);
    expect((await h.asKey(h.owner, "/events/delete", { method: "POST", body: { ids: evs.map((e) => e.id) } })).status).toBe(200);
    expect(h.audit.entries.find((e) => e.action === "event.delete")!.details.ids).toHaveLength(120);

    const ids = Array.from({ length: 110 }, (_, i) => i.toString(16).padStart(64, "0"));
    const bulk = (await (await h.asKey(h.owner, "/reports/bulk-resolve", { method: "POST", body: { ids, action: "dismiss" } })).json()) as {
      failed: Record<string, string>[];
    };
    expect(bulk.failed[0].id).toBe(ids[0]);
    expect(bulk.failed[0].pubkey).toBeUndefined();
    expect(h.audit.entries.find((e) => e.action === "report.bulk-resolve")!.details.ids).toHaveLength(110);
  });

  test("NIP-86 audit entries carry the client IP and reach the admin.action bus event", async () => {
    const h = await createHarness();
    const seen: { action: string; ip: string | null }[] = [];
    h.bus.on("admin.action", ({ entry }) => void seen.push({ action: entry.action, ip: entry.ip }));
    expect((await rpc(h, h.owner, "banpubkey", [newKey().pk, "spam"], "::ffff:198.51.100.4")).result).toBe(true);
    expect(h.audit.entries.find((e) => e.action === "user.ban")?.ip).toBe("198.51.100.4");
    expect(seen).toContainEqual({ action: "user.ban", ip: "198.51.100.4" });
  });
});

// ------------------------------------------------------------------ 8. banned event ids are shared through the database

describe("banned event ids across instances", () => {
  const write = (hooks: HookRegistry, ev: NostrEvent) => hooks.runWrite(ev, { source: "ws" } as never);

  test("a ban placed on one instance is enforced by another sharing the database, and lifted the same way", async () => {
    const h = await createHarness();
    const hooksB = new HookRegistry();
    await createAdminApi({ ...h.deps, hooks: hooksB }, { now: () => h.clock.now, bannedEventsTtlMs: 0 });
    const ev = signEvent(newKey(), 1, [], "spam");
    expect((await write(hooksB, ev)).result).toBe("next");
    expect((await rpc(h, h.owner, "banevent", [ev.id])).result).toBe(true);
    const blocked = await write(hooksB, ev);
    expect(blocked.result).toBe("reject");
    expect(blocked.reason).toContain("banned");
    expect((await rpc(h, h.owner, "unbanevent", [ev.id])).result).toBe(true);
    expect((await write(hooksB, ev)).result).toBe("next");
  });

  test("when the id list can't be loaded each write is checked in the database; when that fails too the write is refused", async () => {
    const h = await createHarness();
    const ev = signEvent(newKey(), 1, [], "spam");
    await h.stores.db.run("INSERT INTO admin_banned_events (id, reason, by, at, by_role) VALUES (?, '', ?, 1, 'owner')", [ev.id, h.owner.pk]);
    const other = signEvent(newKey(), 1, [], "fine");
    let getFails = false;
    const db = new Proxy(h.stores.db, {
      get(target, prop, recv) {
        if (prop === "all") {
          return (sql: string, params?: unknown[]) => (/admin_banned_events/.test(sql) ? Promise.reject(new Error("db down")) : target.all(sql, params));
        }
        if (prop === "get") {
          return (sql: string, params?: unknown[]) => (getFails && /admin_banned_events/.test(sql) ? Promise.reject(new Error("db down")) : target.get(sql, params));
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    const hooks = new HookRegistry();
    await createAdminApi({ ...h.deps, hooks, stores: { ...h.deps.stores, db } }, { now: () => h.clock.now });
    expect((await write(hooks, ev)).result).toBe("reject");
    expect((await write(hooks, other)).result).toBe("next");
    getFails = true;
    // fail closed: never silently stop enforcing
    expect((await write(hooks, other)).result).toBe("reject");
  });
});

// ------------------------------------------------------------------ 9. NIP-86 lists page through the user store

describe("NIP-86 list paging", () => {
  test("listbannedpubkeys / listallowedpubkeys return everyone, though the store caps each page at 1000", async () => {
    const h = await createHarness();
    const list = h.stores.users.list.bind(h.stores.users);
    h.stores.users.list = (q: UserQuery) => list({ ...q, limit: Math.min(q.limit ?? 50, 1000) });
    for (let i = 0; i < 1500; i++) await h.stores.users.upsert(i.toString(16).padStart(64, "0"), { status: "banned", allowed: i % 2 === 0 });
    expect((await rpc(h, h.owner, "listbannedpubkeys")).result).toHaveLength(1500);
    expect((await rpc(h, h.owner, "listallowedpubkeys")).result).toHaveLength(750);
  });
});

// ------------------------------------------------------------------ 10 + 11. dead code, contract

describe("removed code paths and contract shapes", () => {
  test("forwarding headers are never read by the admin API (only the adapter-bound env.ip)", async () => {
    const h = await createHarness();
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    const event = signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]], "", Math.floor(h.clock.now / 1000));
    const res = await h.api.app.request("/auth/nostr", { method: "POST", body: JSON.stringify({ event }), headers: { ...PANEL_HEADERS, "x-forwarded-for": "6.6.6.6" } });
    expect(res.status).toBe(200);
    expect(h.audit.entries.find((e) => e.action === "auth.login")?.ip).not.toBe("6.6.6.6");
  });

  test("the NIP-86 handler has no preflight branch of its own; unused helpers are gone", async () => {
    const h = await createHarness();
    expect((await h.api.nip86(new Request(PUBLIC_URL, { method: "OPTIONS" }))).status).toBe(405);
    expect("verifyTotp" in totp).toBe(false);
    expect("hasPassword" in CredentialService.prototype).toBe(false);
  });

  test("challenge carries the login url; settings carry no schema; user events filter by kinds", async () => {
    const h = await createHarness();
    expect(((await (await h.req("/auth/challenge")).json()) as { url: string }).url).toBe(h.url("/auth/nostr"));
    expect(Object.keys((await (await h.asKey(h.owner, "/settings")).json()) as object)).toEqual(["settings"]);
    const u = newKey();
    await h.events.save(signEvent(u, 1, [], "a"));
    await h.events.save(signEvent(u, 7, [], "+"));
    const r = (await (await h.asKey(h.owner, `/users/${u.pk}/events?kinds=7`)).json()) as { items: NostrEvent[] };
    expect(r.items.map((e) => e.kind)).toEqual([7]);
  });
});

// ------------------------------------------------------------------ 12. import body cap

describe("import body cap", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify(signEvent(newKey(), 1, [], `line ${i}`))).join("\n") + "\n";

  test("a declared Content-Length over the cap is refused before anything is imported", async () => {
    const h = await createHarness({ importMaxBytes: 2000 });
    const body = lines(10);
    const res = await h.asKey(h.owner, "/events/import", { method: "POST", body, headers: { "content-type": "application/x-ndjson", "content-length": String(body.length) } });
    expect(res.status).toBe(413);
    expect(h.events.events.size).toBe(0);
  });

  test("a streamed (chunked) body is cut at the cap: what came before stays imported and the 413 says how much", async () => {
    const h = await createHarness({ importMaxBytes: 2000 });
    const text = lines(10);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (let i = 0; i < text.length; i += 500) ctl.enqueue(enc.encode(text.slice(i, i + 500)));
        ctl.close();
      },
    });
    const cookie = await h.login(h.owner);
    const res = await h.req("/events/import", { method: "POST", body: stream, headers: { cookie, "x-requested-with": "beamhop", "content-type": "application/x-ndjson" }, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain("imported");
    const entry = h.audit.entries.find((e) => e.action === "event.import")!;
    expect(entry.details.truncatedAtBytes).toBe(2000);
    expect(entry.details.imported as number).toBeGreaterThan(0);
    expect(entry.details.imported as number).toBeLessThan(10);
  });
});

// ------------------------------------------------------------------ follow-ups

describe("plugin admin routes take any body", () => {
  test("an untyped binary upload (Uint8Array / Blob without a type) reaches the plugin; CSRF still applies", async () => {
    const h = await createHarness();
    h.deps.plugins.adminRoutes.post("/demo/upload", async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    const cookie = await h.login(h.owner);
    const send = (body: BodyInit, extra: Record<string, string> = {}) =>
      h.api.app.request("/plugins/x/demo/upload", { method: "POST", body, headers: { cookie, "content-length": "3", ...extra } });
    const bytes = await send(new Uint8Array([1, 2, 3]), { "x-requested-with": "beamhop" });
    expect(bytes.status).toBe(200);
    expect(await bytes.json()).toEqual({ bytes: 3 });
    expect((await send(new Blob([new Uint8Array([1, 2, 3])]), { "x-requested-with": "beamhop" })).status).toBe(200);
    expect((await send(new Uint8Array([1, 2, 3]))).status).toBe(403);
  });
});

describe("audit list caps", () => {
  test("id lists are stored up to 1000 entries, with the full count and a truncated flag", async () => {
    const h = await createHarness();
    const ids = Array.from({ length: 1500 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect((await h.asKey(h.owner, "/events/delete", { method: "POST", body: { ids } })).status).toBe(200);
    const d = h.audit.entries.find((e) => e.action === "event.delete")!.details;
    expect(d.ids).toHaveLength(1000);
    expect(d.idsCount).toBe(1500);
    expect(d.truncated).toBe(true);
    // short lists are kept whole and unflagged
    await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: [newKey().pk], action: "mute" } });
    const u = h.audit.entries.find((e) => e.action === "user.bulk.mute")!.details;
    expect(u).toMatchObject({ pubkeysCount: 1, failedCount: 0 });
    expect(u.truncated).toBeUndefined();
  });
});

describe("NIP-86 list paging order", () => {
  test("pages are taken in pubkey order, so activity between pages can't skip or repeat users", async () => {
    const h = await createHarness();
    const users = (h.stores.users as unknown as { users: Map<string, UserRecord> }).users;
    for (let i = 0; i < 2500; i++) await h.stores.users.upsert(i.toString(16).padStart(64, "0"), { status: "banned", lastSeenAt: i });
    const sorts = new Set<unknown>();
    let tick = 1_000_000;
    // a store like the real one (≤1000 rows per call, ordered as asked) whose users keep being seen while we page
    h.stores.users.list = async (q: UserQuery) => {
      sorts.add(q.sort);
      const items = [...users.values()].filter((u) => !q.status || u.status === q.status);
      const byPubkey = (a: UserRecord, b: UserRecord) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0);
      items.sort(q.sort === "pubkey" ? byPubkey : (a, b) => b.lastSeenAt - a.lastSeenAt || byPubkey(a, b));
      const off = q.offset ?? 0;
      const page = items.slice(off, off + Math.min(q.limit ?? 50, 1000));
      for (const u of page) u.lastSeenAt = ++tick;
      return { items: page, total: items.length };
    };
    const list = (await rpc(h, h.owner, "listbannedpubkeys")).result as { pubkey: string }[];
    expect(new Set(list.map((u) => u.pubkey)).size).toBe(2500);
    expect([...sorts]).toEqual(["pubkey"]);
  });

  test("the SQL user store orders by pubkey alone for sort: pubkey", async () => {
    const stores = await createTestStores();
    const pks = ["c", "a", "b"].map((x) => x.repeat(64));
    for (const [i, pk] of pks.entries()) await stores.users.upsert(pk, { lastSeenAt: 100 - i, firstSeenAt: i });
    const { items } = await stores.users.list({ sort: "pubkey", limit: 10 });
    expect(items.map((u) => u.pubkey)).toEqual([...pks].sort());
  });
});

describe("undoing media moderation follows the ranks", () => {
  test("approving a blob hidden by a higher role needs that role; peers may undo each other", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const mod2 = await h.addAdmin("moderator");
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    h.blossom!.blobs.set(a, blob(a, [newKey().pk]));
    h.blossom!.blobs.set(b, blob(b, [newKey().pk]));
    expect((await h.asKey(h.owner, `/media/${a}/status`, { method: "POST", body: { status: "blocked" } })).status).toBe(200);
    const approve = await h.asKey(mod, `/media/${a}/status`, { method: "POST", body: { status: "approved" } });
    expect(approve.status).toBe(403);
    expect(((await approve.json()) as { code: string }).code).toBe("forbidden_target");
    const bulk = (await (await h.asKey(mod, "/media/bulk", { method: "POST", body: { sha256s: [a], action: "approve" } })).json()) as { ok: number; failed: { sha256: string }[] };
    expect(bulk).toMatchObject({ ok: 0, failed: [{ sha256: a }] });
    expect(h.blossom!.blobs.get(a)!.status).toBe("blocked");

    expect((await h.asKey(mod, `/media/${b}/status`, { method: "POST", body: { status: "pending" } })).status).toBe(200);
    expect((await h.asKey(mod2, `/media/${b}/status`, { method: "POST", body: { status: "approved" } })).status).toBe(200);
    expect((await h.asKey(h.owner, `/media/${a}/status`, { method: "POST", body: { status: "approved" } })).status).toBe(200);
  });

  test("lifting a hash block needs the rank of whoever placed it", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const sha = "c".repeat(64);
    h.blossom!.blobs.set(sha, blob(sha, [newKey().pk]));
    expect((await h.asKey(h.owner, `/media/${sha}?block=true`, { method: "DELETE" })).status).toBe(200);
    expect((await h.asKey(mod, `/media/blocklist/${sha}`, { method: "DELETE" })).status).toBe(403);
    expect(h.blossom!.blocked.has(sha)).toBe(true);
    expect((await h.asKey(h.owner, `/media/blocklist/${sha}`, { method: "DELETE" })).status).toBe(200);
    // blocks with no recorded author stay liftable
    h.blossom!.blocked.set(sha, null);
    expect((await h.asKey(mod, `/media/blocklist/${sha}`, { method: "DELETE" })).status).toBe(200);
  });
});

describe("contract request types", () => {
  test("the exported request types are what the routes accept", async () => {
    const h = await createHarness();
    const cookie = await withPassword(h);
    const login: PasswordLoginRequest = { login: h.owner.pk, password: "correct horse battery" };
    expect((await h.req("/auth/password", { method: "POST", body: JSON.stringify(login), headers: { "content-type": "application/json" } })).status).toBe(200);
    const { challenge } = (await (await h.req("/auth/challenge")).json()) as { challenge: string };
    const nostr: NostrLoginRequest = {
      event: signEvent(h.owner, 27235, [["u", h.url("/auth/nostr")], ["method", "POST"], ["challenge", challenge]], "", Math.floor(h.clock.now / 1000)),
    };
    expect((await h.req("/auth/nostr", { method: "POST", body: JSON.stringify(nostr), headers: { "content-type": "application/json" } })).status).toBe(200);
    const role: RoleRequest = { role: "viewer" };
    expect((await h.withCookie(cookie, `/users/${newKey().pk}/role`, { method: "PUT", body: role })).status).toBe(200);
    const sha = "d".repeat(64);
    h.blossom!.blobs.set(sha, blob(sha, [newKey().pk]));
    const status: MediaStatusRequest = { status: "pending" };
    expect((await h.withCookie(cookie, `/media/${sha}/status`, { method: "POST", body: status })).status).toBe(200);
  });
});

describe("admin raw media can't become script", () => {
  test("JavaScript blobs are served as text/plain; script-like destinations are refused", async () => {
    const h = await createHarness();
    const js = "e".repeat(64);
    const png = "f".repeat(64);
    h.blossom!.blobs.set(js, { ...blob(js, [newKey().pk]), type: "text/javascript" });
    h.blossom!.blobs.set(png, blob(png, [newKey().pk]));
    const res = await h.asKey(h.owner, `/media/${js}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    for (const type of ["application/javascript", "application/x-ecmascript", "text/jscript", "TEXT/JavaScript; charset=utf-8"]) {
      h.blossom!.blobs.get(js)!.type = type;
      expect((await h.asKey(h.owner, `/media/${js}/raw`)).headers.get("content-type")).toBe("text/plain; charset=utf-8");
    }
    for (const dest of ["script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet", "xslt"]) {
      const r = await h.asKey(h.owner, `/media/${png}/raw`, { headers: { "sec-fetch-dest": dest } });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe("forbidden_destination");
    }
    const img = await h.asKey(h.owner, `/media/${png}/raw`, { headers: { "sec-fetch-dest": "image" } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
  });
});
