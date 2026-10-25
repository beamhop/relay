import { z } from "zod";
import type { PasswordLoginRequest } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../../context";
import { principalOf } from "../../context";
import { badRequest, forbidden, unauthorized } from "../../errors";
import { requireAdmin } from "../../middleware/auth";
import { FRESH_LOGIN_SEC, type LoginGuard } from "../../services/login-guard";
import type { Same } from "../../util/contract";
import { rateKey, readBody } from "../../util/request";
import type { StartSession } from "./session";

/** changing an existing password without the current one needs a Nostr login this recent */
const FRESH_NOSTR_LOGIN_SEC = 10 * 60;

const PasswordLogin = z.object({ login: z.string().min(1).max(200), password: z.string().min(1).max(1024), totp: z.string().max(16).optional() });
true satisfies Same<z.output<typeof PasswordLogin>, PasswordLoginRequest>;
const PasswordSet = z.object({ password: z.string().min(8, "password must be at least 8 characters").max(1024), currentPassword: z.string().max(1024).optional() });

/** Password login (with TOTP when enabled) and setting / changing the password. */
export function registerPasswordRoutes(app: AdminApp, ctx: ApiContext, guard: LoginGuard, startSession: StartSession) {
  app.post("/auth/password", async (c) => {
    const body = await readBody(c, PasswordLogin);
    const ip = rateKey(c.get("ip"));
    const pubkey = await guard.resolveLogin(body.login);
    // key on the resolved pubkey so npub / hex / NIP-05 spellings share one lockout counter
    const account = pubkey ?? body.login.trim().toLowerCase();
    const key = `${ip}|${account}`;
    const cred = pubkey ? await ctx.credentials.getPassword(pubkey) : undefined;
    // a browser that logged in to this account since its password was set gets its own, larger account-wide
    // counter, so strangers spraying guesses at a public npub can't lock its owner out (per-IP limits still apply)
    const trusted = !!pubkey && (await guard.isTrustedDevice(c, pubkey, cred?.setAt));
    const accountCounter = trusted ? guard.trustedAccountLimiter : guard.accountLimiter;
    const wait = Math.max(guard.loginLimiter.check(key), guard.ipLimiter.check(ip), accountCounter.check(account));
    if (wait > 0) throw guard.tooMany(wait);
    const failed = () => {
      guard.loginLimiter.fail(key);
      guard.ipLimiter.fail(ip);
      accountCounter.fail(account);
    };

    const ok = await ctx.passwords.verify(body.password, cred?.hash ?? (await ctx.passwords.dummyHash()));
    if (!pubkey || !cred || !ok) {
      failed();
      throw unauthorized("invalid login or password", "invalid_credentials");
    }
    if (cred.totpSecret) {
      if (!body.totp) throw unauthorized("TOTP code required", "totp_required");
      if (!(await guard.consumeTotp(pubkey, cred.totpSecret, body.totp))) {
        failed();
        throw unauthorized("invalid TOTP code", "invalid_totp");
      }
    }
    guard.loginLimiter.succeed(key);
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
      if (!guard.isFresh(p, FRESH_NOSTR_LOGIN_SEC, "nostr")) {
        const current = body.currentPassword;
        if (!current) throw badRequest("currentPassword required", "current_password_required");
        await guard.reauth(p.pubkey, () => ctx.passwords.verify(current, existing.hash), () => forbidden("current password is incorrect", "invalid_credentials"));
      }
    } else if (!guard.isFresh(p, FRESH_LOGIN_SEC)) {
      // a first password is a new login factor (and re-auth proof for passkeys): a stale, possibly stolen
      // session must not be able to mint one
      throw forbidden("please sign in again to set a password", "reauth_required");
    }
    await ctx.credentials.setPassword(p.pubkey, await ctx.passwords.hash(body.password));
    // every other session ends, with its push devices
    await ctx.sessions.endAllFor(p.pubkey, p.session?.id);
    await ctx.audit(c, "auth.password.set", p.pubkey);
    return c.json({ ok: true });
  });
}
