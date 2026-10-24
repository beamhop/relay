import { describe, expect, test } from "bun:test";
import { nip19 } from "nostr-tools";
import type { ReportView } from "@beamhop/sdk";
import { createHarness, newKey, signEvent } from "./fakes";

describe("RBAC", () => {
  test("viewer can read users but cannot ban", async () => {
    const h = await createHarness();
    const viewer = await h.addAdmin("viewer");
    const target = newKey();
    expect((await h.asKey(viewer, "/users")).status).toBe(200);
    const res = await h.asKey(viewer, `/users/${target.pk}/ban`, { method: "POST", body: {} });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("users.ban");
  });

  test("moderator cannot change settings or roles; admin cannot manage admins", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    expect((await h.asKey(mod, "/settings")).status).toBe(200);
    expect((await h.asKey(mod, "/settings", { method: "PATCH", body: { info: { name: "x" } } })).status).toBe(403);
    expect((await h.asKey(admin, `/users/${mod.pk}/role`, { method: "PUT", body: { role: "admin" } })).status).toBe(403);
  });

  test("moderator cannot ban an admin; nobody can ban a config owner", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    expect((await h.asKey(mod, `/users/${admin.pk}/ban`, { method: "POST", body: {} })).status).toBe(403);
    expect((await h.asKey(admin, `/users/${h.owner.pk}/ban`, { method: "POST", body: {} })).status).toBe(403);
    expect((await h.asKey(h.owner, `/users/${h.owner.pk}/ban`, { method: "POST", body: {} })).status).toBe(403);
  });

  test("owner protections on roles", async () => {
    const h = await createHarness();
    // config owner cannot be demoted
    expect((await h.asKey(h.owner, `/users/${h.owner.pk}/role`, { method: "PUT", body: { role: "admin" } })).status).toBe(403);
    // promote another owner, demote works while config owner remains
    const second = newKey();
    expect((await h.asKey(h.owner, `/users/${nip19.npubEncode(second.pk)}/role`, { method: "PUT", body: { role: "owner" } })).status).toBe(200);
    expect((await h.asKey(second, `/users/${second.pk}/role`, { method: "PUT", body: { role: null } })).status).toBe(200);
    expect(h.audit.entries.filter((e) => e.action === "user.role").length).toBe(2);
  });

  test("cannot remove the last owner (no config owners)", async () => {
    const h = await createHarness();
    (h.deps.config.admin as { owners: string[] }).owners = [];
    // re-create api without config owners
    const { createAdminApi } = await import("../src/index");
    const only = newKey();
    await h.stores.users.upsert(only.pk, { role: "owner" });
    const api = await createAdminApi(h.deps);
    const { nip98Header } = await import("./fakes");
    const path = `/users/${only.pk}/role`;
    const body = JSON.stringify({ role: "admin" });
    const res = await api.app.request(path, { method: "PUT", body, headers: { authorization: nip98Header(only, h.url(path), "PUT", body) } });
    expect(res.status).toBe(409);
  });
});

