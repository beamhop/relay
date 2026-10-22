import { describe, expect, test } from "bun:test";
import { AuthError, isMimeAllowed, parseAuthHeader, verifyAuthEvent } from "../src";
import { authHeader, newUser } from "./fakes";

const domains = ["cdn.example.com"];
const x = "ab".repeat(32);
const verify = (h: string, o: Partial<Parameters<typeof verifyAuthEvent>[1]> = {}) =>
  verifyAuthEvent(parseAuthHeader(h)!, { verb: "upload", domains, ...o });

describe("auth", () => {
  const u = newUser();
  const now = Math.floor(Date.now() / 1000);

  test("accepts a valid token (base64url and standard base64)", () => {
    const h = authHeader(u.sk, "upload", { x: [x], server: ["cdn.example.com"] });
    expect(verify(h, { sha256: x }).pubkey).toBe(u.pubkey);
    const std = `Nostr ${Buffer.from(Buffer.from(h.slice(6), "base64url").toString()).toString("base64")}`;
    expect(verify(std).hashes).toEqual([x]);
  });

  test("no / non-nostr header → undefined", () => {
    expect(parseAuthHeader(undefined)).toBeUndefined();
    expect(parseAuthHeader("Bearer abc")).toBeUndefined();
  });

  const cases: [string, () => void][] = [
    ["garbage", () => verify("Nostr !!!notbase64")],
    ["wrong kind", () => verify(authHeader(u.sk, "upload", { kind: 1 }))],
    ["future created_at", () => verify(authHeader(u.sk, "upload", { createdAt: now + 3600 }))],
    ["expired", () => verify(authHeader(u.sk, "upload", { expiration: now - 1 }))],
    ["wrong verb", () => verify(authHeader(u.sk, "delete"))],
    ["other server", () => verify(authHeader(u.sk, "upload", { server: ["other.example.com"] }))],
    ["x mismatch", () => verify(authHeader(u.sk, "upload", { x: ["cd".repeat(32)] }), { sha256: x })],
    ["missing required x", () => verify(authHeader(u.sk, "delete"), { verb: "delete", sha256: x, requireX: true })],
    [
      "bad signature",
      () => {
        const ev = parseAuthHeader(authHeader(u.sk, "upload"))!;
        ev.content = "tampered";
        verifyAuthEvent(ev, { verb: "upload", domains });
      },
    ],
  ];
  for (const [name, fn] of cases) test(`rejects ${name}`, () => expect(fn).toThrow(AuthError));
});

describe("mime allowlist", () => {
  test("wildcards", () => {
    const list = ["image/*", "application/pdf"];
    expect(isMimeAllowed("image/png", list)).toBe(true);
    expect(isMimeAllowed("application/pdf", list)).toBe(true);
    expect(isMimeAllowed("video/mp4", list)).toBe(false);
    expect(isMimeAllowed("video/mp4", ["*/*"])).toBe(true);
    expect(isMimeAllowed("video/mp4", [])).toBe(true);
  });
});
