import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ChallengeResponse, NostrLoginRequest } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../../context";
import { badRequest, forbidden, unauthorized } from "../../errors";
import { CHALLENGE_TTL_MS, type LoginGuard, SignedTokens } from "../../services/login-guard";
import type { Accepts, Same } from "../../util/contract";
import { isNostrEventShape, verifyNip98 } from "../../util/nip98";
import { readBody } from "../../util/request";
import type { StartSession } from "./session";

/** the event's shape is checked after parsing (isNostrEventShape), so the schema only pins the fields */
const NostrLogin = z.object({ event: z.unknown() });
true satisfies Same<keyof z.output<typeof NostrLogin>, keyof NostrLoginRequest> & Accepts<z.input<typeof NostrLogin>, NostrLoginRequest>;

/** Login with a signed NIP-98 event over a server-issued challenge. */
export function registerNostrLoginRoutes(app: AdminApp, ctx: ApiContext, guard: LoginGuard, startSession: StartSession) {
  const loginChallenges = new SignedTokens("nostr-login");
  // The signed `u` is always the publicUrl-based URL, even when the panel is opened via a LAN IP or localhost:
  // the server tells the client what to sign. Accepting the Host the request arrived on would let any site
  // that gets an admin's signer to sign a login "for itself" replay it here with a matching Host header.
  const nostrLoginUrl = `${ctx.publicUrl}/admin/api/auth/nostr`;

  app.get("/auth/challenge", (c) => {
    guard.limitChallenges(c, guard.challengeRate);
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
    if (!guard.consumeChallenge(challenge, opened.exp)) throw unauthorized("invalid or expired challenge", "invalid_challenge");
    return c.json(await startSession(c, event.pubkey, "nostr"));
  });
}
