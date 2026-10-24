/**
 * Information leaks: public documents (NIP-11, landing page, NIP-05, /health, invite page) must not carry secrets or
 * filesystem paths; error bodies on every surface stay free of stack traces and paths even under hostile input (an
 * owner-signed fuzz of every admin route, NIP-86 with prototype method names); /metrics is gated by token or loopback.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser } from "../harness/client";
import { api, bauth } from "./admin-helpers";
import { nip86 } from "./policy-helpers";
import { looksLikeLeak, rawHttp } from "./adv-helpers";

const TOKEN = `metrics-${crypto.randomUUID()}`;
let relay: Relay;
let tokened: Relay;
let proxied: Relay;
let proxiedTokened: Relay;
beforeAll(async () => {
  [relay, tokened, proxied, proxiedTokened] = await Promise.all([
    startRelay(),
    startRelay({ extras: { metricsToken: TOKEN } }),
    startRelay({ overrides: { server: { trustProxy: true } } }),
    startRelay({ overrides: { server: { trustProxy: true } }, extras: { metricsToken: TOKEN } }),
  ]);
});
afterAll(async () => {
  await Promise.all([relay, tokened, proxied, proxiedTokened].map((r) => r?.stop()));
});

/** Every secret or local detail of `r` that must never appear in a response. */
const secretsOf = (r: Relay) => {
  const cfg = r.beamhop.config as unknown as { relaySecretKey: string; database: { sqlitePath?: string }; blossom: { fsPath?: string } };
  return [cfg.relaySecretKey, r.owner.skHex, r.owner.nsec, r.dir, cfg.database.sqlitePath ?? "", cfg.blossom.fsPath ?? "", TOKEN, "e2e.db"];
};
const noLeak = (r: Relay, body: string, what: string) => {
  const leak = looksLikeLeak(body, secretsOf(r));
  if (leak) throw new Error(`${what}: ${leak}\n${body.slice(0, 500)}`);
};

describe("public documents carry no secrets", () => {
  test("NIP-11, landing page, HEAD /, NIP-05, /health, invite page and the admin SPA shell", async () => {
    for (const r of [relay, tokened]) {
      const docs: [string, RequestInit][] = [
        ["/", { headers: { Accept: "application/nostr+json" } }],
        ["/", {}],
        ["/.well-known/nostr.json", {}],
        ["/.well-known/nostr.json?name=_", {}],
        ["/health", {}],
        ["/invite/abc", {}],
        ["/admin/", {}],
        ["/admin/api/auth/challenge", {}],
        ["/admin/api/push/vapid", {}],
      ];
      for (const [p, init] of docs) {
        const res = await fetch(`${r.http}${p}`, init);
        const text = await res.text();
        noLeak(r, text, p);
        for (const [k, v] of res.headers) noLeak(r, `${k}: ${v}`, `${p} header ${k}`);
      }
      // NIP-11 names the relay's *public* key only
      const info = await (await fetch(r.http, { headers: { Accept: "application/nostr+json" } })).json();
      expect(info.self).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(info)).not.toMatch(/secret|password|token|sqlite|fsPath|dsn/i);
    }
  });

  test("the settings API (owner-only) doesn't expose server secrets either", async () => {
    const r = await api(relay.http, relay.owner.sk, "GET", "/settings");
    expect(r.status).toBe(200);
    noLeak(relay, JSON.stringify(r.body), "GET /settings");
    const sys = await api(relay.http, relay.owner.sk, "GET", "/system");
    expect(sys.status).toBe(200);
    const s = JSON.stringify(sys.body);
    for (const secret of [relay.beamhop.config.relaySecretKey as string, relay.owner.skHex, relay.owner.nsec, TOKEN]) expect(s).not.toContain(secret);
  });
});

