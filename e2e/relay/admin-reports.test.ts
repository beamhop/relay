/** NIP-56 reports published over ws → admin report queue → resolutions and their effects on relay, blossom and audit. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, pngBytes } from "../harness/client";
import { api, signEvent, upload, user, waitUntil } from "./admin-helpers";

let relay: Relay;
const clients: RelayClient[] = [];
beforeAll(async () => {
  relay = await startRelay({ overrides: { blossom: { limits: { uploadsPerMinutePerIp: 0, uploadsPerMinutePerPubkey: 0 } } } });
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
  expect(r).toEqual({ ok: true, message: "" });
  return ev;
}
async function exists(id: string): Promise<boolean> {
  const c = await client();
  const { events } = await c.query(`q${Math.random()}`, [{ ids: [id] }]);
  return events.length > 0;
}
/** an author with a note, and a report about it from a fresh reporter */
async function reported(type = "spam", opts: { p?: string } = {}) {
  const author = user();
  const reporter = user();
  const note = await publish(author.sk, { kind: 1, content: `reported note ${Math.random()}` });
  const report = await publish(reporter.sk, { kind: 1984, content: "bad", tags: [["e", note.id, type], ["p", opts.p ?? author.pubkey]] });
  return { author, reporter, note, report };
}
const resolve = (id: string, action: string, note?: string) => api(relay.http, owner(), "POST", `/reports/${id}/resolve`, { action, ...(note ? { note } : {}) });
const auditFor = async (id: string) => (await api(relay.http, owner(), "GET", `/audit?action=report.resolve&target=${id}`)).body.items;

