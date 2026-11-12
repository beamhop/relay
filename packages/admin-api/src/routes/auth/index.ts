import type { AdminApp, ApiContext } from "../../context";
import { LoginGuard } from "../../services/login-guard";
import { registerNostrLoginRoutes } from "./nostr";
import { registerPasskeyRoutes } from "./passkey";
import { registerPasswordRoutes } from "./password";
import { registerSessionRoutes, sessionStarter } from "./session";
import { registerTotpRoutes } from "./totp";

/** /auth/*: logins (Nostr, password + TOTP, passkeys), login factor management, logout and /auth/me. */
export function registerAuthRoutes(app: AdminApp, ctx: ApiContext): LoginGuard {
  const guard = new LoginGuard(ctx);
  const startSession = sessionStarter(ctx, guard);
  registerNostrLoginRoutes(app, ctx, guard, startSession);
  registerPasswordRoutes(app, ctx, guard, startSession);
  registerTotpRoutes(app, ctx, guard);
  registerPasskeyRoutes(app, ctx, guard, startSession);
  registerSessionRoutes(app, ctx);
  return guard;
}
