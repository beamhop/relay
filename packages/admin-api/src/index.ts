import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { nip19 } from "nostr-tools";
import type { AdminApi, AdminApiDeps, CreateAdminApi, ReportView } from "@beamhop/sdk";
import type { AdminApiOptions, AdminEnv, ApiContext } from "./context";
import { migrateAdmin } from "./db";
import { createErrorHandler, errorBody, HttpError } from "./errors";
import { authenticate, isImportRequest } from "./middleware/auth";
import { CredentialService } from "./services/credentials";
import { ProfileService } from "./services/profiles";
import { PushCoalescer, PushService } from "./services/push";
import { ReplayGuard } from "./services/replay";
import { ReportService } from "./services/reports";
import { RoleService } from "./services/roles";
import { SessionService } from "./services/sessions";
import { UserService } from "./services/users";
import { PasswordHasher } from "./util/password";
import { clientIp } from "./util/request";
import { registerAuthRoutes } from "./routes/auth";
import { registerUserRoutes } from "./routes/users";
import { registerInviteRoutes } from "./routes/invites";
import { registerIpRoutes } from "./routes/ip";
import { registerConnectionRoutes } from "./routes/connections";
import { registerContentRoutes } from "./routes/content";
import { registerReportRoutes } from "./routes/reports";
import { registerMediaRoutes } from "./routes/media";
import { registerSettingsRoutes } from "./routes/settings";
import { registerGroupRoutes } from "./routes/groups";
import { registerPluginRoutes } from "./routes/plugins";
import { registerAuditRoutes } from "./routes/audit";
import { registerSystemRoutes } from "./routes/system";
import { registerMetricsRoutes } from "./routes/metrics";
import { registerStreamRoutes } from "./routes/stream";
import { registerPushRoutes } from "./routes/push";
import { createNip86Handler } from "./routes/nip86";

export type { AdminApiOptions, AdminEnv, Principal } from "./context";
export { ADMIN_MIGRATIONS } from "./db";
export { hashPassword, verifyPassword } from "./util/password";
export type { ScryptParams } from "./util/password";

/** default JSON body limit for everything except /events/import */
const BODY_LIMIT = 1024 * 1024;

async function buildContext(deps: AdminApiDeps, opts: AdminApiOptions, reportListeners: Set<(r: ReportView) => void>): Promise<ApiContext> {
  const nowMs = opts.now ?? Date.now;
  const nowSec = () => Math.floor(nowMs() / 1000);
  const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, "");
  const url = new URL(publicUrl);
  const logger = deps.logger.child("admin");

  const roles = new RoleService(deps.stores.users, deps.config.admin.owners);
  const profiles = new ProfileService(deps.stores.events, nowMs);
  const users = new UserService(deps, roles, profiles);
  const reports = new ReportService(deps, profiles, users, nowSec);
  const push = new PushService(deps, roles, nowSec);
  if (opts.pushSender) push.sender = opts.pushSender;
  await push.init();
  const sessions = new SessionService(deps.stores.db, nowMs);
  // a session that simply expired takes the push devices it registered with it, like a logout does
  sessions.onExpired = (id) => (id ? push.unsubscribeSession(id) : push.pruneEndedSessions());

  const auditAs: ApiContext["auditAs"] = async (actor, ip, action, target, details = {}) => {
    const at = nowSec();
    try {
      await deps.stores.audit.record({ actor, action, target, details, ip, at });
    } catch (err) {
      logger.error("audit write failed", { action, error: String(err) });
    }
    deps.bus.emit("admin.action", { entry: { at, actor, action, target, details, ip } });
  };

  return {
    deps,
    opts,
    logger,
    nowMs,
    nowSec,
    publicUrl,
    publicOrigin: url.origin,
    rpID: url.hostname,
    secureCookies: url.protocol === "https:",
    sessions,
    roles,
    profiles,
    users,
    reports,
    push,
    credentials: new CredentialService(deps.stores.db, nowSec),
    passwords: new PasswordHasher({ params: opts.scryptParams }),
    replay: new ReplayGuard(deps.stores.db, nowMs),
    onReport(fn) {
      reportListeners.add(fn);
      return () => {
        reportListeners.delete(fn);
      };
    },
    auditAs,
    audit: (c, action, target, details) => {
      const p = c.get("principal");
      return auditAs(p?.pubkey ?? "anonymous", c.get("ip") ?? null, action, target, details);
    },
  };
}

