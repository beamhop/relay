import { randomBytes } from "node:crypto";
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
import type { AdminRole, ChallengeResponse, LoginResponse, Me } from "@beamhop/sdk";
import type { AdminApp, AdminContext, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../errors";
import { clearSessionCookie, requireAdmin, setSessionCookie } from "../middleware/auth";
import { permissionsFor } from "../services/roles";
import type { LoginMethod } from "../services/sessions";
import { ExpiringMap } from "../util/lru";
import { isNostrEventShape, verifyNip98 } from "../util/nip98";
import { dummyHash, hashPassword, verifyPassword } from "../util/password";
import { tryParsePubkey } from "../util/pubkey";
import { LoginLimiter } from "../util/ratelimit";
import { readBody } from "../util/request";
import { generateTotpSecret, totpUri, verifyTotp } from "../util/totp";

const CHALLENGE_TTL_MS = 5 * 60_000;
const PASSKEY_COOKIE = "bh_pk";
const FRESH_NOSTR_LOGIN_SEC = 10 * 60;

export async function buildMe(ctx: ApiContext, pubkey: string, role: AdminRole): Promise<Me> {
  const [hasPassword, passkeys, profile] = await Promise.all([
    ctx.credentials.hasPassword(pubkey),
    ctx.credentials.listPasskeys(pubkey),
    ctx.profiles.get(pubkey),
  ]);
  return {
    pubkey,
    role,
    permissions: [...permissionsFor(role)],
    hasPassword,
    passkeys: passkeys.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })),
    ...(profile ? { profile } : {}),
  };
}

const PasswordLogin = z.object({ login: z.string().min(1).max(200), password: z.string().min(1).max(1024), totp: z.string().max(16).optional() });
const PasswordSet = z.object({ password: z.string().min(8, "password must be at least 8 characters").max(1024), currentPassword: z.string().max(1024).optional() });
const NostrLogin = z.object({ event: z.unknown() });
const PasskeyLoginOptions = z.object({ login: z.string().max(200).optional() });
const PasskeyVerify = z.object({ response: z.record(z.string(), z.unknown()) });
const PasskeyRegisterVerify = z.object({ response: z.record(z.string(), z.unknown()), name: z.string().max(100).optional() });
const TotpCode = z.object({ code: z.string().min(6).max(16) });