describe("error bodies don't leak stacks or paths", () => {
  test("malformed requests on every public surface", async () => {
    const u = newUser();
    const reqs: [string, RequestInit][] = [
      ["/", { method: "POST", headers: { "Content-Type": "application/nostr+json+rpc" }, body: "{" }],
      ["/", { method: "POST", headers: { "Content-Type": "application/nostr+json+rpc", Authorization: "Nostr !!!" }, body: "{}" }],
      ["/invite/redeem", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Nostr e30=" }, body: "{" }],
      ["/upload", { method: "PUT", headers: { Authorization: "Nostr bm90IGpzb24=" }, body: "x" }],
      ["/upload", { method: "PUT", headers: { Authorization: bauth(u.sk, "upload", { hashes: ["0".repeat(64)] }), "X-SHA-256": "zz" }, body: "x" }],
      ["/upload", { method: "HEAD", headers: { "X-SHA-256": "0".repeat(64), "X-Content-Length": "-1" } }],
      ["/mirror", { method: "PUT", headers: { Authorization: bauth(u.sk, "upload", { hashes: ["0".repeat(64)] }) }, body: '{"url":{"toString":1}}' }],
      [`/${"0".repeat(64)}`, { method: "DELETE", headers: { Authorization: `Nostr ${"A".repeat(4000)}` } }],
      [`/list/${"0".repeat(64)}?limit=abc&since=-5`, {}],
      ["/admin/api/auth/nostr", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "beamhop" }, body: '{"event":{"__proto__":{"kind":27235}}}' }],
      ["/admin/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "beamhop" }, body: '{"login":{"$gt":""},"password":["x"]}' }],
      ["/admin/api/auth/passkey/login/verify", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "beamhop" }, body: '{"response":"x".repeat(9)}' }],
      ["/admin/api/stream?kinds=x", {}],
      ["/plugins/%00/x", {}],
      ["/plugins/__proto__", {}],
      ["/admin/plugins-ui/..%2f..%2fpackage.json", {}],
    ];
    for (const [p, init] of reqs) {
      const res = await fetch(`${relay.http}${p}`, init);
      expect(res.status).toBeLessThan(500);
      noLeak(relay, await res.text(), `${init.method ?? "GET"} ${p}`);
      noLeak(relay, res.headers.get("x-reason") ?? "", `${p} x-reason`);
    }
  });

  test("websocket refusals are plain NIP-01 reasons", async () => {
    const c = await RelayClient.connect(relay.ws);
    const frames = ['["EVENT",{"id":"x"}]', '["REQ","a",{"ids":["../../etc"]}]', '["COUNT","c",{"search":' + JSON.stringify("x".repeat(300)) + "}]", '["NEG-OPEN","n",{},"zz"]', '["AUTH",{}]', "\u0000", '["' + "A".repeat(100) + '"]'];
    for (const f of frames) c.ws.send(f);
    await Bun.sleep(300);
    expect(c.inbox.length).toBeGreaterThanOrEqual(frames.length);
    for (const m of c.inbox) noLeak(relay, JSON.stringify(m), "ws");
    c.close();
  });

  test("an owner-signed fuzz of every admin route and path parameter never yields a 5xx or a stack", async () => {
    const routes =
      "delete /auth/passkey/:id;delete /connections/:id;delete /events/:id;delete /groups/:id;delete /invites/:code;delete /ip-rules/:cidr;delete /media/:sha256;delete /media/blocklist/:sha256;get /admins;get /audit;get /connections;get /dashboard/snapshot;get /events/:id;get /events/export;get /groups;get /groups/:id;get /invites;get /ip-rules;get /media;get /media/:sha256;get /media/:sha256/raw;get /media/blocklist;get /media/stats;get /metrics/geo;get /metrics/kinds;get /metrics/rejections;get /metrics/series;get /metrics/top-pubkeys;get /plugins;get /plugins/:name/settings;get /push/vapid;get /reports;get /reports/:id;get /settings;get /system;get /users;get /users/:pubkey;get /users/:pubkey/events;patch /plugins/:name/settings;patch /settings;patch /users/:pubkey;post /connections/disconnect;post /events/delete;post /events/query;post /invites;post /ip-rules;post /media/:sha256/status;post /media/bulk;post /plugins/:name/disable;post /plugins/:name/enable;post /push/subscribe;post /push/unsubscribe;post /reports/:id/resolve;post /reports/bulk-resolve;post /users;post /users/:pubkey/ban;post /users/bulk;put /users/:pubkey/role"
        .split(";")
        .map((x) => x.split(" ") as [string, string]);
    const params = ["__proto__", "constructor", "%00", "..%2f..%2fetc", "x".repeat(3000), "%E2%80%AE", "-1", "1e999", "'%20OR%201=1--"];
    const query = "?limit=-1&cursor=%00&q=%27%22&since=1e999&until=NaN&pubkey=__proto__&kind=abc&kinds=1,x&sort=constructor&page=99999999999999999999&before=-5&status=%00&type=*/*&search=%25%25%25&range=999999999&days=-1";
    const bodies = [
      '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}',
      "[]",
      '"str"',
      "123",
      "null",
      JSON.stringify({ limit: -1, filters: "x", filter: { __proto__: [1] }, pubkey: "x".repeat(5000), pubkeys: [{}], ids: [[]], action: "constructor", status: "__proto__", role: "toString", ip: "999.1.1.1/99", cidr: "::/0", code: {}, events: [{}], items: 7 }),
    ];
    const failures: string[] = [];
    const check = (what: string, status: number, body: unknown) => {
      const s = typeof body === "string" ? body : (JSON.stringify(body) ?? "");
      const leak = looksLikeLeak(s, secretsOf(relay));
      if (status >= 500 || leak) failures.push(`${what} → ${status} ${leak ?? ""} ${s.slice(0, 160)}`);
    };
    // [method, path, raw body]; run 16 at a time (a 500-connection burst only measures the OS accept backlog)
    const jobs: [string, string, string | undefined][] = [];
    for (const [m, path] of routes) {
      for (const p of params) jobs.push([m.toUpperCase(), path.replace(/:[a-z0-9]+/gi, p) + (m === "get" ? query : ""), undefined]);
      if (m !== "get" && m !== "delete") for (const raw of bodies) jobs.push([m.toUpperCase(), path.replace(/:[a-z0-9]+/gi, "a".repeat(64)), raw]);
    }
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [m, p, raw] = jobs[next++];
        const r = await api(relay.http, relay.owner.sk, m, p, undefined, raw === undefined ? {} : { raw });
        check(`${m} ${p.slice(0, 60)} ${raw?.slice(0, 40) ?? ""}`, r.status, r.body);
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    expect(failures).toEqual([]);
    // nothing got polluted, and a stranger is still a stranger
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await api(relay.http, newUser().sk, "GET", "/settings")).status).toBe(403);
    expect((await api(relay.http, null, "GET", "/settings")).status).toBe(401);
  });

  test("NIP-86: prototype method names and hostile params are plain errors", async () => {
    for (const method of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const r = await nip86(relay, method, []);
      expect(r.status).toBe(200);
      expect(r.error).toBe(`unsupported method: ${method}`);
    }
    const hostile: [string, unknown[]][] = [
      ["banpubkey", [{}]],
      ["banpubkey", ["x".repeat(10_000)]],
      ["blockip", ["999.0.0.1"]],
      ["blockip", [{ __proto__: 1 }]],
      ["allowkind", ["1"]],
      ["allowkind", [1e300]],
      ["banevent", ["zz", { a: 1 }]],
      ["changerelayicon", ["javascript:alert(1)"]],
    ];
    for (const [method, params] of hostile) {
      const r = await nip86(relay, method, params);
      expect(r.status).toBeLessThan(500);
      expect(r.result).toBeNull();
      noLeak(relay, String(r.error), `nip86 ${method}`);
    }
    for (const rawBody of ['{"method":"supportedmethods","params":{"length":1}}', '{"method":["banpubkey"]}', "[]", '{"__proto__":{"method":"banpubkey"}}']) {
      const r = await nip86(relay, "", [], { rawBody });
      expect(r.status).toBe(400);
    }
  });
});

