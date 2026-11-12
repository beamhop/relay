import { describe, expect, test } from "bun:test";
import type { EventView, NostrEvent, Paged, ReportBulkResult, ReportView } from "@beamhop/sdk";
import { createTestStores } from "@beamhop/storage";
import { createAdminApi } from "../src/index";
import { createHarness, newKey, nip98Header, PUBLIC_URL, signEvent, type Key } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const list = async (h: Harness, query = "") => (await (await h.asKey(h.owner, `/reports${query}`)).json()) as Paged<ReportView>;
const indexRows = async (h: Harness) => Number((await h.stores.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM admin_report_index"))!.n);

const rpc = async (h: Harness, k: Key, body: unknown) => {
  const text = JSON.stringify(body);
  const res = await h.api.nip86(
    new Request(`${PUBLIC_URL}/`, {
      method: "POST",
      body: text,
      headers: { "content-type": "application/nostr+json+rpc", authorization: nip98Header(k, PUBLIC_URL, "POST", text) },
    }),
  );
  return (await res.json()) as { result: unknown; error?: string };
};

describe("report queue", () => {
  test("an old open report stays in the queue, badge count and NIP-86 behind 5000 newer reports", async () => {
    const h = await createHarness();
    const now = Math.floor(Date.now() / 1000);
    const spam = signEvent(newKey(), 1, [], "spam");
    await h.events.save(spam);
    const real = signEvent(newKey(), 1984, [["e", spam.id, "spam"]], "real", now - 3600);
    await h.events.save(real);
    // 5000 newer reports, all already dismissed: the old 5000-report window never reached the real one
    const junkReporter = newKey();
    for (let i = 0; i < 5000; i++) {
      const junk = signEvent(junkReporter, 1984, [["p", newKey().pk, "other"]], `junk ${i}`, now - i % 60);
      await h.events.save(junk);
      await h.stores.db.run("INSERT INTO admin_report_status (report_id, status, action, by, at) VALUES (?, 'dismissed', 'dismiss', ?, 1)", [junk.id, h.owner.pk]);
    }
    // a restart over an existing database backfills the index from the stored reports
    await h.stores.kv.delete("admin", "report_index_backfilled");
    const api = await createAdminApi(h.deps, { now: () => h.clock.now });
    expect(await indexRows(h)).toBe(5001);
    const res = await api.app.request("/reports?status=open&limit=1", { headers: { authorization: nip98Header(h.owner, h.url("/reports?status=open&limit=1"), "GET") } });
    const open = (await res.json()) as Paged<ReportView>;
    expect(open.total).toBe(1);
    expect(open.items[0].id).toBe(real.id);
    expect((await list(h, "?status=dismissed&limit=1&offset=4999")).items).toHaveLength(1);

    const needing = (await rpc(h, h.owner, { method: "listeventsneedingmoderation" })).result as { id: string }[];
    expect(needing.map((n) => n.id)).toEqual([spam.id]);
    expect(await rpc(h, h.owner, { method: "allowevent", params: [spam.id] })).toEqual({ result: true });
    expect(h.audit.entries.find((e) => e.action === "event.allow")?.details).toMatchObject({ dismissedReports: 1 });
    expect((await list(h, "?status=open")).total).toBe(0);
  }, 30_000); // seeds 5000 reports: about 2 s locally, over 5 s on CI runners

  test("filters, totals and paging run over the whole queue", async () => {
    const h = await createHarness();
    const now = Math.floor(Date.now() / 1000);
    const alice = newKey();
    const note = signEvent(alice, 1, [], "x");
    await h.events.save(note);
    const reports: NostrEvent[] = [];
    for (let i = 0; i < 7; i++) {
      const r = i < 3 ? signEvent(newKey(), 1984, [["e", note.id, "spam"], ["p", alice.pk]], "", now - i) : signEvent(newKey(), 1984, [["p", newKey().pk, "nudity"]], "", now - i);
      reports.push(r);
      await h.relay.publish(r, "api");
    }
    const all = await list(h, "?limit=2&offset=2");
    expect(all.total).toBe(7);
    expect(all.items.map((v) => v.id)).toEqual([reports[2].id, reports[3].id]);
    expect((await list(h, "?type=nudity")).total).toBe(4);
    const aboutAlice = await list(h, `?target=${alice.pk}`);
    expect(aboutAlice.total).toBe(3);
    expect(aboutAlice.items.every((v) => v.relatedCount === 3)).toBe(true);
    expect((await list(h, `?target=${note.id}&type=spam`)).total).toBe(3);
  });

  test("related counts only count open reports against the same target", async () => {
    const h = await createHarness();
    const note = signEvent(newKey(), 1, [], "x");
    await h.events.save(note);
    const rs = [0, 1, 2].map(() => signEvent(newKey(), 1984, [["e", note.id, "spam"]]));
    for (const r of rs) await h.relay.publish(r, "api");
    await h.asKey(h.owner, `/reports/${rs[0].id}/resolve`, { method: "POST", body: { action: "dismiss" } });
    const open = await list(h, "?status=open");
    expect(open.items.map((v) => v.relatedCount)).toEqual([2, 2]);
  });

  test("reports deleted from the event store leave the queue", async () => {
    const h = await createHarness();
    const rs = [0, 1, 2, 3].map((i) => signEvent(newKey(), 1984, [["p", newKey().pk, "spam"]], `r${i}`));
    for (const r of rs) await h.relay.publish(r, "api");
    expect((await list(h)).total).toBe(4);
    // deleted without naming them (vanish, user deletion): reads skip and drop their rows
    await h.events.deleteByIds([rs[0].id]);
    const after = await list(h);
    expect(after.total).toBe(3);
    expect(after.items.map((v) => v.id)).not.toContain(rs[0].id);
    // a deletion naming them drops them right away
    await h.events.deleteByIds([rs[1].id]);
    h.bus.emit("event.deleted", { ids: [rs[1].id], actor: "x" });
    await Bun.sleep(10);
    expect(await indexRows(h)).toBe(2);
    // a bulk deletion (no ids) sweeps
    await h.events.deleteByIds([rs[2].id]);
    h.bus.emit("event.deleted", { ids: [], actor: "system:retention", reason: "retention" });
    await Bun.sleep(20);
    expect(await indexRows(h)).toBe(1);
  });

  test("the subject filter follows a reported event stored after its report", async () => {
    const h = await createHarness();
    const [alice, bob] = [newKey(), newKey()];
    const post = signEvent(bob, 1, [], "bob's post");
    const report = signEvent(newKey(), 1984, [["e", post.id, "spam"], ["p", alice.pk]]);
    await h.relay.publish(report, "api");
    expect((await list(h, `?target=${alice.pk}`)).total).toBe(1);
    await h.events.save(post);
    // the next read sees bob as the subject and corrects the index
    expect((await list(h)).items[0].targetPubkey).toBe(bob.pk);
    expect((await list(h, `?target=${bob.pk}`)).total).toBe(1);
    expect((await list(h, `?target=${alice.pk}`)).total).toBe(0);
  });

  test("event views count reports with one grouped query", async () => {
    const h = await createHarness();
    const [a, b] = [signEvent(newKey(), 1, [], "a"), signEvent(newKey(), 1, [], "b")];
    for (const e of [a, b]) await h.events.save(e);
    for (let i = 0; i < 3; i++) await h.relay.publish(signEvent(newKey(), 1984, [["e", a.id, "spam"]]), "api");
    await h.relay.publish(signEvent(newKey(), 1984, [["e", b.id, "spam"]]), "api");
    const q = (await (await h.asKey(h.owner, "/events/query", { method: "POST", body: { filters: [{ kinds: [1] }] } })).json()) as { items: EventView[] };
    expect(Object.fromEntries(q.items.map((v) => [v.event.id, v.reports]))).toEqual({ [a.id]: 3, [b.id]: 1 });
  });
});

describe("report index backfill", () => {
  test("indexes every stored report on the SQL event store, including more than a page sharing one second", async () => {
    const stores = await createTestStores();
    const h = await createHarness({ db: stores.db });
    const deps = { ...h.deps, stores: { ...h.deps.stores, events: stores.events, kv: stores.kv } };
    const now = Math.floor(Date.now() / 1000);
    const reporter = newKey();
    for (let i = 0; i < 1500; i++) await stores.events.save(signEvent(reporter, 1984, [["p", newKey().pk, "spam"]], `same ${i}`, now - 10));
    for (let i = 0; i < 1200; i++) await stores.events.save(signEvent(reporter, 1984, [["p", newKey().pk, "spam"]], `spread ${i}`, now - 100 - i));
    await h.stores.db.run("DELETE FROM admin_report_index");
    const api = await createAdminApi(deps, { now: () => h.clock.now });
    expect(await indexRows(h)).toBe(2700);
    const path = "/reports?status=open&limit=5&offset=2690";
    const page = (await (await api.app.request(path, { headers: { authorization: nip98Header(h.owner, h.url(path), "GET") } })).json()) as Paged<ReportView>;
    expect(page.total).toBe(2700);
    expect(page.items).toHaveLength(5);
    // the flag makes it a one-time run
    await h.stores.db.run("DELETE FROM admin_report_index");
    await createAdminApi(deps, { now: () => h.clock.now });
    expect(await indexRows(h)).toBe(0);
    await stores.db.close();
  });
});

describe("bulk resolve", () => {
  test("bans each subject and deletes each target once, building no views", async () => {
    const h = await createHarness();
    const bad = newKey();
    const note = signEvent(bad, 1, [], "spam");
    await h.events.save(note);
    const rs = [0, 1, 2].map(() => signEvent(newKey(), 1984, [["e", note.id, "spam"], ["p", bad.pk]]));
    for (const r of rs) await h.relay.publish(r, "api");
    await Bun.sleep(20); // the new-report push builds its view in the background
    let bans = 0;
    let deletions = 0;
    h.bus.on("user.updated", (e) => void (e.pubkey === bad.pk && e.user.status === "banned" && bans++));
    h.bus.on("event.deleted", () => void deletions++);
    const getMany = h.deps.stores.events.query.bind(h.deps.stores.events);
    let profileLookups = 0;
    h.deps.stores.events.query = (filters, opts) => {
      if (filters.some((f) => f.kinds?.includes(0))) profileLookups++;
      return getMany(filters, opts);
    };
    const res = await h.asKey(h.owner, "/reports/bulk-resolve", { method: "POST", body: { ids: rs.map((r) => r.id), action: "delete-and-ban" } });
    expect((await res.json()) as ReportBulkResult).toEqual({ ok: 3, failed: [] });
    expect(bans).toBe(1);
    expect(deletions).toBe(1);
    expect(profileLookups).toBe(0);
    expect((await list(h, "?status=resolved")).total).toBe(3);
    const effects = h.audit.entries.find((e) => e.action === "report.bulk-resolve")?.details.effects as Record<string, unknown>[];
    expect(effects.map((e) => e.banned)).toEqual([bad.pk, bad.pk, bad.pk]);
    expect(effects.filter((e) => e.deletedEvents !== undefined)).toHaveLength(1);
  });

  test("a refused subject is refused once for all its reports", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const post = signEvent(admin, 1, [], "x");
    await h.events.save(post);
    const rs = [0, 1].map(() => signEvent(newKey(), 1984, [["e", post.id, "spam"]]));
    for (const r of rs) await h.relay.publish(r, "api");
    const r = (await (await h.asKey(mod, "/reports/bulk-resolve", { method: "POST", body: { ids: rs.map((x) => x.id), action: "ban-user" } })).json()) as ReportBulkResult;
    expect(r.ok).toBe(0);
    expect(r.failed.map((f) => f.error)).toEqual(["cannot moderate a user with role admin", "cannot moderate a user with role admin"]);
    expect((await h.stores.users.get(admin.pk))?.status).toBe("active");
  });
});
