import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { nip19 } from "nostr-tools";
import type { ReportView } from "@beamhop/sdk";
import { createMemoryDb } from "@beamhop/storage";
import { ADMIN_MIGRATIONS } from "../src/db";
import { HttpError } from "../src/errors";
import { createAdminApi } from "../src/index";
import { AUTH_REPLAY_TTL_MS } from "../src/middleware/auth";
import { SESSION_REVALIDATE_MS, SESSION_TTL_SEC } from "../src/services/sessions";
import { hashPassword, PasswordHasher, SCRYPT_DEFAULTS, verifyPassword } from "../src/util/password";
import { createHarness, newKey, nip98Header, PUBLIC_URL, signEvent, TEST_SCRYPT } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rawId = (cookie: string) => cookie.replace(/^bh_session=/, "");
const sub = (i: number | string) => ({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: { p256dh: "k", auth: "a" } } });
const pushRows = (h: Harness) =>
  h.stores.db.all<{ endpoint: string; session_id: string | null }>("SELECT endpoint, session_id FROM admin_push_subscriptions ORDER BY endpoint");

/** A second admin API instance on the same database and stores (its own memory: caches, limiters). */
async function secondInstance(h: Harness) {
  const api = await createAdminApi(h.deps, { now: () => h.clock.now, scryptParams: TEST_SCRYPT });
  const withCookie = (cookie: string, path: string, method = "GET") =>
    api.app.request(path, { method, headers: { cookie, "x-requested-with": "beamhop", "content-type": "application/json" } });
  return { api, withCookie };
}

// ------------------------------------------------------------------ 1. session ids are stored hashed

describe("session ids are stored as hashes", () => {
  test("the database holds sha256(cookie), never the cookie; push devices refer to the hash", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    const cookie = await h.login(h.owner);
    const rows = await h.stores.db.all<{ id: string }>("SELECT id FROM admin_sessions");
    expect(rows.map((r) => r.id)).toEqual([sha256(rawId(cookie))]);
    expect(JSON.stringify(await h.stores.db.all("SELECT * FROM admin_sessions"))).not.toContain(rawId(cookie));
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(200);
    // the stored hash itself is not a usable cookie
    expect((await h.withCookie(`bh_session=${rows[0].id}`, "/auth/me")).status).toBe(401);

    expect((await h.withCookie(cookie, "/push/subscribe", { method: "POST", body: sub("a") })).status).toBe(200);
    expect(await pushRows(h)).toEqual([{ endpoint: sub("a").subscription.endpoint, session_id: rows[0].id }]);
    await h.withCookie(cookie, "/auth/logout", { method: "POST" });
    expect(await pushRows(h)).toEqual([]);
  });

  test("migration 005 hashes existing sessions and push bindings in place: signed-in admins stay signed in", async () => {
    const db = await createMemoryDb();
    await db.migrate("admin", ADMIN_MIGRATIONS.filter((m) => m.id < "005"));
    const owner = newKey();
    const now = Math.floor(Date.now() / 1000);
    const [legacy, other] = ["ab".repeat(32), "cd".repeat(32)];
    for (const id of [legacy, other])
      await db.run(
        "INSERT INTO admin_sessions (id, pubkey, created_at, expires_at, ip, user_agent, last_seen_at, method) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'nostr')",
        [id, owner.pk, now, now + 3600, now],
      );
    await db.run("INSERT INTO admin_push_subscriptions (endpoint, pubkey, subscription, topics, created_at, session_id) VALUES (?, ?, ?, '[]', ?, ?)", [
      "https://fcm.googleapis.com/fcm/send/old",
      owner.pk,
      JSON.stringify(sub("old").subscription),
      now,
      legacy,
    ]);

    const h = await createHarness({ db, owner, pushSender: async () => {} });
    const ids = async () => (await h.stores.db.all<{ id: string }>("SELECT id FROM admin_sessions ORDER BY id")).map((r) => r.id);
    expect(await ids()).toEqual([sha256(legacy), sha256(other)].sort());
    expect((await pushRows(h)).map((r) => r.session_id)).toEqual([sha256(legacy)]);
    expect(((await (await h.withCookie(`bh_session=${legacy}`, "/auth/me")).json()) as { pubkey: string }).pubkey).toBe(owner.pk);
    // the push binding still follows the session: logging it out drops the device
    expect((await h.withCookie(`bh_session=${legacy}`, "/auth/logout", { method: "POST" })).status).toBe(200);
    expect(await pushRows(h)).toEqual([]);
    // another start doesn't hash the remaining session again
    await createHarness({ db, owner });
    expect(await ids()).toEqual([sha256(other)]);
    expect((await h.withCookie(`bh_session=${other}`, "/auth/me")).status).toBe(200);
  });
});