describe("/metrics gating", () => {
  const metrics = (r: Relay, headers: Record<string, string> = {}) => fetch(`${r.http}/metrics`, { headers });

  test("with a token: missing, wrong, truncated, padded or differently cased tokens are 401; the exact one is 200", async () => {
    for (const h of [{}, { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: `bearer ${TOKEN}` }, { Authorization: TOKEN }, { Authorization: `Bearer  ${TOKEN}` }, { Authorization: `Basic ${btoa(`x:${TOKEN}`)}` }] as Record<string, string>[]) {
      const r = await metrics(tokened, h);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain("Bearer");
      expect(await r.text()).not.toContain(TOKEN);
    }
    const ok = await metrics(tokened, { Authorization: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("# HELP");
    // a query-string token is not accepted (it would end up in access logs)
    expect((await fetch(`${tokened.http}/metrics?token=${TOKEN}`)).status).toBe(401);
  });

  test("behind trustProxy without a token, even loopback is refused; with a token only the token counts", async () => {
    expect((await metrics(proxied)).status).toBe(403);
    expect((await metrics(proxied, { "X-Forwarded-For": "127.0.0.1" })).status).toBe(403);
    expect((await metrics(proxiedTokened, { "X-Forwarded-For": "127.0.0.1" })).status).toBe(401);
    expect((await metrics(proxiedTokened, { Authorization: `Bearer ${TOKEN}`, "X-Forwarded-For": "203.0.113.1" })).status).toBe(200);
  });

  test("without a token, any forwarding header on a loopback request is refused (spoofed or real proxy)", async () => {
    for (const h of [{ "X-Forwarded-For": "127.0.0.1" }, { "X-Real-IP": "127.0.0.1" }, { Forwarded: "for=127.0.0.1" }] as Record<string, string>[]) {
      expect((await metrics(relay, h)).status).toBe(403);
    }
    // and HEAD / other methods aren't a way around it
    const raw = await rawHttp(relay.port, `POST /metrics HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 1.2.3.4\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    expect(raw.body).not.toContain("# HELP");
  });
});
