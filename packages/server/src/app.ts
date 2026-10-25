import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { generateSecretKey } from "nostr-tools/pure";
import {
  EventBus,
  HookRegistry,
  TaskTracker,
  createLogger,
  type AdminApi,
  type BeamhopConfig,
  type BeamhopPlugin,
  type BlossomService,
  type BusEvents,
  type CreateAdminApi,
  type CreateBlossom,
  type CreateMetrics,
  type CreateRelay,
  type HookIncident,
  type Logger,
  type MetricsService,
  type RelayEngine,
  type SettingsService,
  type Stores,
} from "@beamhop/sdk";
import type { ServerExtras } from "./config";
import { createPluginManager, PluginError, type ServerPluginManager } from "./plugins/manager";
import { PROMETHEUS_CONTENT_TYPE } from "@beamhop/metrics";
import { createAssetSource, serveAdminAsset, type AssetSource } from "./static";
import { proxyMatcher, type RunningServer } from "./runtime/common";
import { Lifecycle, runShutdown, shutdownBudgets } from "./lifecycle";
import { LANDING_CSP, renderLanding } from "./landing";
import { VERSION } from "./version";

export interface BeamhopFactories {
  createStores(config: BeamhopConfig, logger: Logger): Promise<Stores>;
  createSettingsService(stores: Stores, bus: EventBus, logger?: Logger): Promise<SettingsService>;
  createRelay: CreateRelay;
  createBlossom: CreateBlossom;
  createMetrics: CreateMetrics;
  createAdminApi: CreateAdminApi;
  renderPrometheus(metrics: MetricsService): string | Promise<string>;
}

export interface BeamhopOverrides {
  factories?: Partial<BeamhopFactories>;
  extras?: Partial<ServerExtras>;
  logger?: Logger;
  /** inline plugins (skips filesystem discovery) */
  plugins?: { plugin: BeamhopPlugin; source?: "local" | "npm"; root?: string }[];
  autoDiscoverNpm?: boolean;
  /** custom admin-ui asset source */
  assets?: AssetSource;
  cwd?: string;
}

/** Hono bindings passed by runtime adapters (compatible with hono/bun and @hono/node-server getConnInfo). */
export interface ServerEnv {
  ip: string;
  requestIP(req: Request): { address: string; family: string; port: number } | null;
  incoming?: unknown;
  outgoing?: unknown;
  [k: string]: unknown;
}

export interface Beamhop {
  config: BeamhopConfig;
  extras: ServerExtras;
  logger: Logger;
  bus: EventBus;
  hooks: HookRegistry;
  stores: Stores;
  settings: SettingsService;
  relay: RelayEngine;
  blossom?: BlossomService;
  metrics: MetricsService;
  plugins: ServerPluginManager;
  adminApi?: AdminApi;
  assets: AssetSource;
  app: Hono<{ Bindings: ServerEnv }>;
  version: string;
  /** background work started off request paths (bus handlers, report filing, pushes, prunes) */
  tasks: TaskTracker;
  /** phase (starting → ready → draining → stopping → stopped) and in-flight HTTP requests */
  lifecycle: Lifecycle;
  /** HTTP entry point for runtime adapters (counts in-flight requests; 503 while shutting down) */
  fetch(req: Request, env?: Partial<ServerEnv>): Response | Promise<Response>;
  /** starts relay jobs, metrics and plugins */
  start(): Promise<void>;
  /**
   * Graceful shutdown (idempotent; see runShutdown): drain in-flight requests, queued EVENTs, jobs and background
   * tasks → relay.stop (close handshakes) → plugins teardown → admin/blossom/metrics → db.close → `server` force-stop.
   * Bounded by `config.server.shutdownTimeoutMs` (or `timeoutMs`).
   */
  stop(opts?: { reason?: string; server?: RunningServer; timeoutMs?: number }): Promise<void>;
}

