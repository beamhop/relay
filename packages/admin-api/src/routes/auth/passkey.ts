import { createHmac } from "node:crypto";
import { z } from "zod";
import type { PasskeyLoginOptionsRequest, PasskeyRegisterVerifyRequest, PasskeyVerifyRequest, ReauthRequest } from "@beamhop/sdk";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { nip19 } from "nostr-tools";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AdminApp, ApiContext } from "../../context";
import { principalOf } from "../../context";
import { badRequest, notFound, unauthorized } from "../../errors";
import { requireAdmin } from "../../middleware/auth";
import { CHALLENGE_TTL_MS, type LoginGuard, nip05Name, SignedTokens } from "../../services/login-guard";
import type { Same } from "../../util/contract";
import { ExpiringMap } from "../../util/lru";
import { readBody } from "../../util/request";
import { buildMe, type StartSession } from "./session";

const PASSKEY_COOKIE = "bh_pk";
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

const PasskeyLoginOptions = z.object({ login: z.string().max(200).optional() });
const PasskeyVerify = z.object({ response: z.record(z.string(), z.unknown()) });
const PasskeyRegisterVerify = z.object({ response: z.record(z.string(), z.unknown()), name: z.string().max(100).optional() });
/** register/options and DELETE /auth/passkey/:id */
const Reauth = z.object({ currentPassword: z.string().max(1024).optional() });
true satisfies Same<z.output<typeof PasskeyLoginOptions>, PasskeyLoginOptionsRequest> &
  Same<z.output<typeof PasskeyVerify>, PasskeyVerifyRequest> &
  Same<z.output<typeof PasskeyRegisterVerify>, PasskeyRegisterVerifyRequest> &
  Same<z.output<typeof Reauth>, ReauthRequest>;

/** Passkeys (WebAuthn): registration and removal inside a session, and passkey login. */
export function registerPasskeyRoutes(app: AdminApp, ctx: ApiContext, guard: LoginGuard, startSession: StartSession) {
  const passkeyLoginTokens = new SignedTokens("passkey-login");
  // keyed by admin pubkey: only authenticated admins add entries, at most one each
  const passkeyRegChallenges = new ExpiringMap<{ challenge: string }>(1000, ctx.nowMs);

  /**
   * Stand-in `allowCredentials` for a login that isn't an admin with passkeys, derived from the login with a persisted
   * key: stable across requests, restarts and instances, and shaped like real ones (count, id length, transports).
   */
  async function decoyCredentials(subject: string): Promise<{ id: string; transports: string[] }[]> {
    const key = await guard.persistedKey("passkey-decoy-key");
    const mac = (msg: string) => createHmac("sha256", key).update(`${msg}|${subject}`).digest();
    const count = DECOY_COUNTS[mac("count")[0] % DECOY_COUNTS.length];
    return Array.from({ length: count }, (_, i) => {
      const shape = DECOY_SHAPES[mac(`shape|${i}`)[0] % DECOY_SHAPES.length];
      const id = Buffer.concat([mac(`id|${i}|0`), mac(`id|${i}|1`)]).subarray(0, shape.bytes);
      return { id: id.toString("base64url"), transports: shape.transports };
    });
  }

  app.post("/auth/passkey/register/options", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const { currentPassword } = await readBody(c, Reauth);
    await guard.requireFreshAuth(p, currentPassword, "add a passkey");
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
    if (!passkeyRegChallenges.set(p.pubkey, { challenge: options.challenge }, CHALLENGE_TTL_MS)) throw guard.busy();
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
    guard.limitChallenges(c, guard.passkeyOptionsRate);
    const { login } = await readBody(c, PasskeyLoginOptions);
    let allowCredentials: { id: string; transports?: string[] }[] | undefined;
    if (login) {
      // Unauthenticated, so the answer must not reveal which logins are admins with passkeys (or their credential
      // ids): anything else gets decoys, and every login runs the same lookups.
      const pk = await guard.resolveLogin(login);
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
    if (!guard.consumeChallenge(token, opened.exp)) throw unauthorized("passkey challenge already used", "invalid_challenge");
    await ctx.credentials.markPasskeyUsed(key.id, verification.authenticationInfo.newCounter);
    return c.json(await startSession(c, key.pubkey, "passkey"));
  });

  app.delete("/auth/passkey/:id", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const id = c.req.param("id");
    const { currentPassword } = await readBody(c, Reauth);
    // removing passkeys can lock the owner out: same proof as adding one
    await guard.requireFreshAuth(p, currentPassword, "remove a passkey");
    if (!(await ctx.credentials.deletePasskey(p.pubkey, id))) throw notFound("passkey not found");
    await ctx.audit(c, "auth.passkey.remove", p.pubkey, { id });
    return c.json({ me: await buildMe(ctx, p.pubkey, p.role!) });
  });
}