function wireBus(ctx: ApiContext, reportListeners: Set<(r: ReportView) => void>) {
  const { bus } = ctx.deps;
  bus.on("event.accepted", ({ event }) => {
    if (event.kind === 0) ctx.profiles.invalidate(event.pubkey);
  });
  // anyone can file reports: pushes are coalesced (one per interval, the rest as a digest) and the live view skips the
  // related-report count (GET /reports computes it), so a report flood can't flood admin devices or the database
  const reportDigest = new PushCoalescer(ctx.opts.reportPushIntervalMs ?? 60_000, (n) => {
    void ctx.push.notify("reports", {
      title: `${n} more new report${n === 1 ? "" : "s"}`,
      body: "Open the reports queue to review them.",
      url: `${ctx.publicUrl}/admin/reports`,
      tag: "reports-digest",
    });
  });
  bus.on("report.created", ({ event }) => {
    void (async () => {
      try {
        const push = ctx.push.enabled && reportDigest.offer();
        if (!push && !reportListeners.size) return;
        const view = await ctx.reports.view(event, { relatedLimit: 0 });
        for (const fn of reportListeners) fn(view);
        if (!push) return;
        const target = view.targetProfile?.display_name ?? view.targetProfile?.name ?? nip19.npubEncode(view.targetPubkey || event.pubkey).slice(0, 16);
        await ctx.push.notify("reports", {
          title: `New report: ${view.type}`,
          body: `${target.slice(0, 80)}${event.content ? ` — ${event.content.slice(0, 120)}` : ""}`,
          url: `${ctx.publicUrl}/admin/reports?id=${event.id}`,
          tag: `report-${event.id}`,
        });
      } catch (err) {
        ctx.logger.warn("report notification failed", { error: String(err) });
      }
    })();
  });
  bus.on("alert", (a) => {
    void ctx.push.notify("alerts", { title: a.title, body: a.message, url: a.url ?? `${ctx.publicUrl}/admin`, tag: `alert-${a.level}` });
  });
}

export async function createAdminApi(deps: AdminApiDeps, opts: AdminApiOptions = {}): Promise<AdminApi> {
  await migrateAdmin(deps.stores.db);
  const reportListeners = new Set<(r: ReportView) => void>();
  const ctx = await buildContext(deps, opts, reportListeners);
  wireBus(ctx, reportListeners);
  // config owners need a users row so they show up in user lists and role filters
  for (const pk of ctx.roles.owners) if (!(await deps.stores.users.get(pk))) await deps.stores.users.upsert(pk, {});

  const app = new Hono<AdminEnv>();
  app.onError(createErrorHandler(ctx.logger));
  app.notFound((c) => c.json(errorBody("not found", "not_found"), 404));

  app.use("*", async (c, next) => {
    c.set("ip", clientIp(c));
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  const limiter = bodyLimit({
    maxSize: BODY_LIMIT,
    onError: () => {
      throw new HttpError(413, "request body too large", "too_large");
    },
  });
  // only the import route itself skips this cap: it streams its body and stops at importMaxBytes (default 256 MiB)
  // itself; a suffix match would also cover plugin proxy paths
  app.use("*", (c, next) => (isImportRequest(c) ? next() : limiter(c, next)));
  app.use("*", authenticate(ctx));

  registerAuthRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerMetricsRoutes(app, ctx);
  registerStreamRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerInviteRoutes(app, ctx);
  registerIpRoutes(app, ctx);
  registerContentRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerPluginRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerPushRoutes(app, ctx);

  return { app: app as unknown as Hono, nip86: await createNip86Handler(ctx) };
}

createAdminApi satisfies CreateAdminApi;
