/** Users and roles: list/search/filter/sort reflect real ws activity; moderation actions; RBAC with real keys. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { nip19, type Event } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient } from "../harness/client";
import { api, signEvent, user, waitUntil } from "./admin-helpers";

let relay: Relay;
const clients: RelayClient[] = [];
beforeAll(async () => {
  relay = await startRelay();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
afterAll(() => relay?.stop());

const owner = () => relay.owner.sk;
async function client() {
  const c = await RelayClient.connect(relay.ws);
  clients.push(c);
  return c;
}
async function publish(sk: Uint8Array, t: { kind: number; content?: string; tags?: string[][] }): Promise<Event> {
  const c = await client();
  const ev = signEvent(sk, t);
  const r = await c.publish(ev);
  expect(r.ok).toBe(true);
  return ev;
}
async function stored(id: string) {
  const c = await client();
  return (await c.query(`s${Math.random()}`, [{ ids: [id] }])).events.length > 0;
}
const tag = () => `t${Math.floor(Math.random() * 1e9)}`;
async function makeRole(role: string) {
  const u = user();
  const r = await api(relay.http, owner(), "PUT", `/users/${u.pubkey}/role`, { role });
  expect(r.status).toBe(200);
  expect(r.body.role).toBe(role);
  return u;
}

describe("listing reflects activity", () => {
  test("users appear after publishing; eventCount sort, tag filter and pagination", async () => {
    const t = tag();
    const users = [user(), user(), user()];
    for (const [i, u] of users.entries()) for (let n = 0; n <= i * 2; n++) await publish(u.sk, { kind: 1, content: `n${n}` });
    const bulk = await api(relay.http, owner(), "POST", "/users/bulk", { pubkeys: users.map((u) => u.pubkey), action: "add-tag", tag: t });
    expect(bulk.body).toEqual({ ok: 3, failed: [] });
    const list = await waitUntil(async () => {
      const r = await api(relay.http, owner(), "GET", `/users?tag=${t}&sort=eventCount`);
      // activity is buffered (~2 s flush): wait until the stored counts drive the order
      return r.body.total === 3 && r.body.items.map((u: any) => u.eventCount).join() === "5,3,1" ? r : undefined;
    });
    expect(list.body.items.map((u: any) => u.pubkey)).toEqual([users[2].pubkey, users[1].pubkey, users[0].pubkey]);
    expect(list.body.items.map((u: any) => u.eventCount)).toEqual([5, 3, 1]);
    expect(list.body.items[0].firstSeenAt).toBeGreaterThan(0);
    const p1 = await api(relay.http, owner(), "GET", `/users?tag=${t}&sort=eventCount&limit=2&offset=0`);
    const p2 = await api(relay.http, owner(), "GET", `/users?tag=${t}&sort=eventCount&limit=2&offset=2`);
    expect(p1.body.items.length).toBe(2);
    expect(p2.body.items.map((u: any) => u.pubkey)).toEqual([users[0].pubkey]);
    expect(p2.body.total).toBe(3);
    // removing the tag drops them from the filter
    await api(relay.http, owner(), "POST", "/users/bulk", { pubkeys: [users[0].pubkey], action: "remove-tag", tag: t });
    expect((await api(relay.http, owner(), "GET", `/users?tag=${t}`)).body.total).toBe(2);
  });

  // SqlUserStore.list orders by the stored event_count, then overlays buffered touch() counts onto the page
  test("sort=eventCount orders by buffered activity too (regression)", async () => {
    const t = tag();
    const users = [user(), user(), user()];
    await api(relay.http, owner(), "POST", "/users/bulk", { pubkeys: users.map((u) => u.pubkey), action: "add-tag", tag: t });
    for (const [i, u] of users.entries()) for (let n = 0; n <= i * 2; n++) await publish(u.sk, { kind: 1, content: `m${n}` });
    const r = await api(relay.http, owner(), "GET", `/users?tag=${t}&sort=eventCount`);
    const counts = r.body.items.map((u: any) => u.eventCount);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
  });

  test("search by hex, npub and profile name; profile is attached", async () => {
    const u = user();
    const name = `zed${Math.floor(Math.random() * 1e9)}`;
    await publish(u.sk, { kind: 0, content: JSON.stringify({ name, about: "e2e" }) });
    await waitUntil(async () => (await api(relay.http, owner(), "GET", `/users?search=${u.pubkey}`)).body.total === 1);
    const byNpub = await api(relay.http, owner(), "GET", `/users?search=${nip19.npubEncode(u.pubkey)}`);
    expect(byNpub.body.items.map((x: any) => x.pubkey)).toEqual([u.pubkey]);
    const byName = await api(relay.http, owner(), "GET", `/users?search=${name}`);
    expect(byName.body.items.map((x: any) => x.pubkey)).toEqual([u.pubkey]);
    expect(byName.body.items[0].profile.name).toBe(name);
    expect((await api(relay.http, owner(), "GET", "/users?search=nobody-has-this-name-xyz")).body.total).toBe(0);
  });

  test("status / role / allowed filters", async () => {
    const banned = user();
    await api(relay.http, owner(), "POST", `/users/${banned.pubkey}/ban`, {});
    const allowed = user();
    await api(relay.http, owner(), "POST", "/users", { pubkey: allowed.pubkey, allowed: true, notes: "vip" });
    const mod = await makeRole("moderator");
    const bannedList = await api(relay.http, owner(), "GET", "/users?status=banned&limit=500");
    expect(bannedList.body.items.map((u: any) => u.pubkey)).toContain(banned.pubkey);
    expect(bannedList.body.items.every((u: any) => u.status === "banned")).toBe(true);
    const mods = await api(relay.http, owner(), "GET", "/users?role=moderator&limit=500");
    expect(mods.body.items.map((u: any) => u.pubkey)).toContain(mod.pubkey);
    const owners = await api(relay.http, owner(), "GET", "/users?role=owner");
    expect(owners.body.items.map((u: any) => u.pubkey)).toContain(relay.owner.pubkey);
    const al = await api(relay.http, owner(), "GET", "/users?allowed=true&limit=500");
    expect(al.body.items.map((u: any) => u.pubkey)).toContain(allowed.pubkey);
    const notes = await api(relay.http, owner(), "GET", "/users?search=vip");
    expect(notes.body.items.map((u: any) => u.pubkey)).toContain(allowed.pubkey);
    expect((await api(relay.http, owner(), "GET", "/users?status=weird")).status).toBe(400);
    expect((await api(relay.http, owner(), "GET", "/users?limit=9999")).status).toBe(400);
  });

  test("detail: stats from real events and reports; user events endpoint with kinds", async () => {
    const u = user();
    const reporter = user();
    const n1 = await publish(u.sk, { kind: 1, content: "a" });
    await publish(u.sk, { kind: 1, content: "b" });
    await publish(u.sk, { kind: 7, content: "+", tags: [["e", n1.id]] });
    await publish(reporter.sk, { kind: 1984, tags: [["p", u.pubkey, "spam"]] });
    const d = await api(relay.http, owner(), "GET", `/users/${nip19.npubEncode(u.pubkey)}`);
    expect(d.status).toBe(200);
    expect(d.body.pubkey).toBe(u.pubkey);
    expect(d.body.stats.eventCount).toBe(3);
    expect(d.body.stats.kinds).toEqual([{ kind: 1, count: 2 }, { kind: 7, count: 1 }]);
    expect(d.body.stats.reportsAgainst).toBe(1);
    expect((await api(relay.http, owner(), "GET", `/users/${reporter.pubkey}`)).body.stats.reportsFiled).toBe(1);
    const evs = await api(relay.http, owner(), "GET", `/users/${u.pubkey}/events?kinds=7`);
    expect(evs.body.items.map((e: any) => e.kind)).toEqual([7]);
    expect((await api(relay.http, owner(), "GET", `/users/${u.pubkey}/events?kinds=x`)).status).toBe(400);
    expect((await api(relay.http, owner(), "GET", "/users/not-a-key")).status).toBe(400);
  });
});

describe("editing and moderation", () => {
  test("PATCH validation: unknown fields, bad nip05, nip05 conflict; NIP-05 served", async () => {
    const a = user();
    const b = user();
    const name = `n${Math.floor(Math.random() * 1e9)}`;
    expect((await api(relay.http, owner(), "PATCH", `/users/${a.pubkey}`, { bogus: 1 })).status).toBe(400);
    const bad = await api(relay.http, owner(), "PATCH", `/users/${a.pubkey}`, { nip05Name: "Not Valid!" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("nip05");
    const ok = await api(relay.http, owner(), "PATCH", `/users/${a.pubkey}`, { nip05Name: name, notes: "hello", tags: ["x"] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ nip05Name: name, notes: "hello", tags: ["x"] });
    const clash = await api(relay.http, owner(), "PATCH", `/users/${b.pubkey}`, { nip05Name: name });
    expect(clash.status).toBe(409);
    const nip05 = await (await fetch(`${relay.http}/.well-known/nostr.json?name=${name}`)).json();
    expect(nip05.names[name]).toBe(a.pubkey);
    // a ban hides the NIP-05 name
    await api(relay.http, owner(), "POST", `/users/${a.pubkey}/ban`, {});
    const after = await (await fetch(`${relay.http}/.well-known/nostr.json?name=${name}`)).json();
    expect(after.names[name]).toBeUndefined();
  });

  test("ban with deleteEvents wipes events; unban lets them publish again", async () => {
    const u = user();
    const note = await publish(u.sk, { kind: 1, content: "soon gone" });
    const ban = await api(relay.http, owner(), "POST", `/users/${u.pubkey}/ban`, { reason: "spam", deleteEvents: true });
    expect(ban.status).toBe(200);
    expect(ban.body).toMatchObject({ status: "banned", banReason: "spam" });
    expect(await stored(note.id)).toBe(false);
    const c = await client();
    const r = await c.publish(signEvent(u.sk, { kind: 1, content: "x" }));
    expect(r).toEqual({ ok: false, message: "blocked: pubkey is banned (spam)" });
    const audit = await api(relay.http, owner(), "GET", `/audit?action=user.ban&target=${u.pubkey}`);
    expect(audit.body.items[0].details).toMatchObject({ reason: "spam", deleteEvents: true, deletedEvents: 1 });
    const unban = await api(relay.http, owner(), "POST", `/users/${u.pubkey}/unban`);
    expect(unban.body.status).toBe("active");
    expect((await (await client()).publish(signEvent(u.sk, { kind: 1, content: "back" }))).ok).toBe(true);
  });

  test("mute shadows: OK true but nothing stored; unmute restores", async () => {
    const u = user();
    await api(relay.http, owner(), "POST", `/users/${u.pubkey}/mute`);
    const c = await client();
    const ev = signEvent(u.sk, { kind: 1, content: "muted words" });
    expect((await c.publish(ev)).ok).toBe(true);
    expect(await stored(ev.id)).toBe(false);
    expect((await api(relay.http, owner(), "POST", `/users/${u.pubkey}/unmute`)).body.status).toBe("active");
    const ev2 = signEvent(u.sk, { kind: 1, content: "heard" });
    expect((await c.publish(ev2)).ok).toBe(true);
    expect(await stored(ev2.id)).toBe(true);
  });

  test("bulk ban / delete-events with per-item failures; tag required for add-tag", async () => {
    const a = user();
    const b = user();
    const na = await publish(a.sk, { kind: 1, content: "a" });
    const nb = await publish(b.sk, { kind: 1, content: "b" });
    const de = await api(relay.http, owner(), "POST", "/users/bulk", { pubkeys: [a.pubkey, b.pubkey, "garbage"], action: "delete-events" });
    expect(de.body.ok).toBe(2);
    expect(de.body.failed.map((f: any) => f.pubkey)).toEqual(["garbage"]);
    expect(await stored(na.id)).toBe(false);
    expect(await stored(nb.id)).toBe(false);
    const ban = await api(relay.http, owner(), "POST", "/users/bulk", { pubkeys: [a.pubkey, relay.owner.pubkey], action: "ban", reason: "bulk" });
    expect(ban.body.ok).toBe(1);
    expect(ban.body.failed[0].pubkey).toBe(relay.owner.pubkey);
    expect((await api(relay.http, owner(), "GET", `/users/${a.pubkey}`)).body.status).toBe("banned");
    expect((await api(relay.http, owner(), "POST", "/users/bulk", { pubkeys: [a.pubkey], action: "add-tag" })).status).toBe(400);
    expect((await api(relay.http, owner(), "POST", "/users/bulk", { pubkeys: [], action: "ban" })).status).toBe(400);
    const audit = await api(relay.http, owner(), "GET", "/audit?action=user.bulk.ban");
    expect(audit.body.items[0].details).toMatchObject({ ok: 1, count: 2, reason: "bulk" });
  });

  test("deny-list blocks publishing; DELETE user removes record and events (not a ban)", async () => {
    const u = user();
    const note = await publish(u.sk, { kind: 1, content: "mine" });
    expect((await api(relay.http, owner(), "PATCH", `/users/${u.pubkey}`, { denied: true })).body.denied).toBe(true);
    const c = await client();
    const denied = signEvent(u.sk, { kind: 1, content: "denied" });
    await c.publish(denied);
    expect(await stored(denied.id)).toBe(false);
    await api(relay.http, owner(), "PATCH", `/users/${u.pubkey}`, { denied: false });
    const del = await api(relay.http, owner(), "DELETE", `/users/${u.pubkey}`);
    expect(del.status).toBe(200);
    expect(del.body.deletedEvents).toBe(1);
    expect(await stored(note.id)).toBe(false);
    const d = await api(relay.http, owner(), "GET", `/users/${u.pubkey}`);
    expect(d.body.eventCount).toBe(0);
    expect((await (await client()).publish(signEvent(u.sk, { kind: 1, content: "again" }))).ok).toBe(true);
  });

  test("cannot moderate yourself or a configured owner", async () => {
    const self = await api(relay.http, owner(), "POST", `/users/${relay.owner.pubkey}/ban`, {});
    expect(self.status).toBe(403);
    const admin = await makeRole("admin");
    const r = await api(relay.http, admin.sk, "POST", `/users/${relay.owner.pubkey}/ban`, {});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("cannot moderate a configured owner");
  });
});

describe("roles and permissions", () => {
  test("viewer: read-only routes 200, everything else 403", async () => {
    const v = await makeRole("viewer");
    const me = await api(relay.http, v.sk, "GET", "/auth/me");
    expect(me.body.role).toBe("viewer");
    expect(me.body.permissions).toContain("users.view");
    expect(me.body.permissions).not.toContain("users.ban");
    for (const p of ["/users", "/reports", "/media", "/settings", "/groups", "/plugins", "/system"]) {
      expect([p, (await api(relay.http, v.sk, "GET", p)).status]).toEqual([p, 200]);
    }
    const target = user();
    const forbidden: [string, string, unknown?][] = [
      ["GET", "/audit"],
      ["GET", "/invites"],
      ["GET", "/ip-rules"],
      ["GET", "/connections"],
      ["GET", "/events/export"],
      ["PATCH", "/settings", { info: { name: "x" } }],
      ["POST", `/users/${target.pubkey}/ban`, {}],
      ["PATCH", `/users/${target.pubkey}`, { notes: "x" }],
      ["POST", "/events/delete", { ids: ["a".repeat(64)] }],
      ["POST", "/media/bulk", { sha256s: ["a".repeat(64)], action: "delete" }],
      ["PUT", `/users/${target.pubkey}/role`, { role: "viewer" }],
    ];
    for (const [m, p, body] of forbidden) {
      const r = await api(relay.http, v.sk, m, p, body);
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 403, "missing_permission"]);
    }
    expect((await api(relay.http, owner(), "GET", `/users/${target.pubkey}`)).body.status).toBe("active");
    // SSE with live events needs content.view, which viewers have; ?events=1 is allowed
  });

  test("moderator: can moderate users and media but not settings, roles, audit or ip rules", async () => {
    const m = await makeRole("moderator");
    const target = user();
    expect((await api(relay.http, m.sk, "POST", `/users/${target.pubkey}/ban`, { reason: "mod" })).status).toBe(200);
    expect((await api(relay.http, m.sk, "POST", `/users/${target.pubkey}/unban`)).status).toBe(200);
    expect((await api(relay.http, m.sk, "GET", "/invites")).status).toBe(200);
    for (const [method, path, body] of [
      ["PATCH", "/settings", { info: { name: "nope" } }],
      ["PUT", `/users/${target.pubkey}/role`, { role: "viewer" }],
      ["GET", "/audit"],
      ["GET", "/ip-rules"],
      ["GET", "/events/export"],
      ["DELETE", `/users/${target.pubkey}`],
      // deleteEvents is fine (content.delete) but deleteMedia needs media.moderate which moderators have; banning with both works
    ] as [string, string, unknown?][]) {
      expect([path, (await api(relay.http, m.sk, method, path, body)).status]).toEqual([path, 403]);
    }
    // ranks: a moderator can't ban another moderator or an admin
    const peer = await makeRole("moderator");
    const r = await api(relay.http, m.sk, "POST", `/users/${peer.pubkey}/ban`, {});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("cannot moderate a user with role moderator");
    // moderator can't raise their own limits
    const self = await api(relay.http, m.sk, "PATCH", `/users/${m.pubkey}`, { blossomQuota: 10 ** 12 });
    expect(self.status).toBe(403);
    // but may edit their own notes
    expect((await api(relay.http, m.sk, "PATCH", `/users/${m.pubkey}`, { notes: "me" })).status).toBe(200);
  });

  test("admin can't manage roles; owner can; removing a role revokes access", async () => {
    const a = await makeRole("admin");
    const t = user();
    expect((await api(relay.http, a.sk, "PUT", `/users/${t.pubkey}/role`, { role: "viewer" })).status).toBe(403);
    expect((await api(relay.http, a.sk, "PATCH", "/settings", { info: { contact: "admin@example" } })).status).toBe(200);
    expect((await api(relay.http, a.sk, "GET", "/audit")).status).toBe(200);
    const removed = await api(relay.http, owner(), "PUT", `/users/${a.pubkey}/role`, { role: null });
    expect(removed.status).toBe(200);
    expect(removed.body.role).toBeNull();
    const after = await api(relay.http, a.sk, "GET", "/auth/me");
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("not_admin");
    const audit = await api(relay.http, owner(), "GET", `/audit?action=user.role&target=${a.pubkey}`);
    expect(audit.body.items[0].details).toEqual({ from: "admin", to: null });
  });

  test("banned staff lose admin access", async () => {
    const m = await makeRole("moderator");
    expect((await api(relay.http, m.sk, "GET", "/users")).status).toBe(200);
    expect((await api(relay.http, owner(), "POST", `/users/${m.pubkey}/ban`, {})).status).toBe(200);
    expect((await api(relay.http, m.sk, "GET", "/users")).status).toBe(403);
  });

  test("configured owner's role is fixed; DB owner can be demoted while a config owner remains", async () => {
    const r = await api(relay.http, owner(), "PUT", `/users/${relay.owner.pubkey}/role`, { role: "admin" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("config_owner");
    const o2 = await makeRole("owner");
    expect((await api(relay.http, o2.sk, "GET", "/audit")).status).toBe(200);
    expect((await api(relay.http, o2.sk, "PUT", `/users/${o2.pubkey}/role`, { role: "viewer" })).status).toBe(200);
    expect((await api(relay.http, o2.sk, "GET", "/audit")).status).toBe(403);
    expect((await api(relay.http, owner(), "PUT", `/users/${o2.pubkey}/role`, { role: "superuser" })).status).toBe(400);
  });

  test("GET /admins lists staff sorted by rank", async () => {
    const v = await makeRole("viewer");
    const a = await makeRole("admin");
    const r = await api(relay.http, owner(), "GET", "/admins");
    const pks = r.body.items.map((u: any) => u.pubkey);
    expect(pks[0]).toBe(relay.owner.pubkey);
    expect(pks.indexOf(a.pubkey)).toBeLessThan(pks.indexOf(v.pubkey));
    const rank: Record<string, number> = { owner: 0, admin: 1, moderator: 2, viewer: 3 };
    const ranks = r.body.items.map((u: any) => rank[u.role]);
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });

  test("non-admin keys and anonymous calls are refused", async () => {
    expect((await api(relay.http, null, "GET", "/users")).status).toBe(401);
    const s = await api(relay.http, user().sk, "GET", "/users");
    expect(s.status).toBe(403);
    expect(s.body.code).toBe("not_admin");
  });
});
