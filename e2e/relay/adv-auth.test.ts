/**
 * Adversarial authentication: NIP-98 headers carried to other URLs, methods, hosts and API surfaces; Host /
 * X-Forwarded-* spoofing with and without trustProxy; header vs cookie precedence; admin API path aliasing; CORS and
 * cross-site (CSRF) "simple requests" against the cookie session.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { finalizeEvent } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { now } from "../harness/client";
import { nip98, user } from "./admin-helpers";
import { nip98 as nip98x } from "./policy-helpers";
import { rawHttp } from "./adv-helpers";

let relay: Relay;
let proxied: Relay;
beforeAll(async () => {
  [relay, proxied] = await Promise.all([startRelay(), startRelay({ overrides: { server: { trustProxy: true } } })]);
});
afterAll(async () => {
  await Promise.all([relay?.stop(), proxied?.stop()]);
});

const A = (r: Relay, p: string) => `${r.http}/admin/api${p}`;
const EVIL = "https://evil.example";

async function login(r: Relay, sk: Uint8Array): Promise<string> {
  const ch = (await (await fetch(A(r, "/auth/challenge"))).json()) as { challenge: string; url: string };
  const ev = finalizeEvent({ kind: 27235, created_at: now(), content: "", tags: [["u", ch.url], ["method", "POST"], ["challenge", ch.challenge]] }, sk);
  const res = await fetch(A(r, "/auth/nostr"), { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "beamhop" }, body: JSON.stringify({ event: ev }) });
  expect(res.status).toBe(200);
  return `bh_session=${/bh_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}`;
}

/** Raw GET so the Host header (and anything else) is exactly what the attacker sends. */
const rawGet = (r: Relay, path: string, headers: Record<string, string>) =>
  rawHttp(r.port, `GET ${path} HTTP/1.1\r\n${Object.entries({ Host: `127.0.0.1:${r.port}`, ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join("")}Connection: close\r\n\r\n`);

