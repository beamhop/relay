import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import type { AdminContext, ApiContext, Principal } from "../context";
import { badRequest, forbidden, HttpError } from "../errors";
import type { LoginMethod } from "./sessions";
import { ExpiringMap } from "../util/lru";
import { kvGetOrCreate } from "../util/kv";
import { tryParsePubkey } from "../util/pubkey";
import { LoginLimiter, WindowCounter } from "../util/ratelimit";
import { rateKey } from "../util/request";
import { totpStep } from "../util/totp";

/** lifetime of login and passkey challenges */
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** marks a browser that has logged in to an account before; it skips the account-wide lockout (not an auth factor) */
const TRUSTED_DEVICE_COOKIE = "bh_td";
const TRUSTED_DEVICE_TTL_SEC = 180 * 86400;
/** changing login factors (passkeys, TOTP) needs a login this recent (or the current password) */
export const FRESH_LOGIN_SEC = 15 * 60;

/** The local part a NIP-05 login is looked up by. */
export const nip05Name = (login: string) => login.trim().toLowerCase().split("@")[0];

/**
 * Stateless single-use tokens: `<exp>.<payload>.<hmac>` signed with a per-process key, so issuing them costs
 * no server memory (an unauthenticated flood can't fill a map and lock admins out). Single use is enforced by
 * remembering a token only after it authenticated an admin — strangers can't fill that set.
 */
export class SignedTokens {
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

/**
 * What the login and re-auth routes share: rate limits and lockouts, single use of login challenges, re-auth checks
 * (current password, TOTP codes) and their freshness rule, trusted-device cookies and the persisted keys behind them.
 */
export class LoginGuard {
  readonly loginLimiter: LoginLimiter;
  readonly ipLimiter: LoginLimiter;
  /** per account regardless of IP, so a distributed (or IP-rotating) brute force is capped too */
  readonly accountLimiter: LoginLimiter;
  /** the same cap for browsers holding a valid trusted-device cookie: higher, but never unlimited */
  readonly trustedAccountLimiter: LoginLimiter;
  /** re-auth checks inside a session (current password, TOTP codes) */
  private readonly reauthLimiter: LoginLimiter;
  /**
   * Unauthenticated challenge issuance per IP (/64 for IPv6) — only bounds signing work, challenges are stateless.
   * Nostr and passkey logins have separate buckets so exhausting one doesn't block the other.
   */
  readonly challengeRate: WindowCounter;
  readonly passkeyOptionsRate: WindowCounter;
  /**
   * Login challenges / passkey challenges already used to log in an admin (single use). Process memory is enough:
   * the tokens are signed with a per-process key, so another instance never accepts them in the first place.
   */
  private readonly usedChallenges: ExpiringMap<true>;
  private readonly persistedKeys = new Map<string, Promise<Buffer>>();

  constructor(private readonly ctx: ApiContext) {
    this.loginLimiter = new LoginLimiter(ctx.nowMs, 5, 60_000);
    this.ipLimiter = new LoginLimiter(ctx.nowMs, 30, 60_000);
    this.accountLimiter = new LoginLimiter(ctx.nowMs, 10, 10 * 60_000);
    this.trustedAccountLimiter = new LoginLimiter(ctx.nowMs, 50, 10 * 60_000);
    this.reauthLimiter = new LoginLimiter(ctx.nowMs, 5, 5 * 60_000);
    this.challengeRate = new WindowCounter(ctx.nowMs, 60, 60_000);
    this.passkeyOptionsRate = new WindowCounter(ctx.nowMs, 60, 60_000);
    this.usedChallenges = new ExpiringMap<true>(10_000, ctx.nowMs);
  }

  busy(): HttpError {
    return new HttpError(503, "too many pending challenges, try again shortly", "busy");
  }

  tooMany(ms: number): HttpError {
    return new HttpError(429, "too many login attempts, try again later", "rate_limited", { "Retry-After": String(Math.ceil(ms / 1000)) });
  }

  limitChallenges(c: AdminContext, counter: WindowCounter): void {
    if (!counter.hit(rateKey(c.get("ip")))) throw new HttpError(429, "too many requests", "rate_limited", { "Retry-After": "60" });
  }

  /** Marks a verified challenge as used; false if it already was. Synchronous so concurrent requests can't both pass. */
  consumeChallenge(token: string, exp: number): boolean {
    if (this.usedChallenges.has(token)) return false;
    if (!this.usedChallenges.set(token, true, Math.max(1, exp * 1000 - this.ctx.nowMs()) + 1000)) throw this.busy();
    return true;
  }

  /** Runs a re-auth check (current password / TOTP code) under the per-admin re-auth limiter. */
  async reauth(pubkey: string, check: () => Promise<boolean> | boolean, err: () => HttpError): Promise<void> {
    const key = `reauth|${pubkey}`;
    const wait = this.reauthLimiter.check(key);
    if (wait > 0) throw this.tooMany(wait);
    if (!(await check())) {
      this.reauthLimiter.fail(key);
      throw err();
    }
    this.reauthLimiter.succeed(key);
  }

