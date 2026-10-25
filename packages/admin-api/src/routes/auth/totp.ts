import { nip19 } from "nostr-tools";
import { z } from "zod";
import type { AdminApp, ApiContext } from "../../context";
import { principalOf } from "../../context";
import { badRequest } from "../../errors";
import { requireAdmin } from "../../middleware/auth";
import type { LoginGuard } from "../../services/login-guard";
import { ExpiringMap } from "../../util/lru";
import { readBody } from "../../util/request";
import { generateTotpSecret, totpStep, totpUri } from "../../util/totp";

const TotpCode = z.object({ code: z.string().min(6).max(16) });
const TotpSetup = z.object({ code: z.string().min(6).max(16).optional(), currentPassword: z.string().max(1024).optional() });

/** TOTP (extension, not in admin-contract): setup → enable(code) ; disable(code) */
export function registerTotpRoutes(app: AdminApp, ctx: ApiContext, guard: LoginGuard) {
  /** pending TOTP secrets, bound to the session that passed setup's checks (null: NIP-98) */
  const pendingTotp = new ExpiringMap<{ secret: string; session: string | null }>(1000, ctx.nowMs);

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
      await guard.reauth(p.pubkey, () => guard.reauthTotp(p.pubkey, secret, code), () => badRequest("invalid TOTP code", "invalid_totp"));
    } else {
      // a first authenticator is a login factor the owner can't remove without its codes: a stale session can't enroll one
      await guard.requireFreshAuth(p, currentPassword, "set up two-factor authentication");
    }
    const secret = generateTotpSecret();
    if (!pendingTotp.set(p.pubkey, { secret, session: p.session?.id ?? null }, 10 * 60_000)) throw guard.busy();
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
    await guard.reauth(p.pubkey, () => (step = totpStep(secret, code, ctx.nowSec())) !== null, () => badRequest("invalid TOTP code", "invalid_totp"));
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
    await guard.reauth(p.pubkey, () => guard.reauthTotp(p.pubkey, secret, code), () => badRequest("invalid TOTP code", "invalid_totp"));
    await ctx.credentials.setTotp(p.pubkey, null);
    await ctx.audit(c, "auth.totp.disable", p.pubkey);
    return c.json({ ok: true });
  });
}