export function registerAuthRoutes(app: AdminApp, ctx: ApiContext) {
  const loginLimiter = new LoginLimiter(ctx.nowMs, 5, 60_000);
  const ipLimiter = new LoginLimiter(ctx.nowMs, 30, 60_000);
  const passkeyChallenges = new ExpiringMap<{ challenge: string }>(10_000, ctx.nowMs);
  const pendingTotp = new ExpiringMap<string>(1000, ctx.nowMs);

  async function resolveLogin(login: string): Promise<string | undefined> {
    const pk = tryParsePubkey(login);
    if (pk) return pk;
    const name = login.trim().toLowerCase().split("@")[0];
    if (!name || name.length > 100) return undefined;
    return (await ctx.deps.stores.users.getByNip05(name))?.pubkey;
  }

  async function startSession(c: AdminContext, pubkey: string, method: LoginMethod): Promise<LoginResponse> {
    const role = await ctx.roles.resolve(pubkey);
    if (!role) throw forbidden("not an admin", "not_admin");
    const s = await ctx.sessions.create(pubkey, method, c.get("ip"), c.req.header("user-agent") ?? null);
    setSessionCookie(c, ctx, s);
    await ctx.auditAs(pubkey, c.get("ip"), "auth.login", pubkey, { method });
    return { me: await buildMe(ctx, pubkey, role) };
  }

  const tooMany = (ms: number) =>
    new HttpError(429, "too many login attempts, try again later", "rate_limited", { "Retry-After": String(Math.ceil(ms / 1000)) });

  // ---------------------------------------------------------------- nostr (NIP-98 + challenge)
  app.get("/auth/challenge", (c) => {
    const challenge = randomBytes(32).toString("hex");
    ctx.challenges.set(challenge, true, CHALLENGE_TTL_MS);
    const body: ChallengeResponse = { challenge, expiresAt: Math.floor((ctx.nowMs() + CHALLENGE_TTL_MS) / 1000) };
    return c.json(body);
  });

  app.post("/auth/nostr", async (c) => {
    const { event } = await readBody(c, NostrLogin);
    if (!isNostrEventShape(event)) throw badRequest("invalid event");
    const r = verifyNip98(event, { urls: [`${ctx.publicUrl}/admin/api/auth/nostr`], method: "POST", nowSec: ctx.nowSec() });
    if (!r.ok) throw unauthorized(r.reason, "invalid_auth");
    const challenge = event.tags.find((t) => t[0] === "challenge")?.[1];
    if (!challenge || !ctx.challenges.take(challenge)) throw unauthorized("invalid or expired challenge", "invalid_challenge");
    return c.json(await startSession(c, event.pubkey, "nostr"));
  });

  // ---------------------------------------------------------------- password (+ optional TOTP)
  app.post("/auth/password", async (c) => {
    const body = await readBody(c, PasswordLogin);
    const ip = c.get("ip") ?? "unknown";
    const key = `${ip}|${body.login.trim().toLowerCase()}`;
    const wait = Math.max(loginLimiter.check(key), ipLimiter.check(ip));
    if (wait > 0) throw tooMany(wait);

    const pubkey = await resolveLogin(body.login);
    const cred = pubkey ? await ctx.credentials.getPassword(pubkey) : undefined;
    const ok = await verifyPassword(body.password, cred?.hash ?? (await dummyHash()));
    if (!pubkey || !cred || !ok) {
      loginLimiter.fail(key);
      ipLimiter.fail(ip);
      throw unauthorized("invalid login or password", "invalid_credentials");
    }
    if (cred.totpSecret) {
      if (!body.totp) throw unauthorized("TOTP code required", "totp_required");
      if (!verifyTotp(cred.totpSecret, body.totp, ctx.nowSec())) {
        loginLimiter.fail(key);
        ipLimiter.fail(ip);
        throw unauthorized("invalid TOTP code", "invalid_totp");
      }
    }
    loginLimiter.succeed(key);
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
        if (!body.currentPassword) throw badRequest("currentPassword required", "current_password_required");
        if (!(await verifyPassword(body.currentPassword, existing.hash))) throw forbidden("current password is incorrect", "invalid_credentials");
      }
    }
    await ctx.credentials.setPassword(p.pubkey, await hashPassword(body.password));
    await ctx.sessions.destroyAllFor(p.pubkey, p.session?.id);
    await ctx.audit(c, "auth.password.set", p.pubkey);
    return c.json({ ok: true });
  });

  // TOTP (extension, not in admin-contract): setup → enable(code) ; disable(code)
  app.post("/auth/totp/setup", requireAdmin(), async (c) => {
    const p = principalOf(c);
    if (!(await ctx.credentials.hasPassword(p.pubkey))) throw badRequest("set a password first");
    const secret = generateTotpSecret();
    pendingTotp.set(p.pubkey, secret, 10 * 60_000);
    const label = nip19.npubEncode(p.pubkey).slice(0, 16);
    return c.json({ secret, uri: totpUri(secret, label, ctx.deps.settings.get().info.name || "beamhop") });
  });
  app.post("/auth/totp/enable", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const { code } = await readBody(c, TotpCode);
    const secret = pendingTotp.get(p.pubkey);
    if (!secret) throw badRequest("no pending TOTP setup");
    if (!verifyTotp(secret, code, ctx.nowSec())) throw badRequest("invalid TOTP code", "invalid_totp");
    pendingTotp.delete(p.pubkey);
    await ctx.credentials.setTotp(p.pubkey, secret);
    await ctx.audit(c, "auth.totp.enable", p.pubkey);
    return c.json({ ok: true });
  });
  app.post("/auth/totp/disable", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const { code } = await readBody(c, TotpCode);
    const cred = await ctx.credentials.getPassword(p.pubkey);
    if (!cred?.totpSecret) throw badRequest("TOTP not enabled");
    if (!verifyTotp(cred.totpSecret, code, ctx.nowSec())) throw badRequest("invalid TOTP code", "invalid_totp");
    await ctx.credentials.setTotp(p.pubkey, null);
    await ctx.audit(c, "auth.totp.disable", p.pubkey);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- passkeys (WebAuthn)
  app.post("/auth/passkey/register/options", requireAdmin(), async (c) => {
    const p = principalOf(c);
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
    passkeyChallenges.set(`reg:${p.pubkey}`, { challenge: options.challenge }, CHALLENGE_TTL_MS);
    return c.json(options);
  });

  app.post("/auth/passkey/register/verify", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const body = await readBody(c, PasskeyRegisterVerify);
    const pending = passkeyChallenges.take(`reg:${p.pubkey}`);
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
    const { login } = await readBody(c, PasskeyLoginOptions);
    let allowCredentials: { id: string; transports?: string[] }[] | undefined;
    if (login) {
      const pk = await resolveLogin(login);
      const keys = pk ? await ctx.credentials.listPasskeys(pk) : [];
      if (keys.length) allowCredentials = keys.map((k) => ({ id: k.id, transports: k.transports }));
    }
    const options = await generateAuthenticationOptions({ rpID: ctx.rpID, allowCredentials, userVerification: "preferred" });
    const tmp = randomBytes(16).toString("hex");
    passkeyChallenges.set(`login:${tmp}`, { challenge: options.challenge }, CHALLENGE_TTL_MS);
    setCookie(c, PASSKEY_COOKIE, tmp, { httpOnly: true, sameSite: "Strict", secure: ctx.secureCookies, path: "/admin", maxAge: 300 });
    return c.json(options);
  });

  app.post("/auth/passkey/login/verify", async (c) => {
    const body = await readBody(c, PasskeyVerify);
    const tmp = getCookie(c, PASSKEY_COOKIE);
    deleteCookie(c, PASSKEY_COOKIE, { path: "/admin" });
    const pending = tmp ? passkeyChallenges.take(`login:${tmp}`) : undefined;
    if (!pending) throw unauthorized("passkey challenge expired", "invalid_challenge");
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
    await ctx.credentials.markPasskeyUsed(key.id, verification.authenticationInfo.newCounter);
    return c.json(await startSession(c, key.pubkey, "passkey"));
  });

  app.delete("/auth/passkey/:id", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const id = c.req.param("id");
    if (!(await ctx.credentials.deletePasskey(p.pubkey, id))) throw notFound("passkey not found");
    await ctx.audit(c, "auth.passkey.remove", p.pubkey, { id });
    return c.json({ me: await buildMe(ctx, p.pubkey, p.role!) });
  });

  // ---------------------------------------------------------------- session
  app.post("/auth/logout", async (c) => {
    const p = c.get("principal");
    if (p?.session) {
      await ctx.sessions.destroy(p.session.id);
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