  /**
   * Whether the request itself is proof enough for a sensitive change: a NIP-98 signature, or a session whose login
   * (by `method`, when given) is at most `maxAgeSec` old.
   */
  isFresh(p: Principal, maxAgeSec: number, method?: LoginMethod): boolean {
    if (p.via === "nip98") return true;
    return !!p.session && (!method || p.session.method === method) && this.ctx.nowSec() - p.session.createdAt <= maxAgeSec;
  }

  /**
   * Login factors outlive password changes, so adding or removing one needs proof beyond a (possibly stolen)
   * session: a NIP-98 signature, a recent login, or the current password — one set before this session began,
   * since a password set during it can't vouch for the session itself.
   */
  async requireFreshAuth(p: Principal, currentPassword: string | undefined, what: string): Promise<void> {
    if (this.isFresh(p, FRESH_LOGIN_SEC)) return;
    const cred = await this.ctx.credentials.getPassword(p.pubkey);
    if (!cred || !currentPassword) throw forbidden(`please sign in again to ${what}`, "reauth_required");
    if (p.session && cred.setAt !== null && cred.setAt >= p.session.createdAt) throw forbidden(`please sign in again to ${what}`, "reauth_required");
    await this.reauth(p.pubkey, () => this.ctx.passwords.verify(currentPassword, cred.hash), () => forbidden("current password is incorrect", "invalid_credentials"));
  }

  /** Verifies a TOTP code against the stored secret and consumes its time step (no reuse). */
  async consumeTotp(pubkey: string, secret: string, code: string): Promise<boolean> {
    const step = totpStep(secret, code, this.ctx.nowSec());
    return step !== null && (await this.ctx.credentials.consumeTotpStep(pubkey, step));
  }

  /**
   * Re-auth flavour of consumeTotp: a valid code whose time step was already used (e.g. the one that just
   * logged in) is reported as `totp_reused` instead of a failed attempt — it isn't a wrong guess.
   */
  async reauthTotp(pubkey: string, secret: string, code: string): Promise<boolean> {
    const step = totpStep(secret, code, this.ctx.nowSec());
    if (step === null) return false;
    if (!(await this.ctx.credentials.consumeTotpStep(pubkey, step))) {
      throw badRequest("this code was already used — wait for the next code from your authenticator", "totp_reused");
    }
    return true;
  }

  // ---------------------------------------------------------------- persisted keys
  /** A random HMAC key kept in kv (`admin/<name>`): it survives restarts and is shared by every instance. */
  persistedKey(name: string): Promise<Buffer> {
    let key = this.persistedKeys.get(name);
    if (!key) {
      key = (async () => {
        // instances starting together on an empty kv all end up with one key
        const valid = (v: string | undefined): v is string => typeof v === "string" && !!v;
        const k = await kvGetOrCreate(this.ctx.deps.stores.kv, "admin", name, () => randomBytes(32).toString("base64"), valid);
        return Buffer.from(k, "base64");
      })().catch((err) => {
        this.persistedKeys.delete(name);
        throw err;
      });
      this.persistedKeys.set(name, key);
    }
    return key;
  }

  // ---------------------------------------------------------------- trusted devices
  /** HMAC of a trusted-device cookie, with a key persisted so the marker survives restarts. */
  private async deviceMac(pubkey: string, issuedAt: number) {
    return createHmac("sha256", await this.persistedKey("trusted-device-key")).update(`trusted-device|${pubkey}|${issuedAt}`).digest("base64url");
  }

  async markTrustedDevice(c: AdminContext, pubkey: string): Promise<void> {
    const issuedAt = this.ctx.nowSec();
    const value = `${pubkey}.${issuedAt}.${await this.deviceMac(pubkey, issuedAt)}`;
    setCookie(c, TRUSTED_DEVICE_COOKIE, value, {
      httpOnly: true,
      sameSite: "Strict",
      secure: this.ctx.secureCookies,
      path: "/admin",
      maxAge: TRUSTED_DEVICE_TTL_SEC,
    });
  }

  /**
   * True when the request carries a valid trusted-device cookie for this account, issued after the password was
   * last set — so a browser that only knew the old password doesn't keep its bypass after a rotation.
   */
  async isTrustedDevice(c: AdminContext, pubkey: string, passwordSetAt: number | null | undefined): Promise<boolean> {
    const m = /^([0-9a-f]{64})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(getCookie(c, TRUSTED_DEVICE_COOKIE) ?? "");
    if (!m || m[1] !== pubkey) return false;
    const issuedAt = Number(m[2]);
    const now = this.ctx.nowSec();
    if (issuedAt > now + 60 || now - issuedAt > TRUSTED_DEVICE_TTL_SEC) return false;
    if (passwordSetAt != null && issuedAt < passwordSetAt) return false;
    const want = Buffer.from(await this.deviceMac(pubkey, issuedAt));
    const got = Buffer.from(m[3]);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * hex / npub / nprofile, or a NIP-05 address resolved against this relay's own users table only (by its local part;
   * the domain is ignored) — never fetched from the network, so an anonymous login can't make the server send requests.
   */
  async resolveLogin(login: string): Promise<string | undefined> {
    const pk = tryParsePubkey(login);
    if (pk) return pk;
    const name = nip05Name(login);
    if (!name || name.length > 100) return undefined;
    return (await this.ctx.deps.stores.users.getByNip05(name))?.pubkey;
  }
}