describe("NIP-98 bound to the configured publicUrl, not to what the request claims", () => {
  for (const which of ["direct", "trustProxy"] as const) {
    test(`${which}: a header signed for another host is refused whatever Host / X-Forwarded-* say`, async () => {
      const r = which === "direct" ? relay : proxied;
      const evilU = "http://evil.example/admin/api/auth/me";
      const variants: Record<string, string>[] = [
        { Host: "evil.example" },
        { "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" },
        { Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-For": "203.0.113.9", Forwarded: "host=evil.example;proto=http" },
      ];
      for (const h of variants) {
        const res = await rawGet(r, "/admin/api/auth/me", { ...h, Authorization: nip98(r.owner.sk, evilU, "GET") });
        expect(res.status).toBe(401);
        expect(res.body).toContain("url mismatch");
      }
      // the legitimate URL keeps working under a spoofed Host (the u tag is compared to publicUrl only)
      const ok = await rawGet(r, "/admin/api/auth/me", { Host: "evil.example", "X-Forwarded-Host": "evil.example", Authorization: nip98(r.owner.sk, A(r, "/auth/me"), "GET") });
      expect(ok.status).toBe(200);
    });
  }

  test("a header is valid for exactly one URL: no query, path, scheme, port or prefix variants", async () => {
    const sk = relay.owner.sk;
    const port = relay.port;
    const signedFor = [
      A(relay, "/users"), // other path
      A(relay, "/auth/me?x=1"), // query added
      `https://127.0.0.1:${port}/admin/api/auth/me`, // other scheme
      `http://127.0.0.1:${port + 1}/admin/api/auth/me`, // other port
      `http://localhost:${port}/admin/api/auth/me`, // other spelling of the host
      `${relay.http}/auth/me`, // without the /admin/api prefix
      `${relay.http}/admin/api/auth/me/..`, // dot segments
      "/admin/api/auth/me", // relative
    ];
    for (const u of signedFor) {
      const res = await fetch(A(relay, "/auth/me"), { headers: { Authorization: nip98(sk, u, "GET") } });
      expect(res.status).toBe(401);
    }
    // and the URL it names must be the one requested
    const res = await fetch(A(relay, "/auth/me?x=1"), { headers: { Authorization: nip98(sk, A(relay, "/auth/me"), "GET") } });
    expect(res.status).toBe(401);
  });

  test("admin-API and NIP-86 headers don't cross over; method tags are exact", async () => {
    const sk = relay.owner.sk;
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    // an admin API header (u = /admin/api/…) presented to NIP-86 on "/"
    const toRpc = await fetch(`${relay.http}/`, { method: "POST", headers: { "Content-Type": "application/nostr+json+rpc", Authorization: nip98(sk, A(relay, "/settings"), "POST", body) }, body });
    expect(toRpc.status).toBe(401);
    // a NIP-86 header (u = relay root) presented to the admin API
    const toApi = await fetch(A(relay, "/auth/me"), { headers: { Authorization: nip98(sk, relay.http, "GET") } });
    expect(toApi.status).toBe(401);
    const toApiPost = await fetch(A(relay, "/events/query"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: nip98(sk, `${relay.http}/`, "POST", "{}") }, body: "{}" });
    expect(toApiPost.status).toBe(401);
    // a NIP-98 event of the wrong kind (a NIP-42 or Blossom one) is refused
    const k = finalizeEvent({ kind: 22242, created_at: now(), content: "", tags: [["u", A(relay, "/auth/me")], ["method", "GET"]] }, sk);
    const wrongKind = await fetch(A(relay, "/auth/me"), { headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(k)).toString("base64")}` } });
    expect(wrongKind.status).toBe(401);
    // a GET header can't authorise a DELETE of the same URL, and vice versa
    const del = await fetch(A(relay, "/invites/abc"), { method: "DELETE", headers: { Authorization: nip98(sk, A(relay, "/invites/abc"), "GET") } });
    expect(del.status).toBe(401);
    const get = await fetch(A(relay, "/invites"), { headers: { Authorization: nip98(sk, A(relay, "/invites"), "DELETE") } });
    expect(get.status).toBe(401);
  });

  test("an admin-API header is single use even when replayed against a different instance of the same URL spelling", async () => {
    const url = A(relay, "/auth/me");
    const h = nip98(relay.owner.sk, url, "GET");
    expect((await fetch(url, { headers: { Authorization: h } })).status).toBe(200);
    // the same event with a trailing slash in the request path, or via a spoofed Host, is still the same event id
    expect((await fetch(`${url}/`, { headers: { Authorization: h } })).status).toBe(401);
    expect((await rawGet(relay, "/admin/api/auth/me", { Host: "evil.example", Authorization: h })).status).toBe(401);
  });

  test("oversized, malformed or non-Nostr Authorization headers never authenticate", async () => {
    const url = A(relay, "/auth/me");
    const huge = `Nostr ${"A".repeat(20_000)}`;
    const ev = JSON.parse(Buffer.from(nip98(relay.owner.sk, url, "GET").slice(6), "base64").toString());
    const cases = [
      huge,
      "Nostr",
      "Nostr  ",
      `Nostr ${Buffer.from("null").toString("base64")}`,
      `Nostr ${Buffer.from(JSON.stringify([ev])).toString("base64")}`,
      `Nostr ${Buffer.from(JSON.stringify({ ...ev, sig: "0".repeat(128) })).toString("base64")}`,
      `Nostr ${Buffer.from(JSON.stringify({ ...ev, pubkey: user().pubkey })).toString("base64")}`,
      `Nostr ${Buffer.from(JSON.stringify({ ...ev, tags: [...ev.tags, ["u", A(relay, "/users")]] })).toString("base64")}`,
      `Basic ${Buffer.from("owner:owner").toString("base64")}`,
      `Bearer ${relay.owner.skHex}`,
    ];
    for (const a of cases) {
      const r = await fetch(url, { headers: { Authorization: a } });
      // 431 (header too large) is fine for the 20 KB one
      expect(a === huge ? [401, 431] : [401]).toContain(r.status);
    }
  });
});

describe("header vs cookie precedence", () => {
  test("a bad or non-admin NIP-98 header never falls back to a valid session cookie", async () => {
    const cookie = await login(relay, relay.owner.sk);
    const url = A(relay, "/auth/me");
    expect((await fetch(url, { headers: { Cookie: cookie } })).status).toBe(200);
    const bad = await fetch(url, { headers: { Cookie: cookie, Authorization: nip98(relay.owner.sk, A(relay, "/users"), "GET") } });
    expect(bad.status).toBe(401);
    const stranger = await fetch(url, { headers: { Cookie: cookie, Authorization: nip98(user().sk, url, "GET") } });
    expect(stranger.status).toBe(403);
    // a non-Nostr scheme is ignored: the cookie authenticates, so cookie rules (CSRF) apply to mutations
    const bearer = await fetch(url, { headers: { Cookie: cookie, Authorization: "Bearer x" } });
    expect(bearer.status).toBe(200);
    const patch = await fetch(A(relay, "/settings"), { method: "PATCH", headers: { Cookie: cookie, Authorization: "Bearer x", "Content-Type": "application/json" }, body: JSON.stringify({ info: { contact: "pwned" } }) });
    expect(patch.status).toBe(403);
  });

  test("the cookie is never a credential for NIP-86 or for Blossom", async () => {
    const cookie = await login(relay, relay.owner.sk);
    const body = JSON.stringify({ method: "banpubkey", params: [user().pubkey, "csrf"] });
    const rpc = await fetch(`${relay.http}/`, { method: "POST", headers: { Cookie: cookie, Origin: EVIL, "Content-Type": "application/nostr+json+rpc" }, body });
    expect(rpc.status).toBe(401);
    const up = await fetch(`${relay.http}/upload`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "image/png" }, body: new Uint8Array([1, 2, 3]) });
    expect(up.status).toBe(401);
  });
});

describe("the admin API exists only under /admin/api", () => {
  test("owner-signed requests to aliases of /admin/api/settings never return settings", async () => {
    const aliases = ["/settings", "/api/settings", "/admin/settings", "/admin/api//settings", "/admin/API/settings", "/ADMIN/api/settings", "/admin%2fapi/settings", "/admin/api%2fsettings"];
    for (const p of aliases) {
      const u = `${relay.http}${p}`;
      const res = await rawGet(relay, p, { Authorization: nip98x(relay.owner.sk, u, "GET"), Accept: "application/json" });
      // either refused, not found, or the SPA shell — never the settings document
      expect(res.body).not.toContain('"limits"');
      expect(res.body).not.toContain("maxMessageBytes");
    }
    // dot segments are resolved to /admin/api/settings itself, which stays authenticated
    for (const p of ["/plugins/x/../../admin/api/settings", "/admin/./api/settings", "/x/%2e%2e/admin/api/settings"]) {
      const res = await rawGet(relay, p, { Accept: "application/json" });
      expect(res.body).not.toContain('"limits"');
      if (res.status !== 404) expect(res.status).toBe(401);
    }
  });
});

describe("CORS: no credentialed cross-origin access", () => {
  test("the admin API answers no preflight and never grants an origin", async () => {
    const cookie = await login(relay, relay.owner.sk);
    const pre = await fetch(A(relay, "/settings"), {
      method: "OPTIONS",
      headers: { Origin: EVIL, "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "x-requested-with,content-type" },
    });
    expect(pre.status).toBeGreaterThanOrEqual(400);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    for (const p of ["/auth/me", "/settings", "/auth/challenge", "/nope"]) {
      const r = await fetch(A(relay, p), { headers: { Origin: EVIL, Cookie: cookie } });
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  test("public surfaces use a wildcard origin, never reflect the caller's, never allow credentials", async () => {
    const reqs: [string, RequestInit][] = [
      ["/", { headers: { Accept: "application/nostr+json", Origin: EVIL } }],
      ["/", { method: "OPTIONS", headers: { Origin: EVIL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" } }],
      ["/", { method: "POST", headers: { Origin: EVIL, "Content-Type": "application/nostr+json+rpc" }, body: "{}" }],
      ["/.well-known/nostr.json?name=_", { headers: { Origin: EVIL } }],
      ["/upload", { method: "OPTIONS", headers: { Origin: EVIL, "Access-Control-Request-Method": "PUT" } }],
      [`/${"a".repeat(64)}`, { headers: { Origin: EVIL } }],
      ["/invite/redeem", { method: "POST", headers: { Origin: EVIL, "Content-Type": "application/json" }, body: "{}" }],
    ];
    for (const [p, init] of reqs) {
      const r = await fetch(`${relay.http}${p}`, init);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });
});

describe("CSRF via cross-site simple requests (cookie attached by the browser)", () => {
  const simple: [string, Record<string, string>, string][] = [
    ["text/plain", { "Content-Type": "text/plain" }, '{"info":{"contact":"csrf"}}'],
    ["form-urlencoded", { "Content-Type": "application/x-www-form-urlencoded" }, "info=1"],
    ["multipart", { "Content-Type": "multipart/form-data; boundary=x" }, '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n'],
    ["no type", {}, ""],
  ];
  for (const origin of [EVIL, "null", undefined]) {
    test(`Origin ${origin ?? "(absent)"}: every mutating method and body type is refused and changes nothing`, async () => {
      const cookie = await login(relay, relay.owner.sk);
      for (const [, h, body] of simple) {
        for (const [method, path] of [["POST", "/users"], ["PATCH", "/settings"], ["POST", "/auth/logout"], ["DELETE", `/users/${user().pubkey}`], ["POST", "/ip-rules"], ["PUT", `/users/${user().pubkey}/role`]] as const) {
          const res = await fetch(A(relay, path), { method, headers: { Cookie: cookie, ...h, ...(origin ? { Origin: origin } : {}) }, body: body || undefined });
          expect(res.status).toBe(403);
          expect((await res.json()).code).toBe("csrf");
        }
      }
      // the session survived the cross-site logout attempts and nothing was changed
      const me = await fetch(A(relay, "/auth/me"), { headers: { Cookie: cookie } });
      expect(me.status).toBe(200);
      const s = await fetch(A(relay, "/settings"), { headers: { Cookie: cookie } }).then((r) => r.json());
      expect(s.settings.info.contact).not.toBe("csrf");
    });
  }

  test("a same-origin request still needs a JSON body type (forms are refused with 415)", async () => {
    const cookie = await login(relay, relay.owner.sk);
    const res = await fetch(A(relay, "/auth/logout"), { method: "POST", headers: { Cookie: cookie, Origin: new URL(relay.http).origin, "Content-Type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
    expect((await fetch(A(relay, "/auth/me"), { headers: { Cookie: cookie } })).status).toBe(200);
  });
});

describe("X-Forwarded-For spoofing against per-IP limits", () => {
  test("without trustProxy, rotating X-Forwarded-For doesn't escape the login-challenge rate limit", async () => {
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await fetch(A(relay, "/auth/challenge"), { headers: { "X-Forwarded-For": `198.51.100.${i}`, "X-Real-IP": `198.51.100.${i}` } });
      if (r.status === 429) limited++;
      await r.text();
    }
    expect(limited).toBeGreaterThan(0);
  });

  test("with trustProxy, the rightmost hop is the key: a client-supplied left part doesn't buy a fresh bucket", async () => {
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await fetch(A(proxied, "/auth/challenge"), { headers: { "X-Forwarded-For": `198.51.100.${i}, 192.0.2.77` } });
      if (r.status === 429) limited++;
      await r.text();
    }
    expect(limited).toBeGreaterThan(0);
    // a different real client (rightmost hop) is unaffected
    expect((await fetch(A(proxied, "/auth/challenge"), { headers: { "X-Forwarded-For": "192.0.2.78" } })).status).toBe(200);
  });
});