export const isWebSocketUpgrade = (req: Request) => (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
export const isRelayUpgrade = (req: Request) => req.method === "GET" && isWebSocketUpgrade(req) && new URL(req.url).pathname === "/";
export const isNip86 = (req: Request) => (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/nostr+json+rpc");
const acceptsNostrJson = (req: Request) => (req.headers.get("accept") ?? "").includes("application/nostr+json");

/** Peers allowed to read /metrics without a token. */
const LOOPBACK = ["127.0.0.0/8", "::1/128"];

/** Headers a reverse proxy / CDN adds to requests it relays. */
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip", "fly-client-ip"];

export function makeEnv(ip: string, extra?: Record<string, unknown>): ServerEnv {
  return { ...extra, ip, requestIP: () => ({ address: ip, family: ip.includes(":") ? "IPv6" : "IPv4", port: 0 }) };
}

/**
 * Wraps a sub-app so unmatched requests can fall through to the next handler.
 * Requests that no sub-app route handled (or that called c.notFound()) yield `undefined`.
 */
export function fallthrough(sub: Hono<any>) {
  const UNMATCHED = "x-beamhop-unmatched";
  const wrapper = new Hono();
  wrapper.route("/", sub);
  wrapper.notFound(() => new Response(null, { status: 404, headers: { [UNMATCHED]: "1" } }));
  return async (req: Request, env: unknown): Promise<Response | undefined> => {
    const res = await wrapper.fetch(req, env as never);
    return res.status === 404 && res.headers.get(UNMATCHED) ? undefined : res;
  };
}

async function loadFactories(over: Partial<BeamhopFactories>, needBlossom: boolean, needAdmin: boolean): Promise<BeamhopFactories> {
  const f = { ...over } as Partial<BeamhopFactories>;
  if (!f.createStores || !f.createSettingsService) {
    const storage = await import("@beamhop/storage");
    f.createStores ??= (storage as unknown as Pick<BeamhopFactories, "createStores">).createStores;
    f.createSettingsService ??= (storage as unknown as Pick<BeamhopFactories, "createSettingsService">).createSettingsService;
  }
  f.createRelay ??= ((await import("@beamhop/core")) as unknown as { createRelay: CreateRelay }).createRelay;
  if (needBlossom) f.createBlossom ??= ((await import("@beamhop/blossom")) as unknown as { createBlossom: CreateBlossom }).createBlossom;
  if (!f.createMetrics || !f.renderPrometheus) {
    const m = (await import("@beamhop/metrics")) as unknown as Pick<BeamhopFactories, "createMetrics" | "renderPrometheus">;
    f.createMetrics ??= m.createMetrics;
    f.renderPrometheus ??= m.renderPrometheus;
  }
  if (needAdmin) f.createAdminApi ??= ((await import("@beamhop/admin-api")) as unknown as { createAdminApi: CreateAdminApi }).createAdminApi;
  for (const k of ["createStores", "createSettingsService", "createRelay", "createMetrics"] as const) {
    if (typeof f[k] !== "function") throw new Error(`missing factory ${k} (is the package built/complete?)`);
  }
  return f as BeamhopFactories;
}

/**
 * Generates and persists secrets that were not provided by config. The relay key is written insert-if-absent and
 * read back, so instances booting together on one database all end up with the same key.
 */
export async function ensureSecrets(config: BeamhopConfig, stores: Stores, logger: Logger) {
  if (config.relaySecretKey) return;
  const NS = "server";
  const KEY = "relaySecretKey";
  let k = await stores.kv.get<string>(NS, KEY);
  if (!k) {
    const fresh = Buffer.from(generateSecretKey()).toString("hex");
    if (stores.kv.setIfAbsent) {
      if (await stores.kv.setIfAbsent(NS, KEY, fresh)) logger.info("generated relay secret key (persisted in kv server/relaySecretKey)");
      k = await stores.kv.get<string>(NS, KEY);
    } else {
      await stores.kv.set(NS, KEY, fresh);
      logger.info("generated relay secret key (persisted in kv server/relaySecretKey)");
      k = fresh;
    }
    if (!k) throw new Error("relay secret key could not be stored in kv server/relaySecretKey");
  }
  config.relaySecretKey = k;
}

/** Constant-time string comparison (length is not secret). */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function createBeamhop(inputConfig: BeamhopConfig, overrides: BeamhopOverrides = {}): Promise<Beamhop> {
  const config: BeamhopConfig = structuredClone(inputConfig);
  const extras: ServerExtras = { pluginsEnabled: [], prometheus: true, ...overrides.extras };
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const log = logger.child("server");
  const tasks = new TaskTracker({ logger: logger.child("tasks") });
  const lifecycle = new Lifecycle();
  const bus = new EventBus({ logger: logger.child("bus"), tasks });
  const hooks = new HookRegistry();
  const f = await loadFactories(overrides.factories ?? {}, config.blossom.enabled, config.admin.enabled);

  const stores = await f.createStores(config, logger.child("storage"));
  const cleanupOnFail: (() => Promise<void>)[] = [() => stores.db.close()];
  try {
    await ensureSecrets(config, stores, log);
    const settings = await f.createSettingsService(stores, bus, logger.child("settings"));
    const base = { config, stores, settings, hooks, bus, tasks };
    const relay = await f.createRelay({ ...base, logger: logger.child("relay") });
    const blossom = config.blossom.enabled ? await f.createBlossom({ ...base, logger: logger.child("blossom") }) : undefined;
    const metrics = await f.createMetrics({ ...base, logger: logger.child("metrics"), relay, blossom });
    hooks.onIncident(hookIncidentReporter({ bus, metrics, logger: logger.child("hooks") }));
    const plugins = createPluginManager({
      ...base,
      logger,
      relay,
      blossom,
      metrics,
      defaultEnabled: extras.pluginsEnabled,
      plugins: overrides.plugins,
      autoDiscoverNpm: overrides.autoDiscoverNpm ?? config.plugins.autoDiscoverNpm,
      cwd: overrides.cwd,
    });
    const adminApi = config.admin.enabled && f.createAdminApi
      ? await f.createAdminApi({ ...base, logger: logger.child("admin"), relay, blossom, metrics, plugins, version: VERSION })
      : undefined;
    const assets = overrides.assets ?? createAssetSource(config.admin.uiDir);
    if (config.admin.enabled) log.info(assets.kind === "none" ? "admin UI not built — serving placeholder at /admin" : `admin UI served from ${assets.location}`);
    if (extras.prometheus && !extras.metricsToken) {
      log.warn(
        config.server.trustProxy
          ? "/metrics is disabled: behind a reverse proxy (server.trustProxy) it needs BEAMHOP_METRICS_TOKEN, since proxied internet clients arrive from loopback too"
          : "/metrics has no BEAMHOP_METRICS_TOKEN: it is only served to loopback clients reaching beamhop directly; set a token to scrape it from anywhere else (e.g. Prometheus in another container)",
      );
    }

    const app = buildApp({ config, extras, settings, relay, blossom, metrics, plugins, adminApi, assets, renderPrometheus: f.renderPrometheus, logger: log, version: VERSION, lifecycle, checkHealth: () => stores.db.get("SELECT 1 AS ok") });

    let started = false;
    let stopping: Promise<void> | undefined;
    const beamhop: Beamhop = {
      config, extras, logger, bus, hooks, stores, settings, relay, blossom, metrics, plugins, adminApi, assets, app, version: VERSION, tasks, lifecycle,
      fetch(req, env) {
        const ip = env?.ip ?? "127.0.0.1";
        return lifecycle.handle(req, () => app.fetch(req, { ...makeEnv(ip), ...env } as ServerEnv));
      },
      async start() {
        if (started) return;
        started = true;
        await relay.start();
        await metrics.start();
        await plugins.start();
        if (lifecycle.phase === "starting") lifecycle.phase = "ready";
        // raised while settings loaded, before admin/metrics/plugin listeners existed: emit it again now
        const startupAlert = (settings as Partial<{ takeStartupAlert(): BusEvents["alert"] | undefined }>).takeStartupAlert?.();
        if (startupAlert) bus.emit("alert", startupAlert);
      },
      stop(opts = {}) {
        stopping ??= (async () => {
          const totalMs = opts.timeoutMs ?? config.server.shutdownTimeoutMs;
          const budget = shutdownBudgets(totalMs);
          const server = opts.server;
          await runShutdown({
            reason: opts.reason ?? "shutdown",
            totalMs,
            logger: log,
            lifecycle,
            steps: [
              {
                // in parallel, while probes still answer (503 "draining"): no new work, finish what is in flight
                name: "drain",
                phase: "draining",
                ms: budget.drain,
                run: {
                  http: (sc) => lifecycle.idle(sc.signal),
                  relay: relay.drain && ((sc) => relay.drain!(sc)),
                  admin: adminApi?.drain && ((sc) => adminApi.drain!(sc)),
                  blossom: blossom?.drain && ((sc) => blossom.drain!(sc)),
                  plugins: (sc) => plugins.drain(sc),
                  tasks: (sc) => tasks.idle(sc.signal),
                },
              },
              {
                // NOTICE + close 1001 on every socket, then a moment for the close handshakes
                name: "relay",
                phase: "stopping",
                ms: budget.relay,
                run: {
                  relay: async (sc) => {
                    await relay.stop(sc);
                    server?.stopAccepting();
                    await server?.settle(sc.signal);
                  },
                },
              },
              { name: "plugins", ms: budget.plugins, run: { plugins: () => plugins.stop() } },
              {
                name: "services",
                ms: budget.services,
                run: {
                  admin: adminApi?.stop && ((sc) => adminApi.stop!(sc)),
                  blossom: blossom?.stop && ((sc) => blossom.stop!(sc)),
                  metrics: () => metrics.stop(),
                },
              },
              // last: whatever is still running past its deadline finds the database closed, not half-closed
              {
                name: "db",
                run: {
                  db: () => {
                    tasks.close();
                    return stores.db.close();
                  },
                },
              },
              { name: "http", run: { http: server && (() => server.stop()) } },
            ],
          });
        })();
        return stopping;
      },
    };
    return beamhop;
  } catch (err) {
    for (const fn of cleanupOnFail) await fn().catch(() => {});
    throw err;
  }
}

/** One log line / alert per key per this window; the rest are counted and reported with the next one. */
const INCIDENT_WINDOW_MS = 60_000;

/**
 * Hook timeouts and errors: every one is counted (`hook_incidents_total`); logs are coalesced per (owner, kind,
 * type) and timeouts raise a bus alert at most once a minute per owner.
 */
export function hookIncidentReporter(d: { bus: EventBus; metrics: Pick<MetricsService, "counter">; logger: Logger; now?: () => number }) {
  const counter = d.metrics.counter("hook_incidents_total", "plugin hook timeouts and errors");
  const now = d.now ?? Date.now;
  const logged = new Map<string, { at: number; suppressed: number }>();
  const alerted = new Map<string, { at: number; suppressed: number }>();
  /** returns how many were swallowed since the last pass, or -1 while still inside the window */
  const pass = (m: Map<string, { at: number; suppressed: number }>, key: string) => {
    const t = now();
    const prev = m.get(key);
    if (prev && t - prev.at < INCIDENT_WINDOW_MS) {
      prev.suppressed++;
      return -1;
    }
    m.set(key, { at: t, suppressed: 0 });
    return prev?.suppressed ?? 0;
  };
  return (i: HookIncident) => {
    counter.add(1, { kind: i.kind, owner: i.owner, type: i.type });
    const effect =
      i.type === "error" ? "the request was refused"
      : i.kind === "write" ? "the event was processed without its verdict"
      : "the request was refused";
    const what = i.type === "timeout" ? `did not answer within ${i.timeoutMs} ms` : "failed";
    const logSkipped = pass(logged, `${i.owner}|${i.kind}|${i.type}`);
    if (logSkipped >= 0) {
      d.logger.warn(`${i.kind} hook of ${i.owner} ${what}; ${effect}`, {
        ...(i.error !== undefined ? { error: i.error } : {}),
        ...(logSkipped ? { suppressedSinceLastLog: logSkipped } : {}),
      });
    }
    if (i.type !== "timeout") return;
    const alertSkipped = pass(alerted, i.owner);
    if (alertSkipped < 0) return;
    d.bus.emit("alert", {
      level: "warning",
      title: `Plugin hook timed out: ${i.owner}`,
      message: `A ${i.kind} hook of ${i.owner} did not answer within ${i.timeoutMs} ms; ${effect}.` + (alertSkipped ? ` ${alertSkipped} more timeout(s) since the last alert.` : ""),
    });
  };
}

interface AppDeps {
  config: BeamhopConfig;
  extras: ServerExtras;
  settings: SettingsService;
  relay: RelayEngine;
  blossom?: BlossomService;
  metrics: MetricsService;
  plugins: ServerPluginManager;
  adminApi?: AdminApi;
  assets: AssetSource;
  renderPrometheus?: (m: MetricsService) => string | Promise<string>;
  logger: Logger;
  version?: string;
  /** throws when the server isn't ready (e.g. database unreachable) */
  checkHealth?: () => Promise<unknown>;
  /** phase for /health (absent: always "ready") */
  lifecycle?: Pick<Lifecycle, "phase">;
}

/** /health answers 503 when the database check takes longer than this (a hung pool must not hang the probe) */
const HEALTH_TIMEOUT_MS = 2_000;

/** Root router — order follows docs/ARCHITECTURE.md "Request routing". */
export function buildApp(d: AppDeps): Hono<{ Bindings: ServerEnv }> {
  const app = new Hono<{ Bindings: ServerEnv }>();
  const relayHttp = fallthrough(d.relay.http);
  const blossomApp = d.blossom ? fallthrough(d.blossom.app) : undefined;

  app.onError((err, c) => {
    if (err instanceof PluginError) return c.json({ error: err.message }, err.status as 400);
    d.logger.error(`unhandled error on ${c.req.method} ${c.req.path}`, { error: err.message, stack: err.stack });
    return c.json({ error: "internal server error" }, 500);
  });

  // 1. websocket upgrade on "/" is handled by the runtime adapter before reaching Hono
  app.get("/", async (c, next) => {
    if (isWebSocketUpgrade(c.req.raw)) return c.text("WebSocket upgrade must be handled by the runtime adapter", 426);
    await next();
  });

  // 2. NIP-86 relay management API
  app.post("/", async (c, next) => {
    if (!isNip86(c.req.raw)) return next();
    if (!d.adminApi) return c.json({ error: "relay management API disabled" }, 404);
    return d.adminApi.nip86(c.req.raw, c.env);
  });

  // 3. relay HTTP (NIP-11, NIP-05). GET / goes to the relay only when NIP-11 JSON is requested.
  app.use("*", async (c, next) => {
    const req = c.req.raw;
    if (c.req.path === "/" && (req.method === "GET" || req.method === "HEAD") && !acceptsNostrJson(req)) return next();
    if (c.req.path.startsWith("/admin/")) return next();
    const res = await relayHttp(req, c.env);
    if (res) return res;
    await next();
  });

  // 4. admin API + admin UI
  if (d.adminApi) {
    app.route("/admin/api", d.adminApi.app);
    app.all("/admin/api", (c) => c.json({ error: "not found" }, 404));
    app.all("/admin/api/*", (c) => c.json({ error: "not found" }, 404));
  }
  if (d.config.admin.enabled) {
    app.get("/admin/plugins-ui/:file", (c) => {
      const name = c.req.param("file").replace(/\.m?js$/, "");
      return d.plugins.uiBundle(name) ?? c.text("not found", 404);
    });
    app.on(["GET", "HEAD"], "/admin", (c) => c.redirect("/admin/" + (new URL(c.req.url).search || ""), 301));
    app.on(["GET", "HEAD"], "/admin/*", async (c) => {
      const res = await serveAdminAsset(d.assets, c.req.path.slice("/admin/".length), c.req.raw);
      return res ?? c.text("method not allowed", 405);
    });
  }

  // 5. plugin public routes
  const pluginRoute = async (c: Context<{ Bindings: ServerEnv }>) => {
    const res = await d.plugins.handlePublic(c.req.param("name")!, c.req.raw, c.env);
    return res ?? c.json({ error: "plugin not found" }, 404);
  };
  app.all("/plugins/:name", pluginRoute);
  app.all("/plugins/:name/*", pluginRoute);

  // liveness: the process answers (Docker HEALTHCHECK — a restart wouldn't fix a slow database, and must not cut a
  // graceful shutdown short)
  app.get("/health/live", (c) => c.json({ ok: true, status: d.lifecycle?.phase ?? "ready", version: d.version }, 200, { "cache-control": "no-store" }));

  // readiness (load balancers): 503 while starting or shutting down, or when the database doesn't answer in time
  app.get("/health", async (c) => {
    const status = d.lifecycle?.phase ?? "ready";
    if (status !== "ready") return c.json({ ok: false, status }, 503, { "cache-control": "no-store", "retry-after": "5" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(d.checkHealth?.()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`database check took longer than ${HEALTH_TIMEOUT_MS} ms`)), HEALTH_TIMEOUT_MS);
        }),
      ]);
      return c.json({ ok: true, status, version: d.version }, 200, { "cache-control": "no-store" });
    } catch (err) {
      // the probe is public: log the cause, don't leak driver errors (hosts, paths, credentials in DSNs)
      d.logger.warn("health check failed", { error: (err as Error)?.message ?? String(err) });
      return c.json({ ok: false, status, error: "unavailable" }, 503, { "cache-control": "no-store" });
    } finally {
      clearTimeout(timer);
    }
  });

  // Prometheus scrape endpoint
  if (d.extras.prometheus && d.renderPrometheus) {
    const render = d.renderPrometheus;
    const loopback = proxyMatcher(LOOPBACK);
    app.get("/metrics", async (c) => {
      if (d.extras.metricsToken) {
        if (!safeEqual(c.req.header("authorization") ?? "", `Bearer ${d.extras.metricsToken}`)) {
          return c.text("unauthorized", 401, { "www-authenticate": 'Bearer realm="metrics"' });
        }
      } else if (d.config.server.trustProxy) {
        // behind a reverse proxy, a proxy on this host relays internet clients from loopback — with no forwarding
        // header at all in nginx's default proxy_pass — so a loopback peer proves nothing: a token is required
        return c.text("forbidden: behind a reverse proxy (server.trustProxy), /metrics requires BEAMHOP_METRICS_TOKEN", 403);
      } else {
        // No token, no proxy: only a scraper on this host, talking to beamhop directly. Private-network peers don't
        // qualify: NAT and L4 hops (Docker's userland proxy for IPv6 clients, a Kubernetes Service, nginx without
        // forwarding headers, HAProxy in TCP mode) make internet clients arrive from private addresses.
        const ip = (c.env as ServerEnv | undefined)?.ip ?? "unknown";
        if (!loopback(ip) || FORWARDING_HEADERS.some((h) => c.req.header(h) !== undefined)) {
          return c.text("forbidden: without BEAMHOP_METRICS_TOKEN, /metrics is only served to loopback clients", 403);
        }
      }
      return c.body(await render(d.metrics), 200, { "content-type": PROMETHEUS_CONTENT_TYPE, "cache-control": "no-store" });
    });
  }

  // 6. blossom
  if (blossomApp) {
    app.use("*", async (c, next) => {
      const res = await blossomApp(c.req.raw, c.env);
      if (res) return res;
      await next();
    });
  }

  // 7. landing page
  app.on(["GET", "HEAD"], "/", (c) => {
    let nip11: Record<string, unknown> = {};
    try {
      nip11 = d.relay.nip11();
    } catch {}
    const html = renderLanding({ settings: d.settings.get(), publicUrl: d.config.server.publicUrl, nip11, version: VERSION, blossom: !!d.blossom, admin: d.config.admin.enabled });
    return c.html(html, 200, { "cache-control": "no-cache", vary: "Accept", "content-security-policy": LANDING_CSP, "x-content-type-options": "nosniff" });
  });

  app.notFound((c) => c.text("not found", 404));
  return app;
}
