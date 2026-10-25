import { describe, expect, test } from "bun:test";
import type { BulkResult } from "@beamhop/sdk";
import { createHarness, newKey, nip98Header, PUBLIC_URL, signEvent, type Key } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const rpc = (h: Harness, k: Key, body: unknown) => {
  const text = JSON.stringify(body);
  return h.api.nip86(
    new Request(`${PUBLIC_URL}/`, {
      method: "POST",
      body: text,
      headers: { "content-type": "application/nostr+json+rpc", authorization: nip98Header(k, PUBLIC_URL, "POST", text) },
    }),
  );
};

describe("bans clear the allow list on every path", () => {
  test("REST ban", async () => {
    const h = await createHarness();
    const u = newKey();
    await h.stores.users.upsert(u.pk, { allowed: true });
    const res = await h.asKey(h.owner, `/users/${u.pk}/ban`, { method: "POST", body: { reason: "spam" } });
    expect(res.status).toBe(200);
    expect(await h.stores.users.get(u.pk)).toMatchObject({ status: "banned", allowed: false, banReason: "spam" });
    expect(h.audit.entries.find((e) => e.action === "user.ban")?.details).toMatchObject({ unallowed: true });
  });

  test("bulk ban", async () => {
    const h = await createHarness();
    const [a, b] = [newKey(), newKey()];
    await h.stores.users.upsert(a.pk, { allowed: true });
    const res = await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: [a.pk, b.pk], action: "ban" } });
    expect(((await res.json()) as BulkResult).ok).toBe(2);
    expect(await h.stores.users.get(a.pk)).toMatchObject({ status: "banned", allowed: false });
    expect(await h.stores.users.get(b.pk)).toMatchObject({ status: "banned", allowed: false });
  });

  test("report ban-user and delete-and-ban", async () => {
    const h = await createHarness();
    for (const action of ["ban-user", "delete-and-ban"] as const) {
      const bad = newKey();
      await h.stores.users.upsert(bad.pk, { allowed: true });
      const note = signEvent(bad, 1, [], "spam");
      await h.events.save(note);
      const report = signEvent(newKey(), 1984, [["e", note.id, "spam"], ["p", bad.pk]]);
      await h.relay.publish(report, "api");
      const res = await h.asKey(h.owner, `/reports/${report.id}/resolve`, { method: "POST", body: { action } });
      expect(res.status).toBe(200);
      expect(await h.stores.users.get(bad.pk)).toMatchObject({ status: "banned", allowed: false });
      const entry = h.audit.entries.findLast((e) => e.action === "report.resolve");
      expect(entry?.details).toMatchObject({ banned: bad.pk, unallowed: true });
    }
  });

  test("NIP-86 banpubkey still does", async () => {
    const h = await createHarness();
    const u = newKey();
    await h.stores.users.upsert(u.pk, { allowed: true });
    expect(await (await rpc(h, h.owner, { method: "banpubkey", params: [u.pk] })).json()).toEqual({ result: true });
    expect(await h.stores.users.get(u.pk)).toMatchObject({ status: "banned", allowed: false });
    expect(h.audit.entries.find((e) => e.action === "user.ban")?.details).toMatchObject({ unallowed: true });
  });
});

describe("IP rule changes", () => {
  test("ip.rules.changed names the caller on REST and NIP-86", async () => {
    const h = await createHarness();
    const actors: string[] = [];
    h.bus.on("ip.rules.changed", (e) => actors.push(e.actor));
    await h.asKey(h.owner, "/ip-rules", { method: "POST", body: { cidr: "9.9.9.9", action: "block" } });
    await h.asKey(h.owner, `/ip-rules/${encodeURIComponent("9.9.9.9")}`, { method: "DELETE" });
    await rpc(h, h.owner, { method: "blockip", params: ["8.8.8.8", "x"] });
    await rpc(h, h.owner, { method: "unblockip", params: ["8.8.8.8"] });
    expect(actors).toEqual([h.owner.pk, h.owner.pk, h.owner.pk, h.owner.pk]);
  });

  test("NIP-86 unblockip of a rule that doesn't exist changes, emits and audits nothing", async () => {
    const h = await createHarness();
    let emitted = 0;
    h.bus.on("ip.rules.changed", () => emitted++);
    expect(await (await rpc(h, h.owner, { method: "unblockip", params: ["7.7.7.7"] })).json()).toEqual({ result: true });
    expect(emitted).toBe(0);
    expect(h.audit.entries.filter((e) => e.action === "ip.remove")).toHaveLength(0);
  });
});

