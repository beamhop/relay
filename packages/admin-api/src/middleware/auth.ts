import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Permission } from "@beamhop/sdk";
import type { AdminContext, AdminEnv, ApiContext, Principal } from "../context";
import { forbidden, unauthorized } from "../errors";
import { permissionsFor } from "../services/roles";
import { SESSION_TTL_SEC, type SessionRecord } from "../services/sessions";
import { parseNostrAuthorization, verifyNip98 } from "../util/nip98";

export const SESSION_COOKIE = "bh_session";
const COOKIE_PATH = "/admin";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function setSessionCookie(c: AdminContext, ctx: ApiContext, s: SessionRecord) {
  setCookie(c, SESSION_COOKIE, s.id, {
    httpOnly: true,
    sameSite: "Strict",
    secure: ctx.secureCookies,
    path: COOKIE_PATH,
    maxAge: Math.max(0, Math.min(SESSION_TTL_SEC, s.expiresAt - ctx.nowSec())),
  });
}
export function clearSessionCookie(c: AdminContext, ctx: ApiContext) {
  deleteCookie(c, SESSION_COOKIE, { path: COOKIE_PATH, secure: ctx.secureCookies, httpOnly: true, sameSite: "Strict" });
}

/** Absolute URL a NIP-98 `u` tag must carry for this request (publicUrl + /admin/api + path + query). */
export function expectedAdminUrl(ctx: ApiContext, reqUrl: string): string {
  const u = new URL(reqUrl);
  let path = u.pathname;
  if (!path.startsWith("/admin/api")) path = `/admin/api${path === "/" ? "" : path}`;
  return `${ctx.publicUrl}${path}${u.search}`;
}

export function makePrincipal(pubkey: string, role: Principal["role"], via: Principal["via"], session?: SessionRecord): Principal {
  return { pubkey, role, permissions: permissionsFor(role), via, session };
}

/** Cookie-authenticated mutating requests must prove same-origin (CSRF). */
function csrfOk(c: AdminContext, ctx: ApiContext): boolean {
  if (c.req.header("x-requested-with") === "beamhop") return true;
  const origin = c.req.header("origin");
  return !!origin && origin === ctx.publicOrigin;
}

/**
 * Resolves the principal from `Authorization: Nostr …` (NIP-98, per request) or the session cookie.
 * Never rejects anonymous requests – use `requirePermission` for that.
 */
export function authenticate(ctx: ApiContext): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    c.set("principal", undefined);
    const authz = c.req.header("authorization");
    if (authz && /^nostr\s/i.test(authz)) {
      const ev = parseNostrAuthorization(authz);
      if (!ev) throw unauthorized("malformed NIP-98 authorization header", "invalid_auth");
      let body: Uint8Array | undefined;
      if (ev.tags.some((t) => t[0] === "payload") && c.req.raw.body) {
        body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
      }
      const r = verifyNip98(ev, { urls: [expectedAdminUrl(ctx, c.req.url)], method: c.req.method, body, nowSec: ctx.nowSec() });
      if (!r.ok) throw unauthorized(r.reason, "invalid_auth");
      if (ctx.usedAuthEvents.has(ev.id)) throw unauthorized("NIP-98 authorization already used", "replayed_auth");
      ctx.usedAuthEvents.set(ev.id, true, 125_000);
      c.set("principal", makePrincipal(ev.pubkey, await ctx.roles.resolve(ev.pubkey), "nip98"));
      return next();
    }

    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) {
      const s = await ctx.sessions.get(sid);
      if (s) {
        if (MUTATING.has(c.req.method) && !csrfOk(c, ctx)) throw forbidden("CSRF check failed (send X-Requested-With: beamhop)", "csrf");
        c.set("principal", makePrincipal(s.pubkey, await ctx.roles.resolve(s.pubkey), "session", s));
        if (await ctx.sessions.touch(s)) setSessionCookie(c, ctx, s);
      } else {
        clearSessionCookie(c, ctx);
      }
    }
    return next();
  };
}

/** 401 when anonymous, 403 when not an admin or lacking `permission`. */
export function requirePermission(...permissions: Permission[]): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const p = c.get("principal");
    if (!p) throw unauthorized();
    if (!p.role) throw forbidden("not an admin", "not_admin");
    for (const perm of permissions) if (!p.permissions.has(perm)) throw forbidden(`missing permission: ${perm}`, "missing_permission");
    return next();
  };
}
export const requireAdmin = () => requirePermission();

export function assertPermission(c: AdminContext, perm: Permission) {
  const p = c.get("principal");
  if (!p) throw unauthorized();
  if (!p.permissions.has(perm)) throw forbidden(`missing permission: ${perm}`, "missing_permission");
}
