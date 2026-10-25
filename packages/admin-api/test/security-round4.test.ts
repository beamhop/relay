import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { isSecretKeyName, looksLikeSecretValue } from "@beamhop/sdk/secrets";
import { maskSecrets } from "../src/routes/plugins";
import { isPrivateIp } from "../src/util/ip";
import { createHarness, newKey } from "./fakes";

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});
const trustedCookieFrom = (res: Response) => {
  const m = /bh_td=([^;]*)/.exec(res.headers.get("set-cookie") ?? "");
  return m?.[1] ? `bh_td=${m[1]}` : undefined;
};

describe("secret matcher, last round", () => {
  test("webhooks, auth headers and short credential words are secret; key/cookie metadata and relay lists are not", () => {
    for (const k of ["webhook", "slackWebhook", "discordWebhook", "authHeader", "basicAuth", "jwt", "otp", "totp", "hmac", "salt", "pepper", "passcode", "pat"])
      expect(isSecretKeyName(k)).toBe(true);
    for (const k of ["keyName", "keyType", "keyFormat", "keyAlgorithm", "keyPath", "keyPrefix", "apiKeyHeader", "apiKeyHeaderName", "cookieName", "cookieDomain", "cookieSameSite", "nwcRelays", "nsecbunkerRelay", "objectKey", "whitelistKeys", "otpEnabled", "saltRounds", "pattern"])
      expect(isSecretKeyName(k)).toBe(false);
  });
  test("credential-shaped values are secret under any key", () => {
    for (const v of [
      "https://x.example/cb?client_secret=abc",
      "https://x.example/?auth_token=abc",
      "https://x.example/?private_key=abc",
      "https://x.example/?api-key=abc",
      "https://b.s3.amazonaws.com/o?X-Amz-Credential=AK%2F&X-Amz-Signature=deadbeef",
      "-----BEGIN RSA PRIVATE KEY-----\nabc",
      "Bearer abcdefghijkl",
      "https://hooks.slack.com/services/T0/B0/XXXX",
      "https://discord.com/api/webhooks/123/tok",
      "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage",
    ])
      expect(looksLikeSecretValue(v)).toBe(true);
    for (const v of ["https://example.com/?keyword=x", "https://example.com/?passage=1", "wss://relay.damus.io", "https://example.com/?sort=asc"])
      expect(looksLikeSecretValue(v)).toBe(false);
  });
});

describe("secret key names", () => {
  test("real credential names are recognised", () => {
    const secret = [
      "nsec", "secretKey", "s3SecretAccessKey", "apiToken", "password", "privkey", "privKey", "seed", "secret_key", "apikey", "APIKEY",
      "secretkey", "privatekey", "authtoken", "accessKey", "accesskey", "openAIKey", "openaiKey", "anthropicKey", "stripeKey", "hmacKey",
      "signingKey", "encryptionKey", "jwtSecret", "webhookUrl", "connectionString", "dsn", "smtpPass", "pass", "pwd", "pin", "apiKey2",
      "apiKeyV2", "password2", "token2", "privKeyHex", "nsecHex", "secretHex", "relayPrivkey", "botToken", "authKey", "masterKey",
      "adminKey", "licenseKey", "nwcUrl", "keys", "key", "seedWords", "mnemonicPhrase", "privateKeys", "x-api-key", "authorization",
      "Authorization", "bearer", "cookie", "hex_privkey", "priv_key", "AWS_SECRET_ACCESS_KEY", "privateKeyPem", "sshKey", "refreshToken",
      "csrfToken", "totpSecret", "nsecBunker", "credentials", "recoveryPhrase",
    ];
    expect(secret.filter((k) => !isSecretKeyName(k))).toEqual([]);
  });

  test("ordinary setting names are left readable", () => {
    const plain = [
      "privateRelay", "maxTokens", "tokenBucketSize", "tokensPerMinute", "publicKey", "pubkey", "relayPubkey", "npub", "sortKey",
      "cacheKey", "keyId", "keywords", "name", "description", "enabled", "threshold", "relays", "seedRelays", "authors", "compass",
      "privacy", "blockedKinds", "hotkeys", "relayUrl", "maxBytes", "primaryKey", "pinned",
    ];
    expect(plain.filter(isSecretKeyName)).toEqual([]);
  });

  test("credential-bearing values are recognised whatever the key", () => {
    for (const v of ["postgres://u:p@db/x", "nostr+walletconnect://abc?relay=wss://r&secret=xx", "Server=x;Password=y", "https://x/?apikey=1", `nsec1${"q".repeat(58)}`])
      expect(looksLikeSecretValue(v)).toBe(true);
    for (const v of ["wss://relay.damus.io", "https://relay.example/path?limit=5", "use key=value pairs", "bunker://abc?relay=wss://r"])
      expect(looksLikeSecretValue(v)).toBe(false);
  });

  test("maskSecrets hides every string under a secret key and credential-bearing values anywhere", () => {
    const out = maskSecrets({
      credentials: { user: "u", value: "secretval", n: 5 },
      databaseUrl: "postgres://u:p@db/x",
      relays: ["wss://relay.damus.io"],
      maxTokens: 100,
      privateRelay: true,
    }) as Record<string, unknown>;
    expect(out.credentials).toEqual({ user: "••••••••", value: "••••••••", n: 5 });
    expect(out.databaseUrl).toBe("••••••••");
    expect(out.relays).toEqual(["wss://relay.damus.io"]);
    expect(out.maxTokens).toBe(100);
    expect(out.privateRelay).toBe(true);
  });
});