describe("users", () => {
  test("ban with deleteEvents/deleteMedia/disconnect, unban, audit", async () => {
    const h = await createHarness();
    const target = newKey();
    await h.events.save(signEvent(target, 1, [], "hello"));
    h.blossom!.blobs.set("a".repeat(64), { sha256: "a".repeat(64), size: 10, type: "image/png", owners: [target.pk], createdAt: 1, status: "approved", hasThumbnail: false, url: "" });
    const res = await h.asKey(h.owner, `/users/${nip19.npubEncode(target.pk)}/ban`, {
      method: "POST",
      body: { reason: "spam", deleteEvents: true, deleteMedia: true, disconnect: true },
    });
    expect(res.status).toBe(200);
    const user = (await res.json()) as { status: string; banReason: string };
    expect(user.status).toBe("banned");
    expect(user.banReason).toBe("spam");
    expect(h.events.events.size).toBe(0);
    expect(h.blossom!.blobs.size).toBe(0);
    expect(h.relay.disconnects).toContainEqual({ pubkey: target.pk });
    const entry = h.audit.entries.find((e) => e.action === "user.ban")!;
    expect(entry.actor).toBe(h.owner.pk);
    expect(entry.target).toBe(target.pk);
    expect(entry.details.deletedEvents).toBe(1);

    const un = await h.asKey(h.owner, `/users/${target.pk}/unban`, { method: "POST" });
    expect(((await un.json()) as { status: string }).status).toBe("active");
  });

  test("bulk actions with permission per action", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const a = newKey();
    const b = newKey();
    const res = await h.asKey(mod, "/users/bulk", { method: "POST", body: { pubkeys: [a.pk, nip19.npubEncode(b.pk), "garbage"], action: "ban", reason: "x" } });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { ok: number; failed: { pubkey: string }[] };
    expect(r.ok).toBe(2);
    expect(r.failed).toHaveLength(1);
    expect((await h.stores.users.get(b.pk))!.status).toBe("banned");
    // moderator lacks content.delete? (moderators have it) – viewer lacks users.edit
    const viewer = await h.addAdmin("viewer");
    expect((await h.asKey(viewer, "/users/bulk", { method: "POST", body: { pubkeys: [a.pk], action: "add-tag", tag: "x" } })).status).toBe(403);
    const tag = await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: [a.pk], action: "add-tag", tag: "vip" } });
    expect(((await tag.json()) as { ok: number }).ok).toBe(1);
    expect((await h.stores.users.get(a.pk))!.tags).toEqual(["vip"]);
    expect(h.audit.entries.some((e) => e.action === "user.bulk.ban")).toBe(true);
  });

  test("delete removes the user and their events without banning; respects roles", async () => {
    const h = await createHarness();
    const u = newKey();
    await h.stores.users.upsert(u.pk, { notes: "x" });
    await h.events.save(signEvent(u, 1, [], "note"));
    const mod = await h.addAdmin("moderator");
    expect((await h.asKey(mod, `/users/${u.pk}`, { method: "DELETE" })).status).toBe(403);
    const res = await h.asKey(h.owner, `/users/${nip19.npubEncode(u.pk)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deletedEvents: number }).deletedEvents).toBe(1);
    expect(await h.stores.users.get(u.pk)).toBeUndefined();
    expect(await h.events.count([{ authors: [u.pk] }])).toBe(0);
    expect(h.audit.entries.some((e) => e.action === "user.delete")).toBe(true);
    const admin = await h.addAdmin("admin");
    expect((await h.asKey(admin, `/users/${h.owner.pk}`, { method: "DELETE" })).status).toBe(403);
    expect((await h.asKey(h.owner, `/users/${h.owner.pk}`, { method: "DELETE" })).status).toBe(403);
    const b = newKey();
    await h.stores.users.upsert(b.pk, {});
    const bulk = (await (await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: [b.pk], action: "delete" } })).json()) as { ok: number };
    expect(bulk.ok).toBe(1);
    expect(await h.stores.users.get(b.pk)).toBeUndefined();
  });

  test("bulk unmute leaves banned users banned; moderators can't edit higher roles", async () => {
    const h = await createHarness();
    const a = newKey();
    await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: [a.pk], action: "ban" } });
    await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: [a.pk], action: "unmute" } });
    expect((await h.stores.users.get(a.pk))!.status).toBe("banned");
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const r = (await (await h.asKey(mod, "/users/bulk", { method: "POST", body: { pubkeys: [admin.pk], action: "add-tag", tag: "x" } })).json()) as { ok: number };
    expect(r.ok).toBe(0);
    expect((await h.asKey(mod, `/users/${admin.pk}`, { method: "PATCH", body: { notes: "x" } })).status).toBe(403);
    expect((await h.asKey(mod, `/users/${mod.pk}`, { method: "PATCH", body: { notes: "me" } })).status).toBe(200);
  });

  test("list enriched with profiles; detail stats; patch validation", async () => {
    const h = await createHarness();
    const u = newKey();
    await h.stores.users.upsert(u.pk, {});
    await h.events.save(signEvent(u, 0, [], JSON.stringify({ name: "alice", picture: "https://x/y.png" })));
    await h.events.save(signEvent(u, 1, [], "note"));
    const reporter = newKey();
    await h.events.save(signEvent(reporter, 1984, [["p", u.pk, "spam"]]));
    const list = (await (await h.asKey(h.owner, "/users?limit=10")).json()) as { items: { pubkey: string; profile?: { name: string } }[]; total: number };
    expect(list.items.find((x) => x.pubkey === u.pk)?.profile?.name).toBe("alice");
    const detail = (await (await h.asKey(h.owner, `/users/${u.pk}`)).json()) as { stats: { eventCount: number; kinds: { kind: number }[]; reportsAgainst: number } };
    expect(detail.stats.eventCount).toBe(2);
    expect(detail.stats.kinds.map((k) => k.kind).sort()).toEqual([0, 1]);
    expect(detail.stats.reportsAgainst).toBe(1);
    expect((await h.asKey(h.owner, `/users/${u.pk}`, { method: "PATCH", body: { tags: "nope" } })).status).toBe(400);
    expect((await h.asKey(h.owner, `/users/${u.pk}`, { method: "PATCH", body: { unknown: 1 } })).status).toBe(400);
    const ok = await h.asKey(h.owner, `/users/${u.pk}`, { method: "PATCH", body: { notes: "hi", nip05Name: "Alice" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { nip05Name: string }).nip05Name).toBe("alice");
    expect((await h.asKey(h.owner, "/users/not-a-pubkey")).status).toBe(400);
  });

  test("search by npub and profile name; role=owner includes config owners", async () => {
    const h = await createHarness();
    const u = newKey();
    const other = newKey();
    await h.stores.users.upsert(u.pk, {});
    await h.stores.users.upsert(other.pk, {});
    await h.events.save(signEvent(u, 0, [], JSON.stringify({ name: "zebracorn" })));
    const pks = async (q: string) =>
      ((await (await h.asKey(h.owner, `/users?${q}`)).json()) as { items: { pubkey: string }[] }).items.map((x) => x.pubkey);
    expect(await pks(`search=${nip19.npubEncode(u.pk)}`)).toEqual([u.pk]);
    expect(await pks("search=zebracorn")).toEqual([u.pk]);
    expect(await pks("role=owner")).toContain(h.owner.pk);
  });

  test("admins list includes config owners", async () => {
    const h = await createHarness();
    await h.addAdmin("moderator");
    const res = (await (await h.asKey(h.owner, "/admins")).json()) as { items: { pubkey: string; role: string }[] };
    expect(res.items[0]).toMatchObject({ pubkey: h.owner.pk, role: "owner" });
    expect(res.items).toHaveLength(2);
  });
});

describe("settings", () => {
  test("GET returns settings + JSON schema; PATCH validates", async () => {
    const h = await createHarness();
    const get = (await (await h.asKey(h.owner, "/settings")).json()) as { settings: { info: { name: string } }; schema: { type?: string } };
    expect(get.settings.info.name).toBeString();
    expect(get.schema.type).toBe("object");
    const bad = await h.asKey(h.owner, "/settings", { method: "PATCH", body: { limits: { maxLimit: "lots" } } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("maxLimit");
    const ok = await h.asKey(h.owner, "/settings", { method: "PATCH", body: { info: { name: "My relay" } } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { settings: { info: { name: string } } }).settings.info.name).toBe("My relay");
    expect(h.audit.entries.some((e) => e.action === "settings.update")).toBe(true);
    expect((await h.asKey(h.owner, "/settings", { method: "PATCH", body: "[1,2" })).status).toBe(400);
    expect((await h.asKey(h.owner, "/settings", { method: "PATCH", body: { bogus: {} } })).status).toBe(400);
    for (const limits of [{ maxSubscriptions: -5 }, { maxLimit: 1.5 }, { eventsPerMinute: -1 }, { maxFilters: 0 }])
      expect((await h.asKey(h.owner, "/settings", { method: "PATCH", body: { limits } })).status).toBe(400);
    expect((await h.asKey(h.owner, "/settings", { method: "PATCH", body: { limits: { connectionsPerIp: 0 } } })).status).toBe(200);
    const regex = await h.asKey(h.owner, "/settings", {
      method: "PATCH",
      body: { moderation: { wordFilters: [{ id: "r", pattern: "(", isRegex: true }] } },
    });
    expect(regex.status).toBe(400);
    // catastrophic-backtracking patterns are refused at save time (they run on every event)
    const redos = await h.asKey(h.owner, "/settings", {
      method: "PATCH",
      body: { moderation: { wordFilters: [{ id: "r", pattern: "^(\\w+\\s?)+$", isRegex: true }] } },
    });
    expect(redos.status).toBe(400);
    expect(((await redos.json()) as { error: string }).error).toContain("nested quantifiers");
  });
});

describe("events", () => {
  test("import JSONL then export NDJSON round trip", async () => {
    const h = await createHarness();
    const a = newKey();
    const evs = Array.from({ length: 25 }, (_, i) => signEvent(a, 1, [], `note ${i}`, 1_700_000_000 + Math.floor(i / 3)));
    const body = [...evs.map((e) => JSON.stringify(e)), JSON.stringify(evs[0]), "not json", JSON.stringify({ ...evs[1], sig: "0".repeat(128), id: "1".repeat(64) }), ""].join("\n");
    const res = await h.asKey(h.owner, "/events/import", { method: "POST", body, headers: { "content-type": "application/x-ndjson" } });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { imported: number; duplicates: number; rejected: number; errors: string[] };
    expect(r).toMatchObject({ imported: 25, duplicates: 1, rejected: 2 });
    expect(r.errors[0]).toContain("line 27");

    const exp = await h.asKey(h.owner, `/events/export?filters=${encodeURIComponent(JSON.stringify([{ kinds: [1] }]))}`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-type")).toContain("application/x-ndjson");
    expect(exp.headers.get("content-disposition")).toContain("attachment");
    const lines = (await exp.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(25);
    expect(new Set(lines.map((e: { id: string }) => e.id))).toEqual(new Set(evs.map((e) => e.id)));
  });

  test("import with bypassPolicies saves directly and still verifies signatures", async () => {
    const h = await createHarness();
    const a = newKey();
    await h.stores.users.upsert(a.pk, { status: "banned" });
    const ev = signEvent(a, 1, [], "x");
    const viaRelay = await h.asKey(h.owner, "/events/import", { method: "POST", body: JSON.stringify(ev) });
    expect(((await viaRelay.json()) as { rejected: number }).rejected).toBe(1);
    const bypass = await h.asKey(h.owner, "/events/import?bypassPolicies=true", { method: "POST", body: JSON.stringify(ev) });
    expect(((await bypass.json()) as { imported: number }).imported).toBe(1);
  });

  test("moderator cannot import", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    expect((await h.asKey(mod, "/events/import", { method: "POST", body: "" })).status).toBe(403);
  });

  test("query caps limit, get/delete emit bus + audit", async () => {
    const h = await createHarness();
    const a = newKey();
    const ev = signEvent(a, 1, [], "bad");
    await h.events.save(ev);
    await h.events.save(signEvent(newKey(), 1984, [["e", ev.id, "spam"], ["p", a.pk]]));
    const q = (await (await h.asKey(h.owner, "/events/query", { method: "POST", body: { filters: [{ kinds: [1] }], limit: 99999 } })).json()) as { items: { event: { id: string }; reports: number }[] };
    expect(q.items).toHaveLength(1);
    expect(q.items[0].reports).toBe(1);
    expect((await h.asKey(h.owner, "/events/query", { method: "POST", body: { filters: [{ bogus: 1 }] } })).status).toBe(400);
    const deleted: string[][] = [];
    h.bus.on("event.deleted", (e) => void deleted.push(e.ids));
    expect((await h.asKey(h.owner, `/events/${ev.id}`, { method: "DELETE", body: { reason: "spam" } })).status).toBe(200);
    expect(deleted).toEqual([[ev.id]]);
    expect((await h.asKey(h.owner, `/events/${ev.id}`)).status).toBe(404);
    expect(h.audit.entries.find((e) => e.action === "event.delete")?.target).toBe(ev.id);
    expect((await h.asKey(h.owner, "/events/delete", { method: "POST", body: { filters: [{}] } })).status).toBe(400);
  });
});

describe("reports", () => {
  test("list with status filter, resolve delete-and-ban, bulk dismiss", async () => {
    const h = await createHarness();
    const bad = newKey();
    const reporter = newKey();
    const note = signEvent(bad, 1, [], "illegal stuff");
    await h.events.save(note);
    const r1 = signEvent(reporter, 1984, [["e", note.id, "illegal"], ["p", bad.pk]], "please remove");
    const r2 = signEvent(newKey(), 1984, [["e", note.id, "illegal"], ["p", bad.pk]]);
    const r3 = signEvent(newKey(), 1984, [["p", newKey().pk, "spam"]]);
    for (const r of [r1, r2, r3]) await h.events.save(r);

    const list = (await (await h.asKey(h.owner, "/reports?status=open")).json()) as { items: ReportView[]; total: number };
    expect(list.total).toBe(3);
    const v1 = list.items.find((i) => i.id === r1.id)!;
    expect(v1.type).toBe("illegal");
    expect(v1.targetEventId).toBe(note.id);
    expect(v1.targetEvent?.id).toBe(note.id);
    expect(v1.relatedCount).toBe(2);
    expect((await (await h.asKey(h.owner, "/reports?type=spam")).json() as { total: number }).total).toBe(1);

    const res = await h.asKey(h.owner, `/reports/${r1.id}/resolve`, { method: "POST", body: { action: "delete-and-ban", note: "gone" } });
    expect(res.status).toBe(200);
    const view = (await res.json()) as ReportView;
    expect(view.status).toBe("resolved");
    expect(view.resolution).toMatchObject({ action: "delete-and-ban", by: h.owner.pk, note: "gone" });
    expect(await h.events.getById(note.id)).toBeUndefined();
    expect((await h.stores.users.get(bad.pk))!.status).toBe("banned");
    expect(h.audit.entries.some((e) => e.action === "report.resolve" && e.target === r1.id)).toBe(true);

    const bulk = await h.asKey(h.owner, "/reports/bulk-resolve", { method: "POST", body: { ids: [r2.id, r3.id], action: "dismiss" } });
    expect(((await bulk.json()) as { ok: number }).ok).toBe(2);
    expect(((await (await h.asKey(h.owner, "/reports?status=open")).json()) as { total: number }).total).toBe(0);
    expect(((await (await h.asKey(h.owner, "/reports?status=dismissed")).json()) as { total: number }).total).toBe(2);
  });

  test("delete-media blocks the blob; viewer cannot resolve", async () => {
    const h = await createHarness();
    const sha = "b".repeat(64);
    h.blossom!.blobs.set(sha, { sha256: sha, size: 1, type: "image/png", owners: [], createdAt: 1, status: "approved", hasThumbnail: false, url: "" });
    const r = signEvent(newKey(), 1984, [["x", sha, "malware"], ["p", newKey().pk]]);
    await h.events.save(r);
    const viewer = await h.addAdmin("viewer");
    expect((await h.asKey(viewer, `/reports/${r.id}/resolve`, { method: "POST", body: { action: "dismiss" } })).status).toBe(403);
    expect((await h.asKey(h.owner, `/reports/${r.id}/resolve`, { method: "POST", body: { action: "delete-media" } })).status).toBe(200);
    expect(h.blossom!.blocked.has(sha)).toBe(true);
  });
});

describe("media / misc", () => {
  test("media 404 when blossom disabled", async () => {
    const h = await createHarness({ blossom: false });
    const res = await h.asKey(h.owner, "/media");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("blossom disabled");
  });

  test("media stats include pending", async () => {
    const h = await createHarness();
    h.blossom!.blobs.set("c".repeat(64), { sha256: "c".repeat(64), size: 5, type: "image/png", owners: [], createdAt: 1, status: "pending", hasThumbnail: false, url: "" });
    const s = (await (await h.asKey(h.owner, "/media/stats")).json()) as { count: number; pending: number };
    expect(s).toMatchObject({ count: 1, pending: 1 });
  });

  test("raw preview serves pending blobs to admins only", async () => {
    const h = await createHarness();
    const sha = "d".repeat(64);
    h.blossom!.blobs.set(sha, { sha256: sha, size: 5, type: "image/png", owners: [], createdAt: 1, status: "pending", hasThumbnail: false, url: "" });
    const res = await h.asKey(h.owner, `/media/${sha}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("blob:" + sha);
    expect((await h.asKey(h.owner, `/media/${"e".repeat(64)}/raw`)).status).toBe(404);
    expect((await h.api.app.request(`/media/${sha}/raw`)).status).toBe(401);
  });

  test("system, metrics, connections, invites, ip-rules, groups, plugins", async () => {
    const h = await createHarness();
    const sys = (await (await h.asKey(h.owner, "/system")).json()) as { version: string; nips: number[]; runtime: string; dbDialect: string; pushEnabled: boolean };
    expect(sys).toMatchObject({ version: "0.1.0-test", nips: [1, 11, 86], runtime: "bun", dbDialect: "sqlite", pushEnabled: true });
    const series = (await (await h.asKey(h.owner, "/metrics/series?name=connections&from=1000&to=4600")).json()) as { points: { v: number }[] };
    expect(series.points[0].v).toBe(60);
    expect((await h.asKey(h.owner, "/metrics/series?name=x&from=10&to=5")).status).toBe(400);
    const conns = (await (await h.asKey(h.owner, "/connections")).json()) as { items: { geo?: { country: string } }[] };
    expect(conns.items[0].geo?.country).toBe("DE");
    const inv = (await (await h.asKey(h.owner, "/invites", { method: "POST", body: { count: 2, note: "hi" } })).json()) as { items: { url: string; code: string }[] };
    expect(inv.items).toHaveLength(2);
    expect(inv.items[0].url).toBe(`https://relay.test/invite/${inv.items[0].code}`);
    expect((await h.asKey(h.owner, "/ip-rules", { method: "POST", body: { cidr: "10.0.0.0/33", action: "block" } })).status).toBe(400);
    expect((await h.asKey(h.owner, "/ip-rules", { method: "POST", body: { cidr: "10.0.0.0/8", action: "block", reason: "x" } })).status).toBe(201);
    expect((await h.asKey(h.owner, `/ip-rules/${encodeURIComponent("10.0.0.0/8")}`, { method: "DELETE" })).status).toBe(200);
    expect((await h.asKey(h.owner, "/groups")).status).toBe(200);
    expect((await h.asKey(h.owner, "/groups/g1", { method: "DELETE" })).status).toBe(200);
    const plug = await h.asKey(h.owner, "/plugins/x/demo/hello");
    expect(await plug.json()).toEqual({ hello: h.owner.pk });
    const ps = (await (await h.asKey(h.owner, "/plugins/demo/settings", { method: "PATCH", body: { values: { b: 2 } } })).json()) as { values: Record<string, number> };
    expect(ps.values).toEqual({ a: 1, b: 2 });
    const audit = (await (await h.asKey(h.owner, `/audit?actor=${nip19.npubEncode(h.owner.pk)}`)).json()) as { items: { action: string }[] };
    expect(audit.items.map((i) => i.action)).toEqual(expect.arrayContaining(["invite.create", "ip.add", "ip.remove", "group.delete", "plugin.settings"]));
  });

  test("bus admin.action emitted for mutations", async () => {
    const h = await createHarness();
    const seen: string[] = [];
    h.bus.on("admin.action", (e) => void seen.push(e.entry.action));
    await h.asKey(h.owner, `/users/${newKey().pk}/mute`, { method: "POST" });
    expect(seen).toContain("user.mute");
  });

  test("errors are JSON ApiError; body limit enforced", async () => {
    const h = await createHarness();
    const nf = await h.asKey(h.owner, "/nope");
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ error: "not found" });
    const big = await h.asKey(h.owner, "/settings", { method: "PATCH", body: JSON.stringify({ info: { name: "x".repeat(1_100_000) } }) });
    expect(big.status).toBe(413);
  });
});