describe("report queue", () => {
  test("a ws report shows up in GET /reports and /reports/:id with its target", async () => {
    const { author, reporter, note, report } = await reported("nudity");
    const list = await api(relay.http, owner(), "GET", `/reports?target=${note.id}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    const v = list.body.items[0];
    expect(v).toMatchObject({ id: report.id, reporter: reporter.pubkey, targetPubkey: author.pubkey, targetEventId: note.id, type: "nudity", status: "open" });
    expect(v.targetEvent.id).toBe(note.id);
    expect(v.relatedCount).toBe(1);
    const one = await api(relay.http, owner(), "GET", `/reports/${report.id}`);
    expect(one.body.id).toBe(report.id);
    expect((await api(relay.http, owner(), "GET", `/reports/${"0".repeat(64)}`)).status).toBe(404);
    // a non-report event id is not a report
    expect((await api(relay.http, owner(), "GET", `/reports/${note.id}`)).status).toBe(404);
  });

  test("filters: status, type, target pubkey (the author, not the p tag), pagination; relatedCount", async () => {
    const author = user();
    const note = await publish(author.sk, { kind: 1, content: "x" });
    const r1 = await publish(user().sk, { kind: 1984, tags: [["e", note.id, "malware"], ["p", author.pubkey]] });
    const r2 = await publish(user().sk, { kind: 1984, tags: [["e", note.id, "malware"], ["p", author.pubkey]] });
    const byAuthor = await api(relay.http, owner(), "GET", `/reports?target=${author.pubkey}`);
    expect(byAuthor.body.total).toBe(2);
    expect(byAuthor.body.items.every((i: any) => i.relatedCount === 2)).toBe(true);
    const page = await api(relay.http, owner(), "GET", `/reports?target=${author.pubkey}&limit=1&offset=1`);
    expect(page.body.items.length).toBe(1);
    expect(page.body.total).toBe(2);
    expect([r1.id, r2.id]).toContain(page.body.items[0].id);
    const typed = await api(relay.http, owner(), "GET", "/reports?type=MALWARE&status=open");
    expect(typed.body.items.map((i: any) => i.id)).toEqual(expect.arrayContaining([r1.id, r2.id]));
    expect((await resolve(r1.id, "dismiss")).status).toBe(200);
    const open = await api(relay.http, owner(), "GET", `/reports?target=${author.pubkey}&status=open`);
    expect(open.body.items.map((i: any) => i.id)).toEqual([r2.id]);
    expect(open.body.items[0].relatedCount).toBe(1);
    const dismissed = await api(relay.http, owner(), "GET", `/reports?target=${author.pubkey}&status=dismissed`);
    expect(dismissed.body.items.map((i: any) => i.id)).toEqual([r1.id]);
    expect((await api(relay.http, owner(), "GET", "/reports?status=bogus")).status).toBe(400);
    expect((await api(relay.http, owner(), "GET", "/reports?limit=0")).status).toBe(400);
  });
});

describe("resolutions", () => {
  test("dismiss: nothing is deleted, status dismissed, audit entry", async () => {
    const { note, report, author } = await reported();
    const r = await resolve(report.id, "dismiss", "not spam");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("dismissed");
    expect(r.body.resolution).toMatchObject({ action: "dismiss", by: relay.owner.pubkey, note: "not spam" });
    expect(await exists(note.id)).toBe(true);
    expect((await api(relay.http, owner(), "GET", `/users/${author.pubkey}`)).body.status).toBe("active");
    const audit = await auditFor(report.id);
    expect(audit[0]).toMatchObject({ actor: relay.owner.pubkey, action: "report.resolve", target: report.id });
    expect(audit[0].details).toMatchObject({ action: "dismiss", note: "not spam", target: note.id });
  });

  test("delete-event: the note disappears over ws, author not banned", async () => {
    const { note, report, author } = await reported();
    const r = await resolve(report.id, "delete-event");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("resolved");
    expect(await exists(note.id)).toBe(false);
    expect((await api(relay.http, owner(), "GET", `/events/${note.id}`)).status).toBe(404);
    expect((await api(relay.http, owner(), "GET", `/users/${author.pubkey}`)).body.status).toBe("active");
    expect((await auditFor(report.id))[0].details.deletedEvents).toBe(1);
  });

  test("ban-user: author banned, kicked from an authed connection, new events refused", async () => {
    const { note, report, author } = await reported();
    const conn = await client();
    expect((await conn.auth(author.sk, relay.ws)).ok).toBe(true);
    const r = await resolve(report.id, "ban-user");
    expect(r.status).toBe(200);
    await waitUntil(async () => conn.closed);
    expect(await exists(note.id)).toBe(true);
    const u = await api(relay.http, owner(), "GET", `/users/${author.pubkey}`);
    expect(u.body.status).toBe("banned");
    const c = await client();
    const res = await c.publish(signEvent(author.sk, { kind: 1, content: "after ban" }));
    expect(res.ok).toBe(false);
    expect(res.message).toStartWith("blocked: pubkey is banned");
    const details = (await auditFor(report.id))[0].details;
    expect(details.banned).toBe(author.pubkey);
    expect(details.disconnected).toBe(1);
  });

  test("delete-and-ban: both effects", async () => {
    const { note, report, author } = await reported();
    const r = await resolve(report.id, "delete-and-ban");
    expect(r.status).toBe(200);
    expect(await exists(note.id)).toBe(false);
    expect((await api(relay.http, owner(), "GET", `/users/${author.pubkey}`)).body.status).toBe("banned");
  });

  test("a p tag naming an innocent user doesn't steer the ban: the stored event's author is banned", async () => {
    const innocent = user();
    const { report, author } = await reported("spam", { p: innocent.pubkey });
    const view = await api(relay.http, owner(), "GET", `/reports/${report.id}`);
    expect(view.body.targetPubkey).toBe(author.pubkey);
    expect(view.body.claimedPubkey).toBe(innocent.pubkey);
    expect((await resolve(report.id, "ban-user")).status).toBe(200);
    expect((await api(relay.http, owner(), "GET", `/users/${author.pubkey}`)).body.status).toBe("banned");
    expect((await api(relay.http, owner(), "GET", `/users/${innocent.pubkey}`)).body.status).toBe("active");
  });

  test("delete-and-ban / delete-event on a pubkey-only report are 400 and leave it open", async () => {
    const target = user();
    const report = await publish(user().sk, { kind: 1984, tags: [["p", target.pubkey, "impersonation"]] });
    for (const action of ["delete-and-ban", "delete-event"]) {
      const r = await resolve(report.id, action);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("report has no target event");
    }
    expect((await resolve(report.id, "delete-media")).status).toBe(400);
    const v = await api(relay.http, owner(), "GET", `/reports/${report.id}`);
    expect(v.body.status).toBe("open");
    expect(v.body.type).toBe("impersonation");
    expect((await api(relay.http, owner(), "GET", `/users/${target.pubkey}`)).body.status).toBe("active");
    // ban-user still works via the p tag
    expect((await resolve(report.id, "ban-user")).status).toBe(200);
    expect((await api(relay.http, owner(), "GET", `/users/${target.pubkey}`)).body.status).toBe("banned");
  });

  test("delete-media: the reported blob is deleted and blocked from re-upload", async () => {
    const uploader = user();
    const up = await upload(relay.http, uploader.sk, pngBytes());
    expect(up.status).toBe(201);
    const report = await publish(user().sk, { kind: 1984, tags: [["x", up.sha, "illegal"], ["p", uploader.pubkey]] });
    const view = await api(relay.http, owner(), "GET", `/reports/${report.id}`);
    expect(view.body.targetBlob).toBe(up.sha);
    expect(view.body.targetPubkey).toBe(uploader.pubkey);
    const r = await resolve(report.id, "delete-media");
    expect(r.status).toBe(200);
    expect((await fetch(`${relay.http}/${up.sha}`)).status).toBe(404);
    expect((await upload(relay.http, uploader.sk, up.bytes)).status).toBe(403);
    const bl = await api(relay.http, owner(), "GET", "/media/blocklist");
    expect(bl.body.items.map((e: any) => e.sha256)).toContain(up.sha);
    expect((await auditFor(report.id))[0].details.deletedBlob).toBe(up.sha);
  });

  test("invalid action and unknown report", async () => {
    const { report } = await reported();
    expect((await resolve(report.id, "nuke")).status).toBe(400);
    expect((await resolve("1".repeat(64), "dismiss")).status).toBe(404);
    expect((await resolve("nothex", "dismiss")).status).toBe(400);
  });

  test("bulk-resolve: applies to each id, reports failures", async () => {
    const a = await reported();
    const b = await reported();
    const r = await api(relay.http, owner(), "POST", "/reports/bulk-resolve", { ids: [a.report.id, b.report.id, "2".repeat(64)], action: "delete-event" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(2);
    expect(r.body.failed).toEqual([{ id: "2".repeat(64), error: "report not found" }]);
    expect(await exists(a.note.id)).toBe(false);
    expect(await exists(b.note.id)).toBe(false);
    const audit = await api(relay.http, owner(), "GET", "/audit?action=report.bulk-resolve");
    expect(audit.body.items[0].details).toMatchObject({ action: "delete-event", ok: 2 });
  });
});

describe("automatic reports and bans", () => {
  test("a word filter with action=report files a relay-signed report", async () => {
    const word = `badword${Math.floor(Math.random() * 1e9)}`;
    const set = await api(relay.http, owner(), "PATCH", "/settings", {
      moderation: { wordFilters: [{ id: "w1", pattern: word, isRegex: false, kinds: [], action: "report", enabled: true }] },
    });
    expect(set.status).toBe(200);
    try {
      const author = user();
      const note = await publish(author.sk, { kind: 1, content: `this has ${word} in it` });
      const list = await waitUntil(async () => {
        const r = await api(relay.http, owner(), "GET", `/reports?target=${note.id}`);
        return r.body.total === 1 ? r : undefined;
      });
      const sys = await api(relay.http, owner(), "GET", "/system");
      expect(list.body.items[0].reporter).toBe(sys.body.relayPubkey);
      expect(list.body.items[0].targetPubkey).toBe(author.pubkey);
    } finally {
      await api(relay.http, owner(), "PATCH", "/settings", { moderation: { wordFilters: [] } });
    }
  });

  test("autoBanReportThreshold: reports from distinct members ban the target; non-members don't count", async () => {
    expect((await api(relay.http, owner(), "PATCH", "/settings", { moderation: { autoBanReportThreshold: 2 } })).status).toBe(200);
    try {
      const target = user();
      const m1 = user();
      const m2 = user();
      for (const m of [m1, m2]) expect((await api(relay.http, owner(), "POST", "/users", { pubkey: m.pubkey, allowed: true })).status).toBe(201);
      // two non-members: no ban
      await publish(user().sk, { kind: 1984, tags: [["p", target.pubkey, "spam"]] });
      await publish(user().sk, { kind: 1984, tags: [["p", target.pubkey, "spam"]] });
      await publish(m1.sk, { kind: 1984, tags: [["p", target.pubkey, "spam"]] });
      await Bun.sleep(200);
      expect((await api(relay.http, owner(), "GET", `/users/${target.pubkey}`)).body.status).toBe("active");
      await publish(m2.sk, { kind: 1984, tags: [["p", target.pubkey, "spam"]] });
      await waitUntil(async () => (await api(relay.http, owner(), "GET", `/users/${target.pubkey}`)).body.status === "banned");
      const c = await client();
      expect((await c.publish(signEvent(target.sk, { kind: 1, content: "hi" }))).ok).toBe(false);
    } finally {
      await api(relay.http, owner(), "PATCH", "/settings", { moderation: { autoBanReportThreshold: 0 } });
    }
  });
});

describe("report permissions", () => {
  test("viewer can list but not resolve; moderator resolves but can't ban an admin", async () => {
    const viewer = user();
    const mod = user();
    const admin = user();
    expect((await api(relay.http, owner(), "PUT", `/users/${viewer.pubkey}/role`, { role: "viewer" })).status).toBe(200);
    expect((await api(relay.http, owner(), "PUT", `/users/${mod.pubkey}/role`, { role: "moderator" })).status).toBe(200);
    expect((await api(relay.http, owner(), "PUT", `/users/${admin.pubkey}/role`, { role: "admin" })).status).toBe(200);
    const { report } = await reported();
    expect((await api(relay.http, viewer.sk, "GET", "/reports")).status).toBe(200);
    const vr = await api(relay.http, viewer.sk, "POST", `/reports/${report.id}/resolve`, { action: "dismiss" });
    expect(vr.status).toBe(403);
    expect(vr.body.code).toBe("missing_permission");
    const note = await publish(admin.sk, { kind: 1, content: "admin note" });
    const adminReport = await publish(user().sk, { kind: 1984, tags: [["e", note.id, "spam"], ["p", admin.pubkey]] });
    const mr = await api(relay.http, mod.sk, "POST", `/reports/${adminReport.id}/resolve`, { action: "ban-user" });
    expect(mr.status).toBe(403);
    expect((await api(relay.http, owner(), "GET", `/users/${admin.pubkey}`)).body.status).toBe("active");
    expect((await api(relay.http, mod.sk, "POST", `/reports/${report.id}/resolve`, { action: "delete-and-ban" })).status).toBe(200);
  });
});
