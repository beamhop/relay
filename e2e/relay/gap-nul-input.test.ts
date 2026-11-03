/**
 * U+0000 in admin input. Postgres can't store or compare it in a text value, so before it was refused up front a
 * NUL in a path parameter, query value, JSON body or NIP-86 param reached the database there and failed with a 500
 * (including the unauthenticated passkey login routes), while SQLite accepted it. Every backend now answers 400 (NIP-86:
 * an error result) without touching the database. Run with BEAMHOP_E2E_DB=postgres to cover the original failure.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newUser } from "../harness/client";
import { startRelay, type Relay } from "../harness/relay";
import { api, nip86 } from "./policy-helpers";

const N = "a\u0000b";
let relay: Relay;
beforeAll(async () => {
  relay = await startRelay();
});
afterAll(() => relay?.stop());

describe("NUL in admin input", () => {
  test("admin API: path, query and body values with U+0000 are a 400, not a database error", async () => {
    const u = newUser().pubkey;
    const q = encodeURIComponent(N);
    const calls: [Uint8Array | null, string, string, unknown?][] = [
      [relay.owner.sk, "DELETE", `/auth/passkey/${q}`, { currentPassword: "x" }],
      [relay.owner.sk, "PATCH", `/users/${u}`, { notes: N }],
      [relay.owner.sk, "POST", `/users/${u}/ban`, { reason: N }],
      [relay.owner.sk, "POST", "/invites", { note: N }],
      [relay.owner.sk, "POST", "/ip-rules", { cidr: "10.9.9.9/32", action: "block", reason: N }],
      [relay.owner.sk, "PATCH", "/settings", { info: { name: N } }],
      [relay.owner.sk, "PATCH", "/settings", { [N]: 1 }],
      [relay.owner.sk, "GET", `/audit?actor=${q}`],
      [relay.owner.sk, "GET", `/audit?action=${q}`],
      [relay.owner.sk, "GET", `/users?q=${q}`],
      [null, "POST", "/auth/passkey/login/options", { login: N }],
      [null, "POST", "/auth/passkey/login/options", { login: `${N}@example.com` }],
      [null, "POST", "/auth/passkey/login/verify", { response: { id: N } }],
    ];
    const got = await Promise.all(calls.map(async ([sk, m, p, b]) => `${m} ${p} → ${(await api(relay, sk, m, p, b)).status}`));
    expect(got).toEqual(calls.map(([, m, p]) => `${m} ${p} → 400`));
  });

  test("NIP-86: a param with U+0000 is answered with an error result", async () => {
    const pk = newUser().pubkey;
    for (const [method, params] of [
      ["banpubkey", [pk, N]],
      ["allowpubkey", [pk, N]],
      ["banevent", ["0".repeat(64), N]],
      ["changerelayname", [N]],
      ["blockip", ["10.1.1.1", N]],
    ] as [string, unknown[]][]) {
      const r = await nip86(relay, method, params);
      expect([method, r.status, r.error]).toEqual([method, 200, "invalid params: input must not contain U+0000"]);
    }
    // and nothing was stored
    expect((await nip86(relay, "listbannedpubkeys")).result).toEqual([]);
  });
});
