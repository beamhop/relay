import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { nip19 } from "nostr-tools";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AdminRole, ChallengeResponse, LoginResponse, Me, NostrLoginRequest, PasswordLoginRequest } from "@beamhop/sdk";
import type { AdminApp, AdminContext, ApiContext, Principal } from "../context";
import { principalOf } from "../context";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../errors";
import { clearSessionCookie, requireAdmin, setSessionCookie } from "../middleware/auth";
import { permissionsFor } from "../services/roles";
import type { LoginMethod } from "../services/sessions";
import type { Accepts, Same } from "../util/contract";
import { ExpiringMap } from "../util/lru";
import { isNostrEventShape, verifyNip98 } from "../util/nip98";
import { kvGetOrCreate } from "../util/kv";
import { tryParsePubkey } from "../util/pubkey";
import { LoginLimiter, WindowCounter } from "../util/ratelimit";
import { rateKey, readBody } from "../util/request";
import { generateTotpSecret, totpStep, totpUri } from "../util/totp";

const CHALLENGE_TTL_MS = 5 * 60_000;
const PASSKEY_COOKIE = "bh_pk";
/** marks a browser that has logged in to an account before; it skips the account-wide lockout (not an auth factor) */
const TRUSTED_DEVICE_COOKIE = "bh_td";
const TRUSTED_DEVICE_TTL_SEC = 180 * 86400;
const FRESH_NOSTR_LOGIN_SEC = 10 * 60;
/** changing login factors (passkeys, TOTP) needs a login this recent (or the current password) */
const FRESH_LOGIN_SEC = 15 * 60;
/** looked up in place of an unresolvable login, so it costs the same queries as a real one */
const NO_PUBKEY = "0".repeat(64);
/** passkeys per admin, and credential shapes of common authenticators, that decoy credentials mimic */
const DECOY_COUNTS = [1, 1, 1, 2, 2, 3];
const DECOY_SHAPES: { bytes: number; transports: string[] }[] = [
  { bytes: 16, transports: ["hybrid", "internal"] }, // synced passkeys (password managers)
  { bytes: 20, transports: ["hybrid", "internal"] }, // iCloud Keychain
  { bytes: 32, transports: ["internal"] }, // platform authenticators
  { bytes: 64, transports: ["nfc", "usb"] }, // security keys
];

/** The local part a NIP-05 login is looked up by. */
const nip05Name = (login: string) => login.trim().toLowerCase().split("@")[0];

async function buildMe(ctx: ApiContext, pubkey: string, role: AdminRole): Promise<Me> {
  const [cred, passkeys, profile] = await Promise.all([
    ctx.credentials.getPassword(pubkey),
    ctx.credentials.listPasskeys(pubkey),
    ctx.profiles.get(pubkey),
  ]);
  return {
    pubkey,
    role,
    permissions: [...permissionsFor(role)],
    hasPassword: !!cred?.hash,
    hasTotp: !!cred?.totpSecret,
    passkeys: passkeys.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })),
    ...(profile ? { profile } : {}),
  };
}

const PasswordLogin = z.object({ login: z.string().min(1).max(200), password: z.string().min(1).max(1024), totp: z.string().max(16).optional() });
true satisfies Same<z.output<typeof PasswordLogin>, PasswordLoginRequest>;
const PasswordSet = z.object({ password: z.string().min(8, "password must be at least 8 characters").max(1024), currentPassword: z.string().max(1024).optional() });
/** the event's shape is checked after parsing (isNostrEventShape), so the schema only pins the fields */
const NostrLogin = z.object({ event: z.unknown() });
true satisfies Same<keyof z.output<typeof NostrLogin>, keyof NostrLoginRequest> & Accepts<z.input<typeof NostrLogin>, NostrLoginRequest>;
const PasskeyLoginOptions = z.object({ login: z.string().max(200).optional() });
const PasskeyVerify = z.object({ response: z.record(z.string(), z.unknown()) });
const PasskeyRegisterVerify = z.object({ response: z.record(z.string(), z.unknown()), name: z.string().max(100).optional() });
const TotpCode = z.object({ code: z.string().min(6).max(16) });
const TotpSetup = z.object({ code: z.string().min(6).max(16).optional(), currentPassword: z.string().max(1024).optional() });
const PasskeyRegisterOptions = z.object({ currentPassword: z.string().max(1024).optional() });
const PasskeyDelete = z.object({ currentPassword: z.string().max(1024).optional() });

