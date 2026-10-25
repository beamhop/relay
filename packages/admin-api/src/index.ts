import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { nip19 } from "nostr-tools";
import type { AdminApi, AdminApiDeps, CreateAdminApi, NostrEvent, ReportView, StopContext } from "@beamhop/sdk";
import { TaskTracker } from "@beamhop/sdk";
import type { AdminApiOptions, AdminEnv, ApiContext } from "./context";
import { migrateAdmin } from "./db";
import { createErrorHandler, errorBody, HttpError } from "./errors";
import { authenticate, isImportRequest } from "./middleware/auth";
import { CredentialService } from "./services/credentials";
import { ModerationService } from "./services/moderation";
import { ProfileService } from "./services/profiles";
import { KeyedPushCoalescer, PushCoalescer, PushService } from "./services/push";
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
  const push = new PushService(deps, roles, nowSec);
  if (opts.pushSender) push.sender = opts.pushSender;
  await push.init();
  const sessions = new SessionService(deps.stores.db, nowMs);
  // a session that simply expired takes the push devices it registered with it, like a logout does
  sessions.onExpired = (id) => (id ? push.unsubscribeSession(id) : push.pruneEndedSessions());
  const credentials = new CredentialService(deps.stores.db, nowSec);
  const moderation = new ModerationService(deps, users, sessions, push, credentials);
  const reports = new ReportService(deps, profiles, users, moderation, nowSec);

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
    moderation,
    credentials,
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

/**
 * Bus wiring for report indexing and pushes. Everything it starts in the background is tracked in `tasks`; returns the
 * shutdown: listeners off, pending digests dropped (deliberately: a digest sent while the relay goes down would only
 * point admins at a dashboard that is unavailable — the reports themselves stay in the queue).
 */
function wireBus(ctx: ApiContext, reportListeners: Set<(r: ReportView) => void>, tasks: TaskTracker): () => void {
  const { bus } = ctx.deps;
  const offs: (() => void)[] = [];
  const notify = (topic: Parameters<ApiContext["push"]["notify"]>[0], payload: Parameters<ApiContext["push"]["notify"]>[1]) =>
    void tasks.track(`admin push ${topic}`, ctx.push.notify(topic, payload));
  offs.push(
    bus.on("event.accepted", ({ event }) => {
      if (event.kind === 0) ctx.profiles.invalidate(event.pubkey);
    }),
  );
  // deleted reports leave the queue: by id when the deletion names them, else (vanish, retention, bulk deletes) by a sweep
  const forgetDeleted = (ids: string[]) =>
    void tasks.track(
      "report index cleanup",
      (ids.length ? ctx.reports.forget(ids) : ctx.reports.sweep()).catch((err) => ctx.logger.warn("report index cleanup failed", { error: String(err) })),
    );
  offs.push(bus.on("event.deleted", ({ ids }) => forgetDeleted(ids)));
  offs.push(bus.on("user.deleted", () => forgetDeleted([])));
  // anyone can file reports: pushes are coalesced (one per interval, the rest as a digest) and the live view skips the
  // related-report count (GET /reports computes it), so a report flood can't flood admin devices or the database
  const reportDigest = new PushCoalescer(ctx.opts.reportPushIntervalMs ?? 60_000, (n) => {
    notify("reports", {
      title: `${n} more new report${n === 1 ? "" : "s"}`,
      body: "Open the reports queue to review them.",
      url: `${ctx.publicUrl}/admin/reports`,
      tag: "reports-digest",
    });
  });
  const onReport = async (event: NostrEvent) => {
    try {
      await ctx.reports.index([event]);
    } catch (err) {
      // a later read picks it up (ReportService catch-up) as long as it isn't older than the newest indexed report
      ctx.logger.warn("report indexing failed", { error: String(err) });
    }
    try {
      const push = ctx.push.enabled && reportDigest.offer();
      if (!push && !reportListeners.size) return;
      const view = await ctx.reports.view(event, { related: false });
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
  };
  offs.push(bus.on("report.created", ({ event }) => void tasks.track("report notification", onReport(event))));
  // alerts too can come in floods (a word filter matching every event of a spam wave): per level and title, the first
  // is pushed at once and the rest of the interval follow as one "N more" digest
  const alertDigest = new KeyedPushCoalescer(ctx.opts.alertPushIntervalMs ?? 60_000, (key, n) => {
    const { level, title } = JSON.parse(key) as { level: string; title: string };
    notify("alerts", {
      title: `${n} more: ${title}`.slice(0, 200),
      body: `${n} more alert${n === 1 ? "" : "s"} like this. Open the dashboard for details.`,
      url: `${ctx.publicUrl}/admin`,
      tag: `alert-${level}`,
    });
  });
  offs.push(
    bus.on("alert", (a) => {
      if (!ctx.push.enabled || !alertDigest.offer(JSON.stringify({ level: a.level, title: a.title }))) return;
      notify("alerts", { title: a.title, body: a.message, url: a.url ?? `${ctx.publicUrl}/admin`, tag: `alert-${a.level}` });
    }),
  );
  return () => {
    for (const off of offs.splice(0)) off();
    reportDigest.dispose();
    alertDigest.dispose();
  };
}

export async function createAdminApi(deps: AdminApiDeps, opts: AdminApiOptions = {}): Promise<AdminApi> {
  await migrateAdmin(deps.stores.db);
  const reportListeners = new Set<(r: ReportView) => void>();
  const ctx = await buildContext(deps, opts, reportListeners);
  const tasks = deps.tasks ?? new TaskTracker({ logger: ctx.logger });
  const unwire = wireBus(ctx, reportListeners, tasks);
  // one-time fill of the report index from the reports already stored (retried at the next start if it fails)
  await ctx.reports.backfill().catch((err) => ctx.logger.error("report index backfill failed", { error: String(err) }));
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
  const streams = registerStreamRoutes(app, ctx);
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

  /** Live streams end (dashboards reconnect to another instance or once it is back), pushes being sent get to finish. */
  const shutdown = async (sc: StopContext) => {
    unwire();
    streams.closeAll();
    await tasks.idle(sc.signal);
  };
  return { app: app as unknown as Hono, nip86: await createNip86Handler(ctx), drain: shutdown, stop: shutdown };
}

createAdminApi satisfies CreateAdminApi;
