/** Content: query, delete by id / ids / filter with rank checks, NDJSON export → import round trip into a second relay. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient } from "../harness/client";
import { api, signEvent, user } from "./admin-helpers";

let relay: Relay;
let other: Relay;
const clients: RelayClient[] = [];
beforeAll(async () => {
  [relay, other] = await Promise.all([startRelay(), startRelay()]);
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
afterAll(async () => {
  await relay?.stop();
  await other?.stop();
});

const owner = () => relay.owner.sk;
async function client(r = relay) {
  const c = await RelayClient.connect(r.ws);
  clients.push(c);
  return c;
}
async function publish(sk: Uint8Array, t: { kind: number; content?: string; tags?: string[][]; created_at?: number }, r = relay): Promise<Event> {
  const ev = signEvent(sk, t);
  expect((await (await client(r)).publish(ev)).ok).toBe(true);
  return ev;
}
async function ids(filter: Record<string, unknown>, r = relay) {
  return (await (await client(r)).query(`q${Math.random()}`, [filter])).events.map((e) => e.id).sort();
}
const query = (filters: unknown[], limit?: number) => api(relay.http, owner(), "POST", "/events/query", { filters, ...(limit ? { limit } : {}) });
const exportUrl = (filters: unknown) => `/events/export?filters=${encodeURIComponent(JSON.stringify(filters))}`;

describe("query", () => {
  test("filters by author/kind, returns EventViews with report counts and author profile", async () => {
    const u = user();
    await publish(u.sk, { kind: 0, content: JSON.stringify({ name: "querytest" }) });
    const n1 = await publish(u.sk, { kind: 1, content: "one" });
    const n2 = await publish(u.sk, { kind: 1, content: "two" });
    await publish(user().sk, { kind: 1984, tags: [["e", n1.id, "spam"], ["p", u.pubkey]] });
    const r = await query([{ authors: [u.pubkey], kinds: [1] }]);
    expect(r.status).toBe(200);
    expect(r.body.items.map((v: any) => v.event.id).sort()).toEqual([n1.id, n2.id].sort());
    const v1 = r.body.items.find((v: any) => v.event.id === n1.id);
    expect(v1.reports).toBe(1);
    expect(v1.author.name).toBe("querytest");
    expect(r.body.items.find((v: any) => v.event.id === n2.id).reports).toBe(0);
    const limited = await query([{ authors: [u.pubkey] }], 1);
    expect(limited.body.items.length).toBe(1);
  });

  test("validation: empty filters, unknown keys, bad ids", async () => {
    expect((await query([])).status).toBe(400);
    const unk = await query([{ nonsense: 1 }]);
    expect(unk.status).toBe(400);
    expect((await query([{ ids: ["xyz"] }])).status).toBe(400);
    expect((await api(relay.http, owner(), "POST", "/events/query", undefined, { raw: "{bad" })).status).toBe(400);
  });

  test("GET /events/:id and DELETE /events/:id with audit", async () => {
    const u = user();
    const n = await publish(u.sk, { kind: 1, content: "to delete" });
    const g = await api(relay.http, owner(), "GET", `/events/${n.id}`);
    expect(g.body.event).toEqual(JSON.parse(JSON.stringify(n)));
    const d = await api(relay.http, owner(), "DELETE", `/events/${n.id}`, { reason: "cleanup" });
    expect(d.body).toEqual({ deleted: 1 });
    expect(await ids({ ids: [n.id] })).toEqual([]);
    expect((await api(relay.http, owner(), "GET", `/events/${n.id}`)).status).toBe(404);
    expect((await api(relay.http, owner(), "DELETE", `/events/${n.id}`)).status).toBe(404);
    const audit = await api(relay.http, owner(), "GET", `/audit?action=event.delete&target=${n.id}`);
    expect(audit.body.items[0].details).toMatchObject({ kind: 1, pubkey: u.pubkey, reason: "cleanup" });
  });
});

describe("delete", () => {
  test("by ids and by filter; unconstrained filters and empty bodies are refused", async () => {
    const a = user();
    const b = user();
    const a1 = await publish(a.sk, { kind: 1, content: "a1" });
    const a2 = await publish(a.sk, { kind: 7, content: "+", tags: [["e", a1.id]] });
    const a3 = await publish(a.sk, { kind: 1, content: "a3" });
    const b1 = await publish(b.sk, { kind: 1, content: "b1" });
    const byIds = await api(relay.http, owner(), "POST", "/events/delete", { ids: [a1.id, b1.id], reason: "ids" });
    expect(byIds.body.deleted).toBe(2);
    expect(await ids({ ids: [a1.id, b1.id] })).toEqual([]);
    const byFilter = await api(relay.http, owner(), "POST", "/events/delete", { filters: [{ authors: [a.pubkey], kinds: [7] }] });
    expect(byFilter.body.deleted).toBe(1);
    expect(await ids({ authors: [a.pubkey] })).toEqual([a3.id]);
    expect(await ids({ ids: [a2.id] })).toEqual([]);
    expect((await api(relay.http, owner(), "POST", "/events/delete", { filters: [{ limit: 10 }] })).status).toBe(400);
    expect((await api(relay.http, owner(), "POST", "/events/delete", {})).status).toBe(400);
    expect((await api(relay.http, owner(), "POST", "/events/delete", { ids: ["zz"] })).status).toBe(400);
    const audit = await api(relay.http, owner(), "GET", "/audit?action=event.delete");
    const entry = audit.body.items.find((e: any) => e.details.reason === "ids");
    expect(entry.details.deleted).toBe(2);
  });

  test("a moderator can delete regular users' events but not an admin's (by ids or filter)", async () => {
    const mod = user();
    const admin = user();
    await api(relay.http, owner(), "PUT", `/users/${mod.pubkey}/role`, { role: "moderator" });
    await api(relay.http, owner(), "PUT", `/users/${admin.pubkey}/role`, { role: "admin" });
    const plain = user();
    const pe = await publish(plain.sk, { kind: 1, content: "plain" });
    const ae = await publish(admin.sk, { kind: 1, content: "admin" });
    const r1 = await api(relay.http, mod.sk, "POST", "/events/delete", { ids: [pe.id, ae.id] });
    expect(r1.status).toBe(403);
    expect(r1.body.code).toBe("forbidden_target");
    // nothing was deleted by the refused request
    expect(await ids({ ids: [pe.id, ae.id] })).toEqual([pe.id, ae.id].sort());
    const r2 = await api(relay.http, mod.sk, "POST", "/events/delete", { filters: [{ authors: [admin.pubkey] }] });
    expect(r2.status).toBe(403);
    expect((await api(relay.http, mod.sk, "DELETE", `/events/${ae.id}`)).status).toBe(403);
    // a filter without authors is resolved and rank-checked per event
    const r3 = await api(relay.http, mod.sk, "POST", "/events/delete", { filters: [{ ids: [ae.id] }] });
    expect(r3.status).toBe(403);
    expect((await api(relay.http, mod.sk, "POST", "/events/delete", { ids: [pe.id] })).body.deleted).toBe(1);
    expect(await ids({ ids: [ae.id] })).toEqual([ae.id]);
  });
});

describe("export / import", () => {
  test("export streams NDJSON of exactly the matching events, with an audit entry", async () => {
    const u = user();
    const evs: Event[] = [];
    for (let i = 0; i < 5; i++) evs.push(await publish(u.sk, { kind: 1, content: `exp ${i}`, created_at: Math.floor(Date.now() / 1000) - i }));
    const r = await api(relay.http, owner(), "GET", exportUrl([{ authors: [u.pubkey] }]));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/x-ndjson");
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="beamhop-export-.*\.jsonl"/);
    const lines = (r.body as string).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => e.id).sort()).toEqual(evs.map((e) => e.id).sort());
    // newest first
    expect(lines.map((e) => e.created_at)).toEqual([...lines.map((e) => e.created_at)].sort((a, b) => b - a));
    const lim = await api(relay.http, owner(), "GET", exportUrl([{ authors: [u.pubkey], limit: 2 }]));
    expect((lim.body as string).trim().split("\n").length).toBe(2);
    expect((await api(relay.http, owner(), "GET", "/events/export?filters=notjson")).status).toBe(400);
    const audit = await api(relay.http, owner(), "GET", "/audit?action=event.export");
    expect(audit.body.items.map((e: any) => e.details.filters)).toContainEqual([{ authors: [u.pubkey] }]);
    expect(audit.body.items[0].details.filters).toEqual([{ authors: [u.pubkey], limit: 2 }]);
  });

  test("round trip: export from one relay, import into another, re-import counts duplicates", async () => {
    const u = user();
    const evs: Event[] = [];
    for (let i = 0; i < 4; i++) evs.push(await publish(u.sk, { kind: 1, content: `rt ${i}` }));
    const exp = await api(relay.http, owner(), "GET", exportUrl([{ authors: [u.pubkey] }]));
    const ndjson = exp.body as string;
    const imp = await api(other.http, other.owner.sk, "POST", "/events/import", undefined, { raw: ndjson, contentType: "application/x-ndjson" });
    expect(imp.status).toBe(200);
    expect(imp.body).toEqual({ imported: 4, duplicates: 0, rejected: 0, errors: [] });
    expect(await ids({ authors: [u.pubkey] }, other)).toEqual(evs.map((e) => e.id).sort());
    const again = await api(other.http, other.owner.sk, "POST", "/events/import", undefined, { raw: ndjson, contentType: "application/x-ndjson" });
    expect(again.body).toEqual({ imported: 0, duplicates: 4, rejected: 0, errors: [] });
    const audit = await api(other.http, other.owner.sk, "GET", "/audit?action=event.import");
    expect(audit.body.items[0].details).toMatchObject({ imported: 0, duplicates: 4 });
  });

  test("import reports bad lines, accepts ['EVENT', ev] frames, and applies policies unless bypassed", async () => {
    const good = signEvent(user().sk, { kind: 1, content: "good" });
    const framed = signEvent(user().sk, { kind: 1, content: "framed" });
    const forged = { ...signEvent(user().sk, { kind: 1, content: "x" }), content: "forged" };
    const body = [JSON.stringify(good), "{not json", JSON.stringify({ hello: 1 }), JSON.stringify(["EVENT", framed]), JSON.stringify(forged), ""].join("\n");
    const r = await api(other.http, other.owner.sk, "POST", "/events/import", undefined, { raw: body, contentType: "application/x-ndjson" });
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(2);
    expect(r.body.rejected).toBe(3);
    expect(r.body.errors[0]).toBe("line 2: invalid JSON");
    expect(r.body.errors[1]).toBe("line 3: not a nostr event");
    expect(r.body.errors[2]).toStartWith("line 5:");
    // a banned author's events are rejected through the relay pipeline, but bypassPolicies stores them
    const banned = user();
    await api(other.http, other.owner.sk, "POST", `/users/${banned.pubkey}/ban`, {});
    const ev = signEvent(banned.sk, { kind: 1, content: "from banned" });
    const pol = await api(other.http, other.owner.sk, "POST", "/events/import", undefined, { raw: JSON.stringify(ev), contentType: "application/x-ndjson" });
    expect(pol.body.rejected).toBe(1);
    expect(pol.body.errors[0]).toContain("banned");
    const byp = await api(other.http, other.owner.sk, "POST", "/events/import?bypassPolicies=true", undefined, { raw: JSON.stringify(ev), contentType: "application/x-ndjson" });
    expect(byp.body.imported).toBe(1);
    expect((await api(other.http, other.owner.sk, "GET", `/events/${ev.id}`)).status).toBe(200);
  });

  test("import/export need their own permissions; non-JSON body types are refused", async () => {
    const mod = user();
    await api(other.http, other.owner.sk, "PUT", `/users/${mod.pubkey}/role`, { role: "moderator" });
    const ev = signEvent(user().sk, { kind: 1, content: "x" });
    const r = await api(other.http, mod.sk, "POST", "/events/import", undefined, { raw: JSON.stringify(ev), contentType: "application/x-ndjson" });
    expect(r.status).toBe(403);
    expect((await api(other.http, mod.sk, "GET", "/events/export")).status).toBe(403);
  });
});