describe("users bulk", () => {
  test("delete-events emits event.deleted and follows the event-delete ranks", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const user = newKey();
    await h.events.save(signEvent(user, 1, [], "a"));
    await h.events.save(signEvent(mod, 1, [], "mine"));
    await h.events.save(signEvent(admin, 1, [], "theirs"));
    const deleted: { ids: string[]; actor: string; reason?: string }[] = [];
    h.bus.on("event.deleted", (e) => deleted.push(e));
    const res = await h.asKey(mod, "/users/bulk", { method: "POST", body: { pubkeys: [user.pk, mod.pk, admin.pk], action: "delete-events" } });
    const r = (await res.json()) as BulkResult;
    // your own events may go (as with any event delete); a superior's may not
    expect(r.ok).toBe(2);
    expect(r.failed.map((f) => f.pubkey)).toEqual([admin.pk]);
    expect(h.events.events.size).toBe(1);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].actor).toBe(mod.pk);
    expect(h.audit.entries.find((e) => e.action === "user.bulk.delete-events")?.details).toMatchObject({ deletedEvents: 2 });
  });

  test("checks ranks without a lookup per target", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const targets = Array.from({ length: 50 }, () => newKey().pk);
    let gets = 0;
    const get = h.stores.users.get.bind(h.stores.users);
    h.stores.users.get = (pk: string) => (gets++, get(pk));
    const res = await h.asKey(mod, "/users/bulk", { method: "POST", body: { pubkeys: [...targets, admin.pk, mod.pk, h.owner.pk], action: "mute" } });
    const r = (await res.json()) as BulkResult;
    expect(r.ok).toBe(50);
    expect(r.failed.map((f) => f.error)).toEqual(["cannot moderate a user with role admin", "cannot moderate yourself", "cannot moderate a configured owner"]);
    // the auth middleware resolves the caller; the rank checks themselves read nothing per target
    expect(gets).toBeLessThan(5);
  });

  test("a spent time budget returns the targets not reached as remaining", async () => {
    const h = await createHarness({ apiOptions: { bulkBudgetMs: -1 } });
    const targets = [newKey().pk, newKey().pk];
    const r = (await (await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: targets, action: "mute" } })).json()) as BulkResult;
    expect(r).toEqual({ ok: 0, failed: [], remaining: targets });
    expect(h.audit.entries.find((e) => e.action === "user.bulk.mute")?.details).toMatchObject({ remaining: targets, remainingCount: 2, ok: 0 });
  });

  test("a finished bulk action has no remaining list", async () => {
    const h = await createHarness();
    const r = (await (await h.asKey(h.owner, "/users/bulk", { method: "POST", body: { pubkeys: [newKey().pk], action: "mute" } })).json()) as BulkResult;
    expect(r).toEqual({ ok: 1, failed: [] });
  });
});

describe("destructive actions are audited however they end", () => {
  test("a ban whose event delete fails is audited with the error", async () => {
    const h = await createHarness();
    const u = newKey();
    h.events.deleteByPubkey = async () => {
      throw new Error("disk full");
    };
    const res = await h.asKey(h.owner, `/users/${u.pk}/ban`, { method: "POST", body: { deleteEvents: true } });
    expect(res.status).toBe(500);
    // the ban itself (and the disconnect) happened before the delete failed
    expect((await h.stores.users.get(u.pk))?.status).toBe("banned");
    expect(h.audit.entries.find((e) => e.action === "user.ban")?.details).toMatchObject({ deleteEvents: true, deletedEvents: 0, disconnected: 1, error: "disk full" });
  });

  test("deleting a staff member removes their role and access before the slow deletes", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const cookie = await h.login(mod);
    let sessionDuringDelete: number | undefined;
    let roleDuringDelete: unknown = "unset";
    h.events.deleteByPubkey = async () => {
      sessionDuringDelete = (await h.withCookie(cookie, "/auth/me")).status;
      roleDuringDelete = (await h.stores.users.get(mod.pk))?.role;
      throw new Error("boom");
    };
    const res = await h.asKey(h.owner, `/users/${mod.pk}`, { method: "DELETE" });
    expect(res.status).toBe(500);
    expect(sessionDuringDelete).toBe(401);
    expect(roleDuringDelete).toBeNull();
    expect(h.audit.entries.find((e) => e.action === "user.delete")?.details).toMatchObject({ role: "moderator", deletedEvents: 0, error: "boom" });
  });
});

describe("roles", () => {
  test("two owners demoting each other at once leave one owner", async () => {
    // no configured owner (it would always remain): both owners hold the role through their users row
    const h = await createHarness({ storedOwner: true });
    const a = h.owner;
    const b = await h.addAdmin("owner");
    const [r1, r2] = await Promise.all([
      h.asKey(a, `/users/${b.pk}/role`, { method: "PUT", body: { role: "admin" } }),
      h.asKey(b, `/users/${a.pk}/role`, { method: "PUT", body: { role: "admin" } }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await h.stores.users.list({ role: "owner" })).total).toBe(1);
  });
});
