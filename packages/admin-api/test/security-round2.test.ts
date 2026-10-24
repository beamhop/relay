import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { maskSecrets } from "../src/routes/plugins";
import { isAllowedPushEndpoint } from "../src/services/push";
import { isPrivateIp } from "../src/util/ip";
import { rateKey } from "../src/util/request";
import { createHarness, newKey, nip98Header, PUBLIC_URL, signEvent } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const challengeOf = async (h: Harness, headers: Record<string, string> = {}) =>
  (await (await h.req("/auth/challenge", { headers })).json()) as { challenge: string; url: string };
const nostrLogin = (h: Harness, event: NostrEvent) =>
  h.req("/auth/nostr", { method: "POST", body: JSON.stringify({ event }), headers: { "content-type": "application/json" } });
const loginEvent = (h: Harness, k = h.owner, challenge: string, u = `${PUBLIC_URL}/admin/api/auth/nostr`) =>
  signEvent(k, 27235, [["u", u], ["method", "POST"], ["challenge", challenge]], "", Math.floor(h.clock.now / 1000));

describe("push endpoints (SSRF)", () => {
  test("only known Web Push services on 443 are allowed", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGx",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
      "https://fcm.googleapis.com:443/wp/abc",
    ])
      expect(isAllowedPushEndpoint(ok)).toBe(true);
    for (const bad of [
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://fcm.googleapis.com.evil.test/x",
      "https://evilnotify.windows.com/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://storage.googleapis.com/bucket/x",
      "not a url",
    ])
      expect(isAllowedPushEndpoint(bad)).toBe(false);
  });

  test("subscribing an internal endpoint is refused, even for the owner", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    const sub = (endpoint: string) => ({ subscription: { endpoint, keys: { p256dh: "k", auth: "a" } } });
    expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub("https://10.0.0.5:8443/hook") })).status).toBe(400);
    const viewer = await h.addAdmin("viewer");
    expect((await h.asKey(viewer, "/push/subscribe", { method: "POST", body: sub("https://169.254.169.254/") })).status).toBe(400);
    expect((await h.asKey(viewer, "/push/subscribe", { method: "POST", body: sub("https://fcm.googleapis.com/fcm/send/v") })).status).toBe(200);
  });

  test("legacy rows pointing elsewhere are dropped at send time, never contacted", async () => {
    const sent: string[] = [];
    const h = await createHarness({ pushSender: async (s) => void sent.push(s.endpoint) });
    const legacy = "https://internal.corp:9000/admin";
    await h.stores.db.run("INSERT INTO admin_push_subscriptions (endpoint, pubkey, subscription, topics, created_at) VALUES (?, ?, ?, ?, ?)", [
      legacy,
      h.owner.pk,
      JSON.stringify({ endpoint: legacy, keys: { p256dh: "k", auth: "a" } }),
      JSON.stringify(["reports"]),
      1,
    ]);
    await h.relay.publish(signEvent(newKey(), 1984, [["p", newKey().pk, "spam"]]), "api");
    await Bun.sleep(20);
    expect(sent).toEqual([]);
    expect(await h.stores.db.all("SELECT endpoint FROM admin_push_subscriptions")).toHaveLength(0);
  });

  test("subscriptions per admin are capped: the oldest device makes room", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    const sub = (i: number) => ({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: { p256dh: "k", auth: "a" } } });
    for (let i = 0; i < 20; i++) {
      h.clock.now += 1000;
      expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub(i) })).status).toBe(200);
    }
    h.clock.now += 1000;
    expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub(20) })).status).toBe(200);
    const rows = await h.stores.db.all<{ endpoint: string }>("SELECT endpoint FROM admin_push_subscriptions WHERE pubkey = ?", [h.owner.pk]);
    expect(rows).toHaveLength(20);
    expect(rows.map((r) => r.endpoint)).not.toContain("https://fcm.googleapis.com/fcm/send/0");
    expect(rows.map((r) => r.endpoint)).toContain("https://fcm.googleapis.com/fcm/send/20");
    // re-subscribing an existing device keeps the count
    expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub(3) })).status).toBe(200);
    expect(await h.stores.db.all("SELECT endpoint FROM admin_push_subscriptions WHERE pubkey = ?", [h.owner.pk])).toHaveLength(20);
  });

  test("isPrivateIp covers loopback, private, link-local and IPv4-embedding IPv6", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::", "2001:db8::1"])
      expect(isPrivateIp(ip)).toBe(true);
    // NAT64 (64:ff9b::/96) embeds a public IPv4 on DNS64 networks: judge the embedded address
    for (const ip of ["142.250.74.106", "2a00:1450:4001:82a::200a", "::ffff:8.8.8.8", "2002:808:808::1", "64:ff9b::8efa:4a6a"]) expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("nostr login challenges (stateless)", () => {
  test("a challenge flood can't lock admins out", async () => {
    const h = await createHarness({ trustProxy: false });
    const { challenge } = await challengeOf(h);
    // many clients (distinct IPs via the adapter's env.ip) hammer the endpoint; nothing is stored per challenge
    for (let i = 0; i < 3000; i++) {
      const res = await h.api.app.request("/auth/challenge", {}, { ip: `203.0.${i >> 8}.${i & 255}` });
      expect(res.status === 200 || res.status === 429).toBe(true);
    }
    expect((await nostrLogin(h, loginEvent(h, h.owner, challenge))).status).toBe(200);
    expect((await nostrLogin(h, loginEvent(h, h.owner, (await challengeOf(h)).challenge))).status).toBe(200);
  });

  test("tampered, foreign and expired challenges are rejected; each is single use", async () => {
    const h = await createHarness();
    const { challenge } = await challengeOf(h);
    const [exp, nonce, mac] = challenge.split(".");
    const forged = [`${Number(exp) + 3600}.${nonce}.${mac}`, `${exp}.${"0".repeat(32)}.${mac}`, `${exp}.${nonce}.${"A".repeat(43)}`, "deadbeef"];
    for (const ch of forged) expect((await nostrLogin(h, loginEvent(h, h.owner, ch))).status).toBe(401);
    // a challenge from another server instance (different key) is useless here
    const other = await createHarness();
    expect((await nostrLogin(h, loginEvent(h, h.owner, (await challengeOf(other)).challenge))).status).toBe(401);
    expect((await nostrLogin(h, loginEvent(h, h.owner, challenge))).status).toBe(200);
    expect((await nostrLogin(h, loginEvent(h, h.owner, challenge))).status).toBe(401);
    const late = (await challengeOf(h)).challenge;
    h.clock.now += 6 * 60_000;
    expect((await nostrLogin(h, loginEvent(h, h.owner, late))).status).toBe(401);
  });

  test("a non-admin can't burn a challenge", async () => {
    const h = await createHarness();
    const { challenge } = await challengeOf(h);
    expect((await nostrLogin(h, loginEvent(h, newKey(), challenge))).status).toBe(403);
    expect((await nostrLogin(h, loginEvent(h, h.owner, challenge))).status).toBe(200);
  });

  test("per-request NIP-98 only accepts the publicUrl-based URL", async () => {
    const h = await createHarness();
    const lan = "http://192.168.1.5:3000";
    const auth = nip98Header(h.owner, `${lan}/admin/api/auth/me`, "GET", undefined, [], Math.floor(h.clock.now / 1000));
    expect((await h.api.app.request(new Request(`${lan}/auth/me`, { headers: { authorization: auth } }))).status).toBe(401);
  });

  test("forged passkey challenge cookies are rejected", async () => {
    const h = await createHarness();
    const res = await h.req("/auth/passkey/login/verify", {
      method: "POST",
      body: JSON.stringify({ response: { id: "x" } }),
      headers: { "content-type": "application/json", cookie: `bh_pk=${Math.floor(h.clock.now / 1000) + 300}.abc.${"A".repeat(43)}` },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_challenge");
  });
});

describe("rate-limit keys", () => {
  test("IPv6 aggregates to /64, IPv4-mapped normalises", () => {
    expect(rateKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(rateKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(rateKey("1.2.3.4")).toBe("1.2.3.4");
    expect(rateKey(null)).toBe("unknown");
  });

  test("addresses in one /64 share the challenge quota", async () => {
    const h = await createHarness();
    const hit = (ip: string) => h.api.app.request("/auth/challenge", {}, { ip });
    for (let i = 0; i < 60; i++) expect((await hit(`2001:db8:1:2::${(i + 1).toString(16)}`)).status).toBe(200);
    expect((await hit("2001:db8:1:2:dead:beef:1:1")).status).toBe(429);
    expect((await hit("2001:db8:1:3::1")).status).toBe(200);
  });
});

describe("plugin settings secrets", () => {
  test("masking walks nested objects and arrays", () => {
    const schema = {
      properties: {
        s3: { type: "object", properties: { bucket: {}, secretAccessKey: {}, key: { "x-secret": true } } },
        hooks: { type: "array", items: { properties: { url: {}, signing: { format: "password" } } } },
      },
    };
    const values = {
      s3: { bucket: "b", secretAccessKey: "AKIA-secret", key: "k1" },
      hooks: [{ url: "https://x", signing: "sig" }],
      nested: { deeper: { apiKey: "zzz", name: "n" } },
      token: "",
    };
    expect(maskSecrets(values, schema)).toEqual({
      s3: { bucket: "b", secretAccessKey: "••••••••", key: "••••••••" },
      hooks: [{ url: "https://x", signing: "••••••••" }],
      nested: { deeper: { apiKey: "••••••••", name: "n" } },
      token: "",
    });
  });

  test("settings changes never put secrets into the audit log", async () => {
    const h = await createHarness();
    const res = await h.asKey(h.owner, "/plugins/demo/settings", { method: "PATCH", body: { values: { conf: { password: "hunter2" }, label: "x" } } });
    expect(res.status).toBe(200);
    const entry = h.audit.entries.find((e) => e.action === "plugin.settings")!;
    expect(JSON.stringify(entry.details)).not.toContain("hunter2");
    expect(entry.details).toEqual({ values: { conf: { password: "••••••••" }, label: "x" } });
  });

  test("viewers get nested secrets masked", async () => {
    const h = await createHarness();
    await h.asKey(h.owner, "/plugins/demo/settings", { method: "PATCH", body: { values: { conf: { password: "hunter2" } } } });
    const viewer = await h.addAdmin("viewer");
    const body = await (await h.asKey(viewer, "/plugins/demo/settings")).text();
    expect(body).not.toContain("hunter2");
  });
});

describe("content deletion respects ranks", () => {
  const mk = (id: string, pubkey: string, created_at = 100): NostrEvent => ({ id, pubkey, created_at, kind: 1, tags: [["t", "spam"]], content: "", sig: "0".repeat(128) });
  const id = (n: number) => n.toString(16).padStart(64, "0");

  test("a moderator can't wipe a superior's events via filters, ids or DELETE", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    const user = newKey().pk;
    await h.events.save(mk(id(1), h.owner.pk));
    await h.events.save(mk(id(2), admin.pk));
    await h.events.save(mk(id(3), user));
    await h.events.save(mk(id(4), mod.pk));

    const del = (body: unknown) => h.asKey(mod, "/events/delete", { method: "POST", body });
    expect((await del({ filters: [{ since: 0 }] })).status).toBe(403);
    expect((await del({ filters: [{ "#t": ["spam"] }] })).status).toBe(403);
    expect((await del({ ids: [id(1)] })).status).toBe(403);
    expect((await del({ filters: [{ authors: [admin.pk] }] })).status).toBe(403);
    expect((await h.asKey(mod, `/events/${id(2)}`, { method: "DELETE" })).status).toBe(403);
    expect(await h.events.getById(id(1))).toBeTruthy();
    expect(await h.events.getById(id(2))).toBeTruthy();

    // own and regular users' events are fine
    const ok = await del({ filters: [{ authors: [user, mod.pk] }] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { deleted: number }).deleted).toBe(2);
    expect(await h.events.getById(id(3))).toBeUndefined();
  });

  test("admins may delete moderators' events; owners anything", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    await h.events.save(mk(id(1), mod.pk));
    await h.events.save(mk(id(2), admin.pk));
    expect((await h.asKey(admin, "/events/delete", { method: "POST", body: { ids: [id(1)] } })).status).toBe(200);
    expect((await h.asKey(h.owner, "/events/delete", { method: "POST", body: { filters: [{ since: 0 }] } })).status).toBe(200);
    expect(await h.events.getById(id(2))).toBeUndefined();
  });

  test("resolving a report can't delete a superior's event", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    await h.events.save(mk(id(9), h.owner.pk));
    const report = signEvent(newKey(), 1984, [["e", id(9), "spam"], ["p", h.owner.pk]]);
    await h.relay.publish(report, "api");
    const res = await h.asKey(mod, `/reports/${report.id}/resolve`, { method: "POST", body: { action: "delete-event" } });
    expect(res.status).toBe(403);
    expect(await h.events.getById(id(9))).toBeTruthy();
  });
});
