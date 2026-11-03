/**
 * IP block rules cover the public HTTP surfaces, not only websockets: a blocked address can't upload or mirror blobs,
 * redeem invites or use plugin routes. The admin panel and API stay reachable so a rule can always be lifted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { api, bauth, pdfBytes, user } from "./admin-helpers";
import { sha256 } from "../harness/client";

let relay: Relay;
const BLOCKED = "203.0.113.77";
const OTHER = "203.0.113.78";
beforeAll(async () => {
  relay = await startRelay({ overrides: { server: { trustProxy: true } } });
  expect((await api(relay.http, relay.owner.sk, "PATCH", "/settings", { blossom: { uploadAccess: "anyone" } })).status).toBe(200);
  expect((await api(relay.http, relay.owner.sk, "POST", "/ip-rules", { cidr: `${BLOCKED}/32`, action: "block", reason: "abuse" })).status).toBeLessThan(300);
});
afterAll(() => relay?.stop());

const from = (ip: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "X-Forwarded-For": ip } });

describe("blocked addresses over HTTP", () => {
  test("Blossom upload, mirror, delete and reads, invite redemption, plugin routes and NIP-11 are refused", async () => {
    const u = user();
    const body = pdfBytes();
    const auth = bauth(u.sk, "upload", { hashes: [sha256(body)] });
    const tries: [string, RequestInit][] = [
      ["/upload", { method: "PUT", body, headers: { Authorization: auth } }],
      ["/mirror", { method: "PUT", body: JSON.stringify({ url: "https://example.org/x" }), headers: { Authorization: auth, "Content-Type": "application/json" } }],
      [`/${"a".repeat(64)}`, { method: "DELETE" }],
      [`/${"a".repeat(64)}`, {}],
      ["/invite/redeem", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }],
      ["/invite/abc", {}],
      ["/plugins/hello/ping", {}],
      ["/", { headers: { Accept: "application/nostr+json" } }],
    ];
    for (const [path, init] of tries) {
      const res = await fetch(`${relay.http}${path}`, from(BLOCKED, init));
      expect([path, init.method ?? "GET", res.status]).toEqual([path, init.method ?? "GET", 403]);
    }
    // nothing was stored
    const ok = await fetch(`${relay.http}/upload`, from(OTHER, { method: "PUT", body, headers: { Authorization: bauth(u.sk, "upload", { hashes: [sha256(body)] }) } }));
    expect(ok.status).toBe(201);
  });

  test("the admin API, NIP-86 and health stay reachable, so the block can be lifted from that address", async () => {
    expect((await fetch(`${relay.http}/health/live`, from(BLOCKED))).status).toBe(200);
    expect((await fetch(`${relay.http}/admin/`, from(BLOCKED))).status).toBe(200);
    const nip86 = await fetch(`${relay.http}/`, from(BLOCKED, { method: "POST", body: "{}", headers: { "Content-Type": "application/nostr+json+rpc" } }));
    expect(nip86.status).toBe(401);
    const rules = await api(relay.http, relay.owner.sk, "GET", "/ip-rules", undefined, { headers: { "X-Forwarded-For": BLOCKED } });
    expect(rules.status).toBe(200);
    expect((await api(relay.http, relay.owner.sk, "DELETE", `/ip-rules/${encodeURIComponent(`${BLOCKED}/32`)}`, undefined, { headers: { "X-Forwarded-For": BLOCKED } })).status).toBeLessThan(300);
    const nip11 = await fetch(`${relay.http}/`, from(BLOCKED, { headers: { Accept: "application/nostr+json" } }));
    expect(nip11.status).toBe(200);
  });
});