/**
 * Stateless single-use tokens: `<exp>.<payload>.<hmac>` signed with a per-process key, so issuing them costs
 * no server memory (an unauthenticated flood can't fill a map and lock admins out). Single use is enforced by
 * remembering a token only after it authenticated an admin — strangers can't fill that set.
 */
class SignedTokens {
  private readonly key = randomBytes(32);
  constructor(private readonly purpose: string) {}
  private mac(body: string) {
    return createHmac("sha256", this.key).update(`${this.purpose}|${body}`).digest("base64url");
  }
  issue(payload: string, expSec: number): string {
    const body = `${expSec}.${payload}`;
    return `${body}.${this.mac(body)}`;
  }
  /** Returns `{payload, exp}` when the token is authentic and not expired. */
  open(token: string, nowSec: number): { payload: string; exp: number } | null {
    if (token.length > 512) return null;
    const m = /^(\d{1,12})\.([A-Za-z0-9_-]{1,256})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) return null;
    const want = Buffer.from(this.mac(`${m[1]}.${m[2]}`));
    const got = Buffer.from(m[3]);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const exp = Number(m[1]);
    return exp >= nowSec ? { payload: m[2], exp } : null;
  }
}

export function registerAuthRoutes(app: AdminApp, ctx: ApiContext) {
  const loginLimiter = new LoginLimiter(ctx.nowMs, 5, 60_000);
  const ipLimiter = new LoginLimiter(ctx.nowMs, 30, 60_000);
  /** per account regardless of IP, so a distributed (or IP-rotating) brute force is capped too */
  const accountLimiter = new LoginLimiter(ctx.nowMs, 10, 10 * 60_000);
  /** the same cap for browsers holding a valid trusted-device cookie: higher, but never unlimited */
  const trustedAccountLimiter = new LoginLimiter(ctx.nowMs, 50, 10 * 60_000);
  /** re-auth checks inside a session (current password, TOTP codes) */
  const reauthLimiter = new LoginLimiter(ctx.nowMs, 5, 5 * 60_000);
  /**
   * Unauthenticated challenge issuance per IP (/64 for IPv6) — only bounds signing work, challenges are stateless.
   * Nostr and passkey logins have separate buckets so exhausting one doesn't block the other.
   */
  const challengeRate = new WindowCounter(ctx.nowMs, 60, 60_000);
  const passkeyOptionsRate = new WindowCounter(ctx.nowMs, 60, 60_000);
  const loginChallenges = new SignedTokens("nostr-login");
  const passkeyLoginTokens = new SignedTokens("passkey-login");
  /**
   * Login challenges / passkey challenges already used to log in an admin (single use). Process memory is enough:
   * the tokens are signed with a per-process key, so another instance never accepts them in the first place.
   */
  const usedChallenges = new ExpiringMap<true>(10_000, ctx.nowMs);
  // keyed by admin pubkey: only authenticated admins add entries, at most one each
  const passkeyRegChallenges = new ExpiringMap<{ challenge: string }>(1000, ctx.nowMs);
  /** pending TOTP secrets, bound to the session that passed setup's checks (null: NIP-98) */
  const pendingTotp = new ExpiringMap<{ secret: string; session: string | null }>(1000, ctx.nowMs);

  const busy = () => new HttpError(503, "too many pending challenges, try again shortly", "busy");
  const limitChallenges = (c: AdminContext, counter: WindowCounter) => {
    if (!counter.hit(rateKey(c.get("ip")))) throw new HttpError(429, "too many requests", "rate_limited", { "Retry-After": "60" });
  };
  /** Marks a verified challenge as used; false if it already was. Synchronous so concurrent requests can't both pass. */
  const consumeChallenge = (token: string, exp: number): boolean => {
    if (usedChallenges.has(token)) return false;
    if (!usedChallenges.set(token, true, Math.max(1, exp * 1000 - ctx.nowMs()) + 1000)) throw busy();
    return true;
  };

  /** Runs a re-auth check (current password / TOTP code) under the per-admin re-auth limiter. */
  async function reauth(pubkey: string, check: () => Promise<boolean> | boolean, err: () => HttpError): Promise<void> {
    const key = `reauth|${pubkey}`;
    const wait = reauthLimiter.check(key);
    if (wait > 0) throw tooMany(wait);
    if (!(await check())) {
      reauthLimiter.fail(key);
      throw err();
    }
    reauthLimiter.succeed(key);
  }

  /**
   * Login factors outlive password changes, so adding or removing one needs proof beyond a (possibly stolen)
   * session: a NIP-98 signature, a recent login, or the current password — one set before this session began,
   * since a password set during it can't vouch for the session itself.
   */
  async function requireFreshAuth(p: Principal, currentPassword: string | undefined, what: string): Promise<void> {
    if (p.via === "nip98" || (!!p.session && ctx.nowSec() - p.session.createdAt <= FRESH_LOGIN_SEC)) return;
    const cred = await ctx.credentials.getPassword(p.pubkey);
    if (!cred || !currentPassword) throw forbidden(`please sign in again to ${what}`, "reauth_required");
    if (p.session && cred.setAt !== null && cred.setAt >= p.session.createdAt) throw forbidden(`please sign in again to ${what}`, "reauth_required");
    await reauth(p.pubkey, () => ctx.passwords.verify(currentPassword, cred.hash), () => forbidden("current password is incorrect", "invalid_credentials"));
  }

  /** Verifies a TOTP code against the stored secret and consumes its time step (no reuse). */
  async function consumeTotp(pubkey: string, secret: string, code: string): Promise<boolean> {
    const step = totpStep(secret, code, ctx.nowSec());
    return step !== null && (await ctx.credentials.consumeTotpStep(pubkey, step));
  }

  /**
   * Re-auth flavour of consumeTotp: a valid code whose time step was already used (e.g. the one that just
   * logged in) is reported as `totp_reused` instead of a failed attempt — it isn't a wrong guess.
   */
  async function reauthTotp(pubkey: string, secret: string, code: string): Promise<boolean> {
    const step = totpStep(secret, code, ctx.nowSec());
    if (step === null) return false;
    if (!(await ctx.credentials.consumeTotpStep(pubkey, step))) {
      throw badRequest("this code was already used — wait for the next code from your authenticator", "totp_reused");
    }
    return true;
  }

  // ---------------------------------------------------------------- persisted keys
  const persistedKeys = new Map<string, Promise<Buffer>>();
  /** A random HMAC key kept in kv (`admin/<name>`): it survives restarts and is shared by every instance. */
  const persistedKey = (name: string): Promise<Buffer> => {
    let key = persistedKeys.get(name);
    if (!key) {
      key = (async () => {
        // instances starting together on an empty kv all end up with one key
        const valid = (v: string | undefined): v is string => typeof v === "string" && !!v;
        const k = await kvGetOrCreate(ctx.deps.stores.kv, "admin", name, () => randomBytes(32).toString("base64"), valid);
        return Buffer.from(k, "base64");
      })().catch((err) => {
        persistedKeys.delete(name);
        throw err;
      });
      persistedKeys.set(name, key);
    }
    return key;
  };

  // ---------------------------------------------------------------- trusted devices
  /** HMAC key for trusted-device cookies, persisted so the marker survives restarts. */
  const trustedDeviceKey = () => persistedKey("trusted-device-key");
  const deviceMac = async (pubkey: string, issuedAt: number) =>
    createHmac("sha256", await trustedDeviceKey()).update(`trusted-device|${pubkey}|${issuedAt}`).digest("base64url");

  async function markTrustedDevice(c: AdminContext, pubkey: string) {
    const issuedAt = ctx.nowSec();
    const value = `${pubkey}.${issuedAt}.${await deviceMac(pubkey, issuedAt)}`;
    setCookie(c, TRUSTED_DEVICE_COOKIE, value, {
      httpOnly: true,
      sameSite: "Strict",
      secure: ctx.secureCookies,
      path: "/admin",
      maxAge: TRUSTED_DEVICE_TTL_SEC,
    });
  }

  /**
   * True when the request carries a valid trusted-device cookie for this account, issued after the password was
   * last set — so a browser that only knew the old password doesn't keep its bypass after a rotation.
   */
  async function isTrustedDevice(c: AdminContext, pubkey: string, passwordSetAt: number | null | undefined): Promise<boolean> {
    const m = /^([0-9a-f]{64})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(getCookie(c, TRUSTED_DEVICE_COOKIE) ?? "");
    if (!m || m[1] !== pubkey) return false;
    const issuedAt = Number(m[2]);
    const now = ctx.nowSec();
    if (issuedAt > now + 60 || now - issuedAt > TRUSTED_DEVICE_TTL_SEC) return false;
    if (passwordSetAt != null && issuedAt < passwordSetAt) return false;
    const want = Buffer.from(await deviceMac(pubkey, issuedAt));
    const got = Buffer.from(m[3]);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * hex / npub / nprofile, or a NIP-05 address resolved against this relay's own users table only (by its local part;
   * the domain is ignored) — never fetched from the network, so an anonymous login can't make the server send requests.
   */
  async function resolveLogin(login: string): Promise<string | undefined> {
    const pk = tryParsePubkey(login);
    if (pk) return pk;
    const name = nip05Name(login);
    if (!name || name.length > 100) return undefined;
    return (await ctx.deps.stores.users.getByNip05(name))?.pubkey;
  }

  /**
   * Stand-in `allowCredentials` for a login that isn't an admin with passkeys, derived from the login with a persisted
   * key: stable across requests, restarts and instances, and shaped like real ones (count, id length, transports).
   */
  async function decoyCredentials(subject: string): Promise<{ id: string; transports: string[] }[]> {
    const key = await persistedKey("passkey-decoy-key");
    const mac = (msg: string) => createHmac("sha256", key).update(`${msg}|${subject}`).digest();
    const count = DECOY_COUNTS[mac("count")[0] % DECOY_COUNTS.length];
    return Array.from({ length: count }, (_, i) => {
      const shape = DECOY_SHAPES[mac(`shape|${i}`)[0] % DECOY_SHAPES.length];
      const id = Buffer.concat([mac(`id|${i}|0`), mac(`id|${i}|1`)]).subarray(0, shape.bytes);
      return { id: id.toString("base64url"), transports: shape.transports };
    });
  }

  async function startSession(c: AdminContext, pubkey: string, method: LoginMethod): Promise<LoginResponse> {
    const role = await ctx.roles.resolve(pubkey);
    if (!role) throw forbidden("not an admin", "not_admin");
    const s = await ctx.sessions.create(pubkey, method, c.get("ip"), c.req.header("user-agent") ?? null);
    setSessionCookie(c, ctx, s);
    await markTrustedDevice(c, pubkey);
    await ctx.auditAs(pubkey, c.get("ip"), "auth.login", pubkey, { method });
    return { me: await buildMe(ctx, pubkey, role) };
  }

  const tooMany = (ms: number) =>
    new HttpError(429, "too many login attempts, try again later", "rate_limited", { "Retry-After": String(Math.ceil(ms / 1000)) });

  // ---------------------------------------------------------------- nostr (NIP-98 + challenge)
  // The signed `u` is always the publicUrl-based URL, even when the panel is opened via a LAN IP or localhost:
  // the server tells the client what to sign. Accepting the Host the request arrived on would let any site
  // that gets an admin's signer to sign a login "for itself" replay it here with a matching Host header.
  const nostrLoginUrl = `${ctx.publicUrl}/admin/api/auth/nostr`;
  app.get("/auth/challenge", (c) => {
    limitChallenges(c, challengeRate);
    const expiresAt = Math.floor((ctx.nowMs() + CHALLENGE_TTL_MS) / 1000);
    const challenge = loginChallenges.issue(randomBytes(16).toString("hex"), expiresAt);
    const body: ChallengeResponse = { challenge, expiresAt, url: nostrLoginUrl };
    return c.json(body);
  });

  app.post("/auth/nostr", async (c) => {
    const { event } = await readBody(c, NostrLogin);
    if (!isNostrEventShape(event)) throw badRequest("invalid event");
    const r = verifyNip98(event, { urls: [nostrLoginUrl], method: "POST", nowSec: ctx.nowSec() });
    if (!r.ok) throw unauthorized(r.reason, "invalid_auth");
    const challenge = event.tags.find((t) => t[0] === "challenge")?.[1];
    const opened = challenge ? loginChallenges.open(challenge, ctx.nowSec()) : null;
    if (!challenge || !opened) throw unauthorized("invalid or expired challenge", "invalid_challenge");
    // non-admins are refused before the challenge is recorded, so only admin logins occupy the used-set
    if (!(await ctx.roles.resolve(event.pubkey))) throw forbidden("not an admin", "not_admin");
    if (!consumeChallenge(challenge, opened.exp)) throw unauthorized("invalid or expired challenge", "invalid_challenge");
    return c.json(await startSession(c, event.pubkey, "nostr"));
  });

  // ---------------------------------------------------------------- password (+ optional TOTP)
  app.post("/auth/password", async (c) => {
    const body = await readBody(c, PasswordLogin);
    const ip = rateKey(c.get("ip"));
    const pubkey = await resolveLogin(body.login);
    // key on the resolved pubkey so npub / hex / NIP-05 spellings share one lockout counter
    const account = pubkey ?? body.login.trim().toLowerCase();
    const key = `${ip}|${account}`;
    const cred = pubkey ? await ctx.credentials.getPassword(pubkey) : undefined;
    // a browser that logged in to this account since its password was set gets its own, larger account-wide
    // counter, so strangers spraying guesses at a public npub can't lock its owner out (per-IP limits still apply)
    const trusted = !!pubkey && (await isTrustedDevice(c, pubkey, cred?.setAt));
    const accountCounter = trusted ? trustedAccountLimiter : accountLimiter;
    const wait = Math.max(loginLimiter.check(key), ipLimiter.check(ip), accountCounter.check(account));
    if (wait > 0) throw tooMany(wait);
    const failed = () => {
      loginLimiter.fail(key);
      ipLimiter.fail(ip);
      accountCounter.fail(account);
    };

    const ok = await ctx.passwords.verify(body.password, cred?.hash ?? (await ctx.passwords.dummyHash()));
    if (!pubkey || !cred || !ok) {
      failed();
      throw unauthorized("invalid login or password", "invalid_credentials");
    }
    if (cred.totpSecret) {
      if (!body.totp) throw unauthorized("TOTP code required", "totp_required");
      if (!(await consumeTotp(pubkey, cred.totpSecret, body.totp))) {
        failed();
        throw unauthorized("invalid TOTP code", "invalid_totp");
      }
    }
    loginLimiter.succeed(key);
    accountCounter.succeed(account);
    if (ctx.passwords.needsRehash(cred.hash)) {
      // upgrade an older hash to the current parameters while the password is at hand; if the hasher is busy, the
      // next login tries again
      try {
        await ctx.credentials.rehashPassword(pubkey, cred.hash, await ctx.passwords.hash(body.password));
      } catch (err) {
        ctx.logger.debug("password rehash skipped", { error: String(err) });
      }
    }
    return c.json(await startSession(c, pubkey, "password"));
  });

  app.post("/auth/password/set", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const body = await readBody(c, PasswordSet);
    const existing = await ctx.credentials.getPassword(p.pubkey);
    if (existing) {
      const fresh =
        p.via === "nip98" ||
        (p.session?.method === "nostr" && ctx.nowSec() - p.session.createdAt <= FRESH_NOSTR_LOGIN_SEC);
      if (!fresh) {
        const current = body.currentPassword;
        if (!current) throw badRequest("currentPassword required", "current_password_required");
        await reauth(p.pubkey, () => ctx.passwords.verify(current, existing.hash), () => forbidden("current password is incorrect", "invalid_credentials"));
      }
    } else if (!(p.via === "nip98" || (!!p.session && ctx.nowSec() - p.session.createdAt <= FRESH_LOGIN_SEC))) {
      // a first password is a new login factor (and re-auth proof for passkeys): a stale, possibly stolen
      // session must not be able to mint one
      throw forbidden("please sign in again to set a password", "reauth_required");
    }
    await ctx.credentials.setPassword(p.pubkey, await ctx.passwords.hash(body.password));
    await ctx.sessions.destroyAllFor(p.pubkey, p.session?.id);
    await ctx.push.unsubscribeAllFor(p.pubkey, p.session?.id);
    await ctx.audit(c, "auth.password.set", p.pubkey);
    return c.json({ ok: true });
  });

  // TOTP (extension, not in admin-contract): setup → enable(code) ; disable(code)
  app.post("/auth/totp/setup", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const { code, currentPassword } = await readBody(c, TotpSetup);
    const cred = await ctx.credentials.getPassword(p.pubkey);
    if (!cred) throw badRequest("set a password first");
    // replacing an active secret needs a code from it, otherwise a hijacked session could swap in its own
    // authenticator and then pass the code check on /auth/totp/disable
    if (cred.totpSecret) {
      const secret = cred.totpSecret;
      if (!code) throw badRequest("current TOTP code required", "totp_required");
      await reauth(p.pubkey, () => reauthTotp(p.pubkey, secret, code), () => badRequest("invalid TOTP code", "invalid_totp"));
    } else {
      // a first authenticator is a login factor the owner can't remove without its codes: a stale session can't enroll one
      await requireFreshAuth(p, currentPassword, "set up two-factor authentication");
    }
    const secret = generateTotpSecret();
    if (!pendingTotp.set(p.pubkey, { secret, session: p.session?.id ?? null }, 10 * 60_000)) throw busy();
    const label = nip19.npubEncode(p.pubkey).slice(0, 16);
    return c.json({ secret, uri: totpUri(secret, label, ctx.deps.settings.get().info.name || "beamhop") });
  });
  app.post("/auth/totp/enable", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const { code } = await readBody(c, TotpCode);
    const pending = pendingTotp.get(p.pubkey);
    // only the session that passed setup's checks may enable its secret
    if (!pending || pending.session !== (p.session?.id ?? null)) throw badRequest("no pending TOTP setup");
    const { secret } = pending;
    let step: number | null = null;
    await reauth(p.pubkey, () => (step = totpStep(secret, code, ctx.nowSec())) !== null, () => badRequest("invalid TOTP code", "invalid_totp"));
    pendingTotp.delete(p.pubkey);
    // the enabling code counts as used; earlier steps belonged to the previous secret
    await ctx.credentials.setTotp(p.pubkey, secret, step);
    await ctx.audit(c, "auth.totp.enable", p.pubkey);
    return c.json({ ok: true });
  });
  app.post("/auth/totp/disable", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const { code } = await readBody(c, TotpCode);
    const cred = await ctx.credentials.getPassword(p.pubkey);
    const secret = cred?.totpSecret;
    if (!secret) throw badRequest("TOTP not enabled");
    await reauth(p.pubkey, () => reauthTotp(p.pubkey, secret, code), () => badRequest("invalid TOTP code", "invalid_totp"));
    await ctx.credentials.setTotp(p.pubkey, null);
    await ctx.audit(c, "auth.totp.disable", p.pubkey);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- passkeys (WebAuthn)
  app.post("/auth/passkey/register/options", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const { currentPassword } = await readBody(c, PasskeyRegisterOptions);
    await requireFreshAuth(p, currentPassword, "add a passkey");
    const existing = await ctx.credentials.listPasskeys(p.pubkey);
    const profile = await ctx.profiles.get(p.pubkey);
    const npub = nip19.npubEncode(p.pubkey);
    const options = await generateRegistrationOptions({
      rpName: ctx.deps.settings.get().info.name || "beamhop",
      rpID: ctx.rpID,
      userID: new Uint8Array(Buffer.from(p.pubkey, "hex")),
      userName: profile?.nip05 ?? profile?.name ?? npub.slice(0, 20),
      userDisplayName: profile?.display_name ?? profile?.name ?? npub.slice(0, 20),
      attestationType: "none",
      excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    if (!passkeyRegChallenges.set(p.pubkey, { challenge: options.challenge }, CHALLENGE_TTL_MS)) throw busy();
    return c.json(options);
  });

  app.post("/auth/passkey/register/verify", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const body = await readBody(c, PasskeyRegisterVerify);
    const pending = passkeyRegChallenges.take(p.pubkey);
    if (!pending) throw badRequest("no pending passkey registration", "invalid_challenge");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: ctx.publicOrigin,
        expectedRPID: ctx.rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw badRequest(`passkey verification failed: ${(err as Error).message}`, "passkey_failed");
    }
    if (!verification.verified) throw badRequest("passkey verification failed", "passkey_failed");
    const cred = verification.registrationInfo.credential;
    if (await ctx.credentials.getPasskey(cred.id)) throw badRequest("passkey already registered");
    const name = body.name?.trim() || `Passkey ${new Date(ctx.nowMs()).toISOString().slice(0, 10)}`;
    await ctx.credentials.addPasskey({
      id: cred.id,
      pubkey: p.pubkey,
      publicKey: Buffer.from(cred.publicKey).toString("base64"),
      counter: cred.counter,
      transports: cred.transports ?? [],
      name,
    });
    await ctx.audit(c, "auth.passkey.add", p.pubkey, { id: cred.id, name });
    return c.json({ me: await buildMe(ctx, p.pubkey, p.role!) });
  });

  app.post("/auth/passkey/login/options", async (c) => {
    limitChallenges(c, passkeyOptionsRate);
    const { login } = await readBody(c, PasskeyLoginOptions);
    let allowCredentials: { id: string; transports?: string[] }[] | undefined;
    if (login) {
      // Unauthenticated, so the answer must not reveal which logins are admins with passkeys (or their credential
      // ids): anything else gets decoys, and every login runs the same lookups.
      const pk = await resolveLogin(login);
      const probe = pk ?? NO_PUBKEY;
      const [keys, role, decoys] = await Promise.all([
        ctx.credentials.listPasskeys(probe),
        ctx.roles.resolve(probe),
        decoyCredentials(pk ? `pubkey:${pk}` : `name:${nip05Name(login)}`),
      ]);
      allowCredentials = keys.length && role ? keys.map((k) => ({ id: k.id, transports: k.transports })) : decoys;
    }
    const options = await generateAuthenticationOptions({ rpID: ctx.rpID, allowCredentials, userVerification: "preferred" });
    // the challenge travels in a signed cookie instead of a server-side map (see SignedTokens)
    const token = passkeyLoginTokens.issue(options.challenge, Math.floor((ctx.nowMs() + CHALLENGE_TTL_MS) / 1000));
    setCookie(c, PASSKEY_COOKIE, token, { httpOnly: true, sameSite: "Strict", secure: ctx.secureCookies, path: "/admin", maxAge: CHALLENGE_TTL_MS / 1000 });
    return c.json(options);
  });

  app.post("/auth/passkey/login/verify", async (c) => {
    const body = await readBody(c, PasskeyVerify);
    const token = getCookie(c, PASSKEY_COOKIE);
    deleteCookie(c, PASSKEY_COOKIE, { path: "/admin" });
    const opened = token ? passkeyLoginTokens.open(token, ctx.nowSec()) : null;
    if (!token || !opened) throw unauthorized("passkey challenge expired", "invalid_challenge");
    const pending = { challenge: opened.payload };
    const response = body.response as unknown as AuthenticationResponseJSON;
    const key = typeof response.id === "string" ? await ctx.credentials.getPasskey(response.id) : undefined;
    if (!key) throw unauthorized("unknown passkey", "invalid_credentials");
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: ctx.publicOrigin,
        expectedRPID: ctx.rpID,
        credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64")), counter: key.counter, transports: key.transports as never },
        requireUserVerification: false,
      });
    } catch (err) {
      throw unauthorized(`passkey verification failed: ${(err as Error).message}`, "passkey_failed");
    }
    if (!verification.verified) throw unauthorized("passkey verification failed", "passkey_failed");
    // only a registered passkey's holder gets here, so strangers can't fill the used-set
    if (!consumeChallenge(token, opened.exp)) throw unauthorized("passkey challenge already used", "invalid_challenge");
    await ctx.credentials.markPasskeyUsed(key.id, verification.authenticationInfo.newCounter);
    return c.json(await startSession(c, key.pubkey, "passkey"));
  });

  app.delete("/auth/passkey/:id", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const id = c.req.param("id");
    const { currentPassword } = await readBody(c, PasskeyDelete);
    // removing passkeys can lock the owner out: same proof as adding one
    await requireFreshAuth(p, currentPassword, "remove a passkey");
    if (!(await ctx.credentials.deletePasskey(p.pubkey, id))) throw notFound("passkey not found");
    await ctx.audit(c, "auth.passkey.remove", p.pubkey, { id });
    return c.json({ me: await buildMe(ctx, p.pubkey, p.role!) });
  });

  // ---------------------------------------------------------------- session
  app.post("/auth/logout", async (c) => {
    const p = c.get("principal");
    if (p?.session) {
      await ctx.sessions.destroy(p.session.id);
      await ctx.push.unsubscribeSession(p.session.id);
      await ctx.auditAs(p.pubkey, c.get("ip"), "auth.logout", p.pubkey);
    }
    clearSessionCookie(c, ctx);
    return c.json({ ok: true });
  });

  app.get("/auth/me", requireAdmin(), async (c) => {
    const p = principalOf(c);
    return c.json(await buildMe(ctx, p.pubkey, p.role!));
  });
}