describe("push", () => {
  test("subscribe, notify on report.created, drop 410 subscriptions", async () => {
    const sent: { endpoint: string; payload: string }[] = [];
    let fail = false;
    const h = await createHarness({
      pushSender: async (sub, payload) => {
        if (fail) throw Object.assign(new Error("gone"), { statusCode: 410 });
        sent.push({ endpoint: sub.endpoint, payload });
      },
    });
    const vapid = (await (await h.asKey(h.owner, "/push/vapid")).json()) as { publicKey: string };
    expect(vapid.publicKey.length).toBeGreaterThan(40);
    const sub = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc", keys: { p256dh: "k", auth: "a" } };
    expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: { subscription: sub, topics: ["reports"] } })).status).toBe(200);
    const report = signEvent(newKey(), 1984, [["p", newKey().pk, "spam"]]);
    await h.relay.publish(report, "api");
    await Bun.sleep(20);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].payload)).toMatchObject({ tag: expect.any(String), url: expect.stringContaining("/admin") });
    // alerts topic not subscribed
    h.bus.emit("alert", { level: "warn", title: "t", message: "m" } as never);
    await Bun.sleep(20);
    expect(sent).toHaveLength(1);
    fail = true;
    await h.relay.publish(signEvent(newKey(), 1984, [["p", newKey().pk, "spam"]]), "api");
    await Bun.sleep(20);
    const rows = await h.stores.db.all("SELECT endpoint FROM admin_push_subscriptions");
    expect(rows).toHaveLength(0);
  });
});