describe("trusted-device cookie", () => {
  test("a cookie issued before a password change no longer bypasses the account lockout", async () => {
    const h = await createHarness({ trustProxy: true });
    const cookie = await h.login(h.owner);
    await h.withCookie(cookie, "/auth/password/set", { method: "POST", body: { password: "old-password-1" } });
    const first = await h.req("/auth/password", json({ login: h.owner.pk, password: "old-password-1" }, { "x-forwarded-for": "198.51.100.1" }));
    const stale = trustedCookieFrom(first);
    expect(stale).toBeDefined();
    h.clock.now += 2000; // the rotation happens in a later second than the cookie was issued
    const fresh = await h.login(h.owner);
    expect((await h.withCookie(fresh, "/auth/password/set", { method: "POST", body: { password: "new-password-2" } })).status).toBe(200);
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await h.req("/auth/password", json({ login: h.owner.pk, password: `guess-${i}` }, { "x-forwarded-for": `203.0.113.${i + 1}`, cookie: stale! }));
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("filter delete below owner", () => {
  test("more than a page of matches sharing one second: truncated, then the repeat finishes", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const user = newKey().pk;
    const id = (n: number) => n.toString(16).padStart(64, "0");
    for (let i = 1; i <= 10_500; i++)
      await h.events.save({ id: id(i), pubkey: user, created_at: 1000, kind: 1, tags: [["t", "spam"]], content: "", sig: "0".repeat(128) } as NostrEvent);
    const res = await h.asKey(mod, "/events/delete", { method: "POST", body: { filters: [{ "#t": ["spam"] }] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; truncated?: boolean };
    expect(body.deleted).toBe(10_000);
    expect(body.truncated).toBe(true);
    const again = (await (await h.asKey(mod, "/events/delete", { method: "POST", body: { filters: [{ "#t": ["spam"] }] } })).json()) as { deleted: number; truncated?: boolean };
    expect(again.deleted).toBe(500);
    expect(again.truncated).toBeUndefined();
    expect(await h.events.count([{ "#t": ["spam"] }])).toBe(0);
  });

  test("a filter limit is never exceeded when a page ends inside a crowded second", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const user = newKey().pk;
    const id = (n: number) => n.toString(16).padStart(64, "0");
    for (let i = 1; i <= 12_000; i++)
      await h.events.save({ id: id(i), pubkey: user, created_at: 1000, kind: 1, tags: [["t", "spam"]], content: "", sig: "0".repeat(128) } as NostrEvent);
    const res = await h.asKey(mod, "/events/delete", { method: "POST", body: { filters: [{ "#t": ["spam"], limit: 10_001 }] } });
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBeLessThanOrEqual(10_001);
    expect(await h.events.count([{ "#t": ["spam"] }])).toBeGreaterThanOrEqual(12_000 - 10_001);
  });

  test("a small limit inside one second deletes exactly that many", async () => {
    const h = await createHarness();
    const mod = await h.addAdmin("moderator");
    const user = newKey().pk;
    const id = (n: number) => n.toString(16).padStart(64, "0");
    for (let i = 1; i <= 300; i++)
      await h.events.save({ id: id(i), pubkey: user, created_at: 1000, kind: 1, tags: [["t", "spam"]], content: "", sig: "0".repeat(128) } as NostrEvent);
    const body = (await (await h.asKey(mod, "/events/delete", { method: "POST", body: { filters: [{ "#t": ["spam"], limit: 120 }] } })).json()) as { deleted: number };
    expect(body.deleted).toBe(120);
    expect(await h.events.count([{ "#t": ["spam"] }])).toBe(180);
  });
});

describe("private address checks", () => {
  test("IPv4-translated ::ffff:0:a.b.c.d is judged by its embedded address", () => {
    expect(isPrivateIp("::ffff:0:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:0:7f00:1")).toBe(true);
    expect(isPrivateIp("::ffff:0:8.8.8.8")).toBe(false);
  });
});

describe("push subscription cap", () => {
  const sub = (i: number) => ({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: { p256dh: "k", auth: "a" } } });

  test("re-subscribing refreshes a device's age, so the stale one is evicted instead", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    for (let i = 0; i < 20; i++) {
      h.clock.now += 1000;
      await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub(i) });
    }
    h.clock.now += 1000;
    await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub(0) }); // the primary device checks in again
    h.clock.now += 1000;
    await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub(20) });
    const rows = (await h.stores.db.all<{ endpoint: string }>("SELECT endpoint FROM admin_push_subscriptions WHERE pubkey = ?", [h.owner.pk])).map((r) => r.endpoint);
    expect(rows).toHaveLength(20);
    expect(rows).toContain("https://fcm.googleapis.com/fcm/send/0");
    expect(rows).not.toContain("https://fcm.googleapis.com/fcm/send/1");
  });

  test("an endpoint re-assigned from another admin still respects the cap", async () => {
    const h = await createHarness({ pushSender: async () => {} });
    const other = await h.addAdmin("admin");
    for (let i = 0; i < 20; i++) {
      h.clock.now += 1000;
      await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub(i) });
    }
    h.clock.now += 1000;
    await h.asKey(other, "/push/subscribe", { method: "POST", body: sub(99) });
    h.clock.now += 1000;
    await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: sub(99) });
    expect(await h.stores.db.all("SELECT endpoint FROM admin_push_subscriptions WHERE pubkey = ?", [h.owner.pk])).toHaveLength(20);
  });
});
