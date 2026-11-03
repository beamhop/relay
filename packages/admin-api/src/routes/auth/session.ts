import type { AdminRole, LoginResponse, Me, SessionView } from "@beamhop/sdk";
import type { AdminApp, AdminContext, ApiContext } from "../../context";
import { principalOf } from "../../context";
import { forbidden, notFound } from "../../errors";
import { clearSessionCookie, requireAdmin, setSessionCookie } from "../../middleware/auth";
import type { LoginGuard } from "../../services/login-guard";
import { permissionsFor } from "../../services/roles";
import type { LoginMethod } from "../../services/sessions";

/** Starts a session for an authenticated login (cookie, trusted-device marker, audit) → the login response. */
export type StartSession = (c: AdminContext, pubkey: string, method: LoginMethod) => Promise<LoginResponse>;

export async function buildMe(ctx: ApiContext, pubkey: string, role: AdminRole): Promise<Me> {
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

export function sessionStarter(ctx: ApiContext, guard: LoginGuard): StartSession {
  return async (c, pubkey, method) => {
    const role = await ctx.roles.resolve(pubkey);
    if (!role) throw forbidden("not an admin", "not_admin");
    const s = await ctx.sessions.create(pubkey, method, c.get("ip"), c.req.header("user-agent") ?? null);
    setSessionCookie(c, ctx, s);
    await guard.markTrustedDevice(c, pubkey);
    await ctx.auditAs(pubkey, c.get("ip"), "auth.login", pubkey, { method });
    return { me: await buildMe(ctx, pubkey, role) };
  };
}

export function registerSessionRoutes(app: AdminApp, ctx: ApiContext) {
  app.post("/auth/logout", async (c) => {
    const p = c.get("principal");
    if (p?.session) {
      // the session's push devices go with it
      await ctx.sessions.end(p.session.id);
      await ctx.auditAs(p.pubkey, c.get("ip"), "auth.logout", p.pubkey);
    }
    clearSessionCookie(c, ctx);
    return c.json({ ok: true });
  });

  app.get("/auth/me", requireAdmin(), async (c) => {
    const p = principalOf(c);
    return c.json(await buildMe(ctx, p.pubkey, p.role!));
  });

  // your own sessions only: ending another admin's is what revoking their role (or a password reset) is for
  app.get("/auth/sessions", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const items: SessionView[] = (await ctx.sessions.listFor(p.pubkey)).map((s) => ({
      id: s.id,
      method: s.method,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.id === p.session?.id,
    }));
    return c.json({ items });
  });

  app.delete("/auth/sessions/:id", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const id = c.req.param("id");
    if (!(await ctx.sessions.listFor(p.pubkey)).some((s) => s.id === id)) throw notFound("session not found");
    // with its push devices, like a logout
    await ctx.sessions.end(id);
    if (id === p.session?.id) clearSessionCookie(c, ctx);
    await ctx.audit(c, "auth.session.end", p.pubkey, { session: id.slice(0, 12) });
    return c.json({ ok: true });
  });

  // "sign out everywhere else": a lost device or a leaked cookie, without having to change the password
  app.post("/auth/sessions/end-others", requireAdmin(), async (c) => {
    const p = principalOf(c);
    const keep = p.session?.id;
    const ended = (await ctx.sessions.listFor(p.pubkey)).filter((s) => s.id !== keep).length;
    await ctx.sessions.endAllFor(p.pubkey, keep);
    await ctx.audit(c, "auth.session.end-others", p.pubkey, { ended });
    return c.json({ ended });
  });
}
