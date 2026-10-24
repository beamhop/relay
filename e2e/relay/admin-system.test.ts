/** System, metrics, connections, groups (NIP-29), plugins, push and audit routes against live relay activity. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { nip19 } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient } from "../harness/client";
import { api, signEvent, user, waitUntil } from "./admin-helpers";

const HELLO = join(import.meta.dir, "../../plugins/hello");

let relay: Relay;
const clients: RelayClient[] = [];
beforeAll(async () => {
  relay = await startRelay({ overrides: { plugins: { packages: [HELLO] } } });
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
async function role(r: string) {
  const u = user();
  expect((await api(relay.http, owner(), "PUT", `/users/${u.pubkey}/role`, { role: r })).status).toBe(200);
  return u;
}

describe("system and metrics", () => {
  test("GET /system describes this instance", async () => {
    const r = await api(relay.http, owner(), "GET", "/system");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ runtime: "bun", dbDialect: "sqlite", publicUrl: relay.http, blossomEnabled: true, geoipEnabled: false });
    expect(r.body.relayPubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.nips).toEqual(expect.arrayContaining([1, 11, 42]));
    const nip11 = await (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json();
    expect(nip11.self ?? r.body.relayPubkey).toBe(r.body.relayPubkey);
    expect(nip11.supported_nips).toEqual(r.body.nips);
  });

  // (totalEvents / media stats are refreshed on a slow timer, so only live counters are asserted)
  test("dashboard snapshot counts live and authed connections", async () => {
    const c = await client();
    await c.auth(user().sk, relay.ws);
    const snap = await waitUntil(async () => {
      const r = await api(relay.http, owner(), "GET", "/dashboard/snapshot");
      return r.body.connections >= 1 && r.body.authedConnections >= 1 ? r.body : undefined;
    });
    expect(typeof snap.uptimeSec).toBe("number");
    expect(typeof snap.memoryRss).toBe("number");
  });

  test("series / kinds / top-pubkeys / rejections validate their ranges", async () => {
    const t = Math.floor(Date.now() / 1000);
    const ok = await api(relay.http, owner(), "GET", `/metrics/series?name=events_in&from=${t - 3600}&to=${t}`);
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("events_in");
    expect(Array.isArray(ok.body.points)).toBe(true);
    expect((await api(relay.http, owner(), "GET", `/metrics/series?name=events_in&from=${t}&to=${t - 10}`)).body.error).toBe("from must be before to");
    expect((await api(relay.http, owner(), "GET", `/metrics/series?name=events_in&from=0&to=${t}`)).body.error).toBe("range too large");
    expect((await api(relay.http, owner(), "GET", `/metrics/series?name=events_in&from=${t - 86400 * 30}&to=${t}&step=60`)).body.error).toContain("too many points");
    expect((await api(relay.http, owner(), "GET", "/metrics/series?name=bad%20name")).status).toBe(400);
    expect((await api(relay.http, owner(), "GET", "/metrics/series")).status).toBe(400);
    for (const p of ["/metrics/kinds", "/metrics/rejections", "/metrics/geo", "/metrics/top-pubkeys?limit=5"]) {
      const r = await api(relay.http, owner(), "GET", p);
      expect([p, r.status, Array.isArray(r.body.items)]).toEqual([p, 200, true]);
    }
    expect((await api(relay.http, owner(), "GET", "/metrics/top-pubkeys?limit=1000")).status).toBe(400);
  });
});

describe("connections", () => {
  test("lists authed ws connections; DELETE closes one; disconnect by pubkey closes all of theirs", async () => {
    const u = user();
    const a = await client();
    const b = await client();
    expect((await a.auth(u.sk, relay.ws)).ok).toBe(true);
    expect((await b.auth(u.sk, relay.ws)).ok).toBe(true);
    const list = await api(relay.http, owner(), "GET", "/connections");
    const mine = list.body.items.filter((c: any) => JSON.stringify(c).includes(u.pubkey));
    expect(mine.length).toBe(2);
    expect(list.body.total).toBe(list.body.items.length);
    const del = await api(relay.http, owner(), "DELETE", `/connections/${mine[0].id}`);
    expect(del.body).toEqual({ ok: true, closed: 1 });
    await waitUntil(async () => a.closed || b.closed);
    const rest = await api(relay.http, owner(), "POST", "/connections/disconnect", { pubkey: nip19.npubEncode(u.pubkey) });
    expect(rest.body).toEqual({ ok: true, closed: 1 });
    await waitUntil(async () => a.closed && b.closed);
    expect((await api(relay.http, owner(), "DELETE", `/connections/${mine[0].id}`)).status).toBe(404);
    expect((await api(relay.http, owner(), "POST", "/connections/disconnect", {})).status).toBe(400);
    expect((await api(relay.http, owner(), "POST", "/connections/disconnect", { pubkey: "nope" })).status).toBe(400);
    const m = await role("moderator");
    expect((await api(relay.http, m.sk, "GET", "/connections")).status).toBe(403);
  });
});

describe("groups (NIP-29)", () => {
  test("a group created over ws is listed, inspectable and deletable by admins only", async () => {
    const creator = user();
    const id = `g${Math.floor(Math.random() * 1e9)}`;
    const c = await client();
    const res = await c.publish(signEvent(creator.sk, { kind: 9007, tags: [["h", id]] }));
    expect(res.ok).toBe(true);
    const list = await api(relay.http, owner(), "GET", "/groups");
    const g = list.body.items.find((x: any) => x.id === id);
    expect(g).toMatchObject({ id, name: id });
    const one = await api(relay.http, owner(), "GET", `/groups/${id}`);
    expect(one.body.memberList.map((m: any) => m.pubkey)).toContain(creator.pubkey);
    const m = await role("moderator");
    expect((await api(relay.http, m.sk, "GET", `/groups/${id}`)).status).toBe(200);
    expect((await api(relay.http, m.sk, "DELETE", `/groups/${id}`)).status).toBe(403);
    expect((await api(relay.http, owner(), "DELETE", `/groups/${id}`)).body).toEqual({ ok: true });
    await waitUntil(async () => (await api(relay.http, owner(), "GET", `/groups/${id}`)).status === 404);
    expect((await api(relay.http, owner(), "DELETE", `/groups/${id}`)).status).toBe(404);
    const audit = await api(relay.http, owner(), "GET", `/audit?action=group.delete&target=${id}`);
    expect(audit.body.items.length).toBe(1);
  });

  test("groups.creation=admins blocks regular users from creating groups", async () => {
    await api(relay.http, owner(), "PATCH", "/settings", { groups: { creation: "admins" } });
    try {
      const c = await client();
      const res = await c.publish(signEvent(user().sk, { kind: 9007, tags: [["h", `x${Math.floor(Math.random() * 1e9)}`]] }));
      expect(res.ok).toBe(false);
      expect(res.message).toContain("not allowed to create groups");
    } finally {
      await api(relay.http, owner(), "PATCH", "/settings", { groups: { creation: "members" } });
    }
  });
});

describe("plugins", () => {
  test("enable → write hook, routes and settings work; disable removes them", async () => {
    const list = await api(relay.http, owner(), "GET", "/plugins");
    const hello = list.body.items.find((p: any) => p.name === "hello");
    expect(hello).toBeDefined();
    expect(hello.enabled).toBe(false);
    const en = await api(relay.http, owner(), "POST", "/plugins/hello/enable");
    expect(en.status).toBe(200);
    expect(en.body.enabled).toBe(true);
    try {
      const c = await client();
      const blocked = await c.publish(signEvent(user().sk, { kind: 1, content: "this has the forbidden-word" }));
      expect(blocked).toEqual({ ok: false, message: "blocked: contains a forbidden word" });
      const pub = await fetch(`${relay.http}/plugins/hello/`);
      expect((await pub.json()).greeting).toBe("Hello from beamhop!");
      const stats = await api(relay.http, owner(), "GET", "/plugins/x/hello/stats");
      expect(stats.status).toBe(200);
      expect(stats.body.rejected).toBeGreaterThanOrEqual(1);
      // settings: schema + values, validation, live effect
      const s = await api(relay.http, owner(), "GET", "/plugins/hello/settings");
      expect(s.body.values.blockedWord).toBe("forbidden-word");
      expect(s.body.schema).toBeDefined();
      expect((await api(relay.http, owner(), "PATCH", "/plugins/hello/settings", { values: { maxQueryLimit: 0 } })).status).toBe(400);
      const upd = await api(relay.http, owner(), "PATCH", "/plugins/hello/settings", { values: { blockedWord: "kumquat", greeting: "hi e2e" } });
      expect(upd.status).toBe(200);
      expect(upd.body.values.blockedWord).toBe("kumquat");
      expect((await c.publish(signEvent(user().sk, { kind: 1, content: "forbidden-word is fine now" }))).ok).toBe(true);
      expect((await c.publish(signEvent(user().sk, { kind: 1, content: "KUMQUAT" }))).ok).toBe(false);
      expect((await (await fetch(`${relay.http}/plugins/hello/`)).json()).greeting).toBe("hi e2e");
      // viewers can look but not touch
      const v = await role("viewer");
      expect((await api(relay.http, v.sk, "GET", "/plugins/hello/settings")).status).toBe(200);
      expect((await api(relay.http, v.sk, "POST", "/plugins/hello/disable")).status).toBe(403);
      expect((await api(relay.http, v.sk, "GET", "/plugins/x/hello/stats")).status).toBe(403);
    } finally {
      const dis = await api(relay.http, owner(), "POST", "/plugins/hello/disable");
      expect(dis.body.enabled).toBe(false);
    }
    const c2 = await client();
    expect((await c2.publish(signEvent(user().sk, { kind: 1, content: "KUMQUAT again" }))).ok).toBe(true);
    expect((await fetch(`${relay.http}/plugins/hello/`)).status).toBe(404);
    const audit = await api(relay.http, owner(), "GET", "/audit?target=hello");
    expect(audit.body.items.map((e: any) => e.action)).toEqual(expect.arrayContaining(["plugin.enable", "plugin.disable", "plugin.settings"]));
    expect((await api(relay.http, owner(), "POST", "/plugins/nope/enable")).status).toBe(404);
  });
});

describe("push", () => {
  // nothing in this file files reports or alerts while subscribed, so no notification is ever sent out
  test("VAPID key is published; subscribe validates endpoints; unsubscribe removes once", async () => {
    const sys = await api(relay.http, owner(), "GET", "/system");
    expect(sys.body.pushEnabled).toBe(true);
    const v = await api(relay.http, owner(), "GET", "/push/vapid");
    expect(typeof v.body.publicKey).toBe("string");
    expect(v.body.publicKey.length).toBeGreaterThan(40);
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${Math.floor(Math.random() * 1e9)}`;
    const evil = await api(relay.http, owner(), "POST", "/push/subscribe", {
      subscription: { endpoint: "https://attacker.example/collect", keys: { p256dh: "x", auth: "y" } },
    });
    expect(evil.status).toBe(400);
    const sub = await api(relay.http, owner(), "POST", "/push/subscribe", { subscription: { endpoint, keys: { p256dh: "x", auth: "y" } }, topics: ["alerts"] });
    try {
      expect(sub.status).toBe(200);
      expect(sub.body).toEqual({ ok: true, topics: ["alerts"] });
    } finally {
      const un = await api(relay.http, owner(), "POST", "/push/unsubscribe", { endpoint });
      expect(un.body).toEqual({ ok: true, removed: true });
    }
    expect((await api(relay.http, owner(), "POST", "/push/unsubscribe", { endpoint })).body.removed).toBe(false);
    expect((await api(relay.http, null, "GET", "/push/vapid")).status).toBe(401);
    expect((await api(relay.http, user().sk, "GET", "/push/vapid")).status).toBe(403);
    const audit = await api(relay.http, owner(), "GET", "/audit?action=push.subscribe");
    expect(audit.body.items[0].details.topics).toEqual(["alerts"]);
  });
});

describe("audit log", () => {
  test("filters by actor (npub ok), action, target, before (id cursor) and limit; newest first", async () => {
    const a = await role("admin");
    const t1 = user();
    const t2 = user();
    await api(relay.http, a.sk, "POST", `/users/${t1.pubkey}/mute`);
    await api(relay.http, a.sk, "POST", `/users/${t2.pubkey}/mute`);
    const byActor = await api(relay.http, owner(), "GET", `/audit?actor=${nip19.npubEncode(a.pubkey)}`);
    expect(byActor.body.items.map((e: any) => e.target)).toEqual([t2.pubkey, t1.pubkey]);
    expect(byActor.body.items[0]).toMatchObject({ actor: a.pubkey, action: "user.mute", ip: "127.0.0.1" });
    const one = await api(relay.http, owner(), "GET", `/audit?actor=${a.pubkey}&limit=1`);
    expect(one.body.items.length).toBe(1);
    const byTarget = await api(relay.http, owner(), "GET", `/audit?target=${nip19.npubEncode(t1.pubkey)}`);
    expect(byTarget.body.items.map((e: any) => e.action)).toEqual(["user.mute"]);
    const newest = byActor.body.items[0];
    const before = await api(relay.http, owner(), "GET", `/audit?actor=${a.pubkey}&before=${newest.id}`);
    expect(before.body.items.map((e: any) => e.id)).toEqual([byActor.body.items[1].id]);
    expect((await api(relay.http, owner(), "GET", "/audit?limit=0")).status).toBe(400);
  });
});