// ------------------------------------------------------------------ 2. revocation and replay protection across instances

describe("instances sharing a database", () => {
  test("a logout on one instance ends the session on another within the revalidation window", async () => {
    const h = await createHarness();
    const b = await secondInstance(h);
    const cookie = await h.login(h.owner);
    expect((await b.withCookie(cookie, "/auth/me")).status).toBe(200); // now cached on B
    expect((await h.withCookie(cookie, "/auth/logout", { method: "POST" })).status).toBe(200);
    h.clock.now += SESSION_REVALIDATE_MS;
    expect((await b.withCookie(cookie, "/auth/me")).status).toBe(401);
  });

  test("a password change on one instance ends the other sessions on another", async () => {
    const h = await createHarness();
    const b = await secondInstance(h);
    const stolen = await h.login(h.owner);
    const mine = await h.login(h.owner);
    expect((await b.withCookie(stolen, "/auth/me")).status).toBe(200);
    expect((await h.withCookie(mine, "/auth/password/set", { method: "POST", body: { password: "brand-new-password" } })).status).toBe(200);
    h.clock.now += SESSION_REVALIDATE_MS;
    expect((await b.withCookie(stolen, "/auth/me")).status).toBe(401);
    expect((await b.withCookie(mine, "/auth/me")).status).toBe(200);
  });

  test("a session slid by one instance isn't expired by another's stale copy", async () => {
    const h = await createHarness();
    const b = await secondInstance(h);
    const cookie = await h.login(h.owner);
    expect((await b.withCookie(cookie, "/auth/me")).status).toBe(200);
    // used on A every day for 8 days: A keeps sliding the expiry, B last saw the original one
    for (let d = 0; d < 8; d++) {
      h.clock.now += 86_400_000;
      expect((await h.withCookie(cookie, "/auth/me")).status).toBe(200);
    }
    expect((await b.withCookie(cookie, "/auth/me")).status).toBe(200);
  });

  test("a NIP-98 authorization can't be replayed against another instance (admin API and NIP-86)", async () => {
    const h = await createHarness();
    const b = await secondInstance(h);
    const now = Math.floor(h.clock.now / 1000);
    const authorization = nip98Header(h.owner, h.url("/auth/me"), "GET", undefined, [], now);
    expect((await h.req("/auth/me", { headers: { authorization } })).status).toBe(200);
    const replay = await b.api.app.request("/auth/me", { headers: { authorization } });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe("replayed_auth");

    const rpc = JSON.stringify({ method: "supportedmethods", params: [] });
    const rpcAuth = nip98Header(h.owner, PUBLIC_URL, "POST", rpc, [], now);
    const call = (api: typeof h.api) => api.nip86(new Request(`${PUBLIC_URL}/`, { method: "POST", body: rpc, headers: { authorization: rpcAuth } }));
    expect((await call(h.api)).status).toBe(200);
    expect((await call(b.api)).status).toBe(401);
  });

  test("used NIP-98 ids are swept once expired", async () => {
    const h = await createHarness();
    expect((await h.asKey(h.owner, "/auth/me")).status).toBe(200);
    expect(await h.stores.db.all("SELECT id FROM admin_used_auth")).toHaveLength(1);
    h.clock.now += AUTH_REPLAY_TTL_MS + 61_000;
    expect((await h.asKey(h.owner, "/auth/me")).status).toBe(200);
    expect(await h.stores.db.all("SELECT id FROM admin_used_auth")).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ 3. password hashing

describe("password hashing", () => {
  test("new hashes use scrypt N=2^17, r=8, p=1", async () => {
    expect(SCRYPT_DEFAULTS).toEqual({ N: 2 ** 17, r: 8, p: 1 });
    const hash = await hashPassword("correct horse");
    expect(hash.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
  });

  test("hashes needing absurd memory are refused, not computed", async () => {
    const hasher = new PasswordHasher({ params: TEST_SCRYPT });
    expect(await hasher.verify("x", `scrypt$${2 ** 20}$8$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64).toString("base64")}`)).toBe(false);
    expect(await hasher.verify("x", `scrypt$1000$8$1$AAAA$AAAA`)).toBe(false); // N must be a power of two
  });

  test("at most `concurrency` hashes run and `queue` wait; the rest are answered busy", async () => {
    const hasher = new PasswordHasher({ params: { N: 2 ** 14, r: 8, p: 1 }, concurrency: 1, queue: 1 });
    const results = await Promise.allSettled([hasher.hash("a"), hasher.hash("b"), hasher.hash("c")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    const err = (results[2] as PromiseRejectedResult).reason as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect([err.status, err.code]).toEqual([503, "busy"]);
    // slots are released again
    expect(await hasher.verify("a", (results[0] as PromiseFulfilledResult<string>).value)).toBe(true);
  });

  test("an N=2^14 hash still verifies and is upgraded on the next password login, without counting as a password change", async () => {
    const h = await createHarness({ scryptParams: SCRYPT_DEFAULTS });
    const legacy = await new PasswordHasher({ params: { N: 2 ** 14, r: 8, p: 1 } }).hash("legacy-password");
    await h.stores.db.run("INSERT INTO admin_credentials (pubkey, password_hash, totp_secret, updated_at, password_set_at) VALUES (?, ?, NULL, 1, 1)", [
      h.owner.pk,
      legacy,
    ]);
    const login = (password: string) =>
      h.req("/auth/password", { method: "POST", body: JSON.stringify({ login: h.owner.pk, password }), headers: { "content-type": "application/json" } });
    expect((await login("wrong-password")).status).toBe(401);
    expect((await h.stores.db.get<{ password_hash: string }>("SELECT password_hash FROM admin_credentials"))?.password_hash).toBe(legacy);
    expect((await login("legacy-password")).status).toBe(200);
    const row = await h.stores.db.get<{ password_hash: string; password_set_at: number }>("SELECT password_hash, password_set_at FROM admin_credentials");
    expect(row?.password_hash.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(Number(row?.password_set_at)).toBe(1);
    expect((await login("legacy-password")).status).toBe(200);
  });
});

// ------------------------------------------------------------------ 4. passkey login options

describe("passkey login options don't reveal admins or their credentials", () => {
  type Options = { allowCredentials?: { id: string; type: string; transports?: string[] }[] };
  const addPasskey = (h: Harness, pk: string, id: string, transports = '["internal","hybrid"]') =>
    h.stores.db.run("INSERT INTO admin_passkeys (id, pubkey, public_key, counter, transports, name, created_at) VALUES (?, ?, 'pk', 0, ?, 'key', 1)", [id, pk, transports]);
  const options = async (api: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, login: string) => {
    const res = await api.request("/auth/passkey/login/options", { method: "POST", body: JSON.stringify({ login }), headers: { "content-type": "application/json", "x-requested-with": "beamhop" } });
    expect(res.status).toBe(200);
    return ((await res.json()) as Options).allowCredentials ?? [];
  };

  test("an admin with passkeys gets theirs; anyone else gets stable decoys of the same shape", async () => {
    const h = await createHarness();
    const app = h.api.app;
    const admin = await h.addAdmin("admin");
    await addPasskey(h, admin.pk, "real-credential-1");
    await addPasskey(h, admin.pk, "real-credential-2");
    expect((await options(app, nip19.npubEncode(admin.pk))).map((c) => c.id)).toEqual(["real-credential-1", "real-credential-2"]);

    const stranger = newKey();
    const noPasskeys = await h.addAdmin("moderator");
    const demoted = await h.addAdmin("admin");
    await addPasskey(h, demoted.pk, "demoted-credential");
    await h.stores.users.upsert(demoted.pk, { role: null });
    for (const pk of [stranger.pk, noPasskeys.pk, demoted.pk]) {
      const decoys = await options(app, pk);
      expect(decoys.length).toBeGreaterThanOrEqual(1);
      expect(decoys.length).toBeLessThanOrEqual(3);
      for (const c of decoys) {
        expect(Object.keys(c).sort()).toEqual(["id", "transports", "type"]);
        expect([16, 20, 32, 64]).toContain(Buffer.from(c.id, "base64url").length);
        expect(c.id).not.toBe("demoted-credential");
      }
      // stable across requests and spellings of the same pubkey
      expect(await options(app, nip19.npubEncode(pk))).toEqual(decoys);
    }
    // different logins get different decoys
    expect((await options(app, stranger.pk))[0].id).not.toBe((await options(app, noPasskeys.pk))[0].id);
  });

  test("decoys survive restarts and match across instances (persisted key)", async () => {
    const h = await createHarness();
    const b = await secondInstance(h);
    const who = nip19.npubEncode(newKey().pk);
    expect(await options(b.api.app, who)).toEqual(await options(h.api.app, who));
    expect(await options(h.api.app, "nobody@relay.test")).toEqual(await options(b.api.app, "nobody"));
  });

  test("NIP-05 logins resolve against local users only (no network lookup)", async () => {
    const h = await createHarness();
    const alice = newKey();
    await h.stores.users.upsert(alice.pk, { nip05Name: "alice" });
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
    try {
      const byName = await options(h.api.app, "alice@attacker.example");
      expect(byName).toEqual(await options(h.api.app, alice.pk));
      await options(h.api.app, "someone@169.254.169.254");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
  });
});

// ------------------------------------------------------------------ 5. push devices of expired sessions

describe("push devices don't outlive an expired session", () => {
  test("an expired session found on lookup drops its devices; NIP-98 devices stay", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    const cookie = await h.login(h.owner);
    await h.withCookie(cookie, "/push/subscribe", { method: "POST", body: sub("session") });
    await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub("nip98") });
    h.clock.now += (SESSION_TTL_SEC + 1) * 1000;
    expect((await h.withCookie(cookie, "/auth/me")).status).toBe(401);
    expect((await pushRows(h)).map((r) => r.endpoint.split("/").pop())).toEqual(["nip98"]);
  });

  test("devices of sessions that expired unseen get no pushes and are pruned", async () => {
    const sent: string[] = [];
    const h = await createHarness({ pushSender: async (s) => void sent.push(s.endpoint.split("/").pop()!) });
    await h.withCookie(await h.login(h.owner), "/push/subscribe", { method: "POST", body: sub("expired") });
    await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub("nip98") });
    h.clock.now += (SESSION_TTL_SEC + 1) * 1000;
    await h.relay.publish(signEvent(newKey(), 1984, [["p", newKey().pk, "spam"]]), "api");
    await Bun.sleep(20);
    expect(sent).toEqual(["nip98"]);
    expect((await pushRows(h)).map((r) => r.endpoint.split("/").pop())).toEqual(["nip98"]);
  });

  test("the periodic session sweep drops the swept sessions' devices", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    await h.withCookie(await h.login(h.owner), "/push/subscribe", { method: "POST", body: sub("old") });
    h.clock.now += (SESSION_TTL_SEC + 1) * 1000;
    const fresh = await h.login(h.owner); // creating a session runs the (hourly) sweep
    expect(await pushRows(h)).toEqual([]);
    await h.withCookie(fresh, "/push/subscribe", { method: "POST", body: sub("new") });
    expect(await pushRows(h)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ 6. ?target= follows targetPubkey

describe("GET /reports?target=<pubkey> matches the report's subject", () => {
  test("author / uploader over the `p` tag, which only stands without stored content", async () => {
    const h = await createHarness();
    const [bob, alice, carol, dave, xavier] = [newKey(), newKey(), newKey(), newKey(), newKey()];
    const blob = (sha: string, owners: string[]) =>
      h.blossom!.blobs.set(sha, { sha256: sha, size: 1, type: "image/png", owners, createdAt: 1, status: "approved", hasThumbnail: false, url: "" });
    const [solo, both] = ["1", "2"].map((c) => c.repeat(64));
    blob(solo, [bob.pk]);
    blob(both, [bob.pk, alice.pk]);
    const spam = signEvent(bob, 1, [], "buy now");
    const xPost = signEvent(xavier, 1, [], "x");
    await h.events.save(spam);
    await h.events.save(xPost);
    const reports = {
      bobsSpamNamingAlice: signEvent(newKey(), 1984, [["e", spam.id, "spam"], ["p", alice.pk]]),
      pOnlyCarol: signEvent(newKey(), 1984, [["p", carol.pk, "impersonation"]]),
      goneNamingDave: signEvent(newKey(), 1984, [["e", "a".repeat(64), "spam"], ["p", dave.pk]]),
      bobsBlobNamingAlice: signEvent(newKey(), 1984, [["x", solo, "nudity"], ["p", alice.pk]]),
      sharedBlobNamingAlice: signEvent(newKey(), 1984, [["x", both, "nudity"], ["p", alice.pk]]),
      // a stored event decides even when the report also names a blob of Bob's
      xaviersPostWithBobsBlob: signEvent(newKey(), 1984, [["e", xPost.id, "spam"], ["x", solo, "nudity"], ["p", carol.pk]]),
    };
    for (const r of Object.values(reports)) await h.events.save(r);
    const list = async (target: string) => {
      const res = (await (await h.asKey(h.owner, `/reports?target=${encodeURIComponent(target)}`)).json()) as { items: ReportView[]; total: number };
      expect(res.total).toBe(res.items.length);
      for (const v of res.items) if (/^[0-9a-f]{64}$/.test(target) && v.targetPubkey) expect([v.targetPubkey, v.targetEventId, v.targetBlob]).toContain(target);
      return res.items.map((v) => v.id).sort();
    };
    const ids = (...rs: { id: string }[]) => rs.map((r) => r.id).sort();

    expect(await list(bob.pk)).toEqual(ids(reports.bobsSpamNamingAlice, reports.bobsBlobNamingAlice));
    expect(await list(nip19.npubEncode(bob.pk))).toEqual(ids(reports.bobsSpamNamingAlice, reports.bobsBlobNamingAlice));
    expect(await list(alice.pk)).toEqual(ids(reports.sharedBlobNamingAlice));
    expect(await list(carol.pk)).toEqual(ids(reports.pOnlyCarol));
    expect(await list(dave.pk)).toEqual(ids(reports.goneNamingDave));
    expect(await list(xavier.pk)).toEqual(ids(reports.xaviersPostWithBobsBlob));
    // event ids and blob hashes still select the reports about them
    expect(await list(spam.id)).toEqual(ids(reports.bobsSpamNamingAlice));
    expect(await list(solo)).toEqual(ids(reports.bobsBlobNamingAlice, reports.xaviersPostWithBobsBlob));
  });
});

// ------------------------------------------------------------------ 7. broad allow rules

describe("IP allow rules wider than an IPv4 /16 or an IPv6 /48 need confirmation", () => {
  const add = (h: Harness, body: Record<string, unknown>) => h.asKey(h.owner, "/ip-rules", { method: "POST", body });

  test("refused with broad_allow_rule unless confirmBroad; the confirmation is audited", async () => {
    const h = await createHarness();
    for (const cidr of ["0.0.0.0/0", "::/0", "10.0.0.0/15", "2001:db8::/47", "::ffff:0.0.0.0/96", "::ffff:0:0/100"]) {
      const res = await add(h, { cidr, action: "allow" });
      expect([cidr, res.status]).toEqual([cidr, 400]);
      expect(((await res.json()) as { code: string }).code).toBe("broad_allow_rule");
    }
    expect(await h.stores.ipRules.list()).toEqual([]);
    for (const cidr of ["10.0.0.0/16", "2001:db8::/48", "::ffff:10.0.0.0/112", "203.0.113.7", "2001:db8::1"]) {
      expect([cidr, (await add(h, { cidr, action: "allow" })).status]).toEqual([cidr, 201]);
    }
    // block rules of any width need no confirmation
    expect((await add(h, { cidr: "0.0.0.0/0", action: "block" })).status).toBe(201);
    expect(h.audit.entries.filter((e) => e.action === "ip.add").every((e) => !("confirmedBroad" in e.details))).toBe(true);

    const res = await add(h, { cidr: "::/0", action: "allow", reason: "really", confirmBroad: true });
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("confirmBroad");
    expect((await h.stores.ipRules.list()).find((r) => r.cidr === "::/0")).toEqual({ cidr: "::/0", action: "allow", reason: "really", createdAt: 1 });
    expect(h.audit.entries.at(-1)).toMatchObject({ action: "ip.add", target: "::/0", details: { action: "allow", confirmedBroad: true } });
  });

  test("IPv4-mapped ranges the relay can't match are invalid", async () => {
    const h = await createHarness();
    const res = await add(h, { cidr: "::ffff:0:0/80", action: "block" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation");
  });
});
