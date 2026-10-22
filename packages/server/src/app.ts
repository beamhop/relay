import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { generateSecretKey } from "nostr-tools/pure";
import {
  EventBus,
  HookRegistry,
  createLogger,
  type AdminApi,
  type BeamhopConfig,
  type BeamhopPlugin,
  type BlossomService,
  type CreateAdminApi,
  type CreateBlossom,
  type CreateMetrics,
  type CreateRelay,
  type Logger,
  type MetricsService,
  type RelayEngine,
  type SettingsService,
  type Stores,
} from "@beamhop/sdk";
import type { ServerExtras } from "./config";
import { createPluginManager, PluginError, type ServerPluginManager } from "./plugins/manager";
import { createAssetSource, serveAdminAsset, type AssetSource } from "./static";
import { renderLanding } from "./landing";
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
  /** HTTP entry point for runtime adapters */
  fetch(req: Request, env?: Partial<ServerEnv>): Response | Promise<Response>;
  /** starts relay jobs, metrics and plugins */
  start(): Promise<void>;
  /** relay.stop → plugins teardown → metrics.stop → db.close (idempotent) */
  stop(): Promise<void>;
}

export const CLIENT_IP_HEADER = "x-beamhop-client-ip";

export const isWebSocketUpgrade = (req: Request) => (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
export const isRelayUpgrade = (req: Request) => req.method === "GET" && isWebSocketUpgrade(req) && new URL(req.url).pathname === "/";
export const isNip86 = (req: Request) => (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/nostr+json+rpc");
const acceptsNostrJson = (req: Request) => (req.headers.get("accept") ?? "").includes("application/nostr+json");

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

/** Generates and persists secrets that were not provided by config. */
async function ensureSecrets(config: BeamhopConfig, stores: Stores, logger: Logger) {
  if (!config.relaySecretKey) {
    let k = await stores.kv.get<string>("server", "relaySecretKey");
    if (!k) {
      k = Buffer.from(generateSecretKey()).toString("hex");
      await stores.kv.set("server", "relaySecretKey", k);
      logger.info("generated relay secret key (persisted in kv server/relaySecretKey)");
    }
    config.relaySecretKey = k;
  }
  if (!config.admin.sessionSecret) {
    let s = await stores.kv.get<string>("server", "sessionSecret");
    if (!s) {
      s = randomBytes(32).toString("base64url");
      await stores.kv.set("server", "sessionSecret", s);
    }
    config.admin.sessionSecret = s;
  }
}

export async function createBeamhop(inputConfig: BeamhopConfig, overrides: BeamhopOverrides = {}): Promise<Beamhop> {
  const config: BeamhopConfig = structuredClone(inputConfig);
  const extras: ServerExtras = { pluginsEnabled: [], prometheus: true, ...overrides.extras };
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const log = logger.child("server");
  const bus = new EventBus();
  const hooks = new HookRegistry();
  const f = await loadFactories(overrides.factories ?? {}, config.blossom.enabled, config.admin.enabled);

  const stores = await f.createStores(config, logger.child("storage"));
  const cleanupOnFail: (() => Promise<void>)[] = [() => stores.db.close()];
  try {
    await ensureSecrets(config, stores, log);
    const settings = await f.createSettingsService(stores, bus, logger.child("settings"));
    const base = { config, stores, settings, hooks, bus };
    const relay = await f.createRelay({ ...base, logger: logger.child("relay") });
    const blossom = config.blossom.enabled ? await f.createBlossom({ ...base, logger: logger.child("blossom") }) : undefined;
    const metrics = await f.createMetrics({ ...base, logger: logger.child("metrics"), relay, blossom });
    const plugins = createPluginManager({
      ...base,
      logger,
      relay,
      blossom,
      metrics,
      defaultEnabled: extras.pluginsEnabled,
      plugins: overrides.plugins,
      autoDiscoverNpm: overrides.autoDiscoverNpm,
      cwd: overrides.cwd,
    });
    const adminApi = config.admin.enabled && f.createAdminApi
      ? await f.createAdminApi({ ...base, logger: logger.child("admin"), relay, blossom, metrics, plugins, version: VERSION })
      : undefined;
    const assets = overrides.assets ?? createAssetSource(config.admin.uiDir);
    if (config.admin.enabled) log.info(assets.kind === "none" ? "admin UI not built — serving placeholder at /admin" : `admin UI served from ${assets.location}`);

    const app = buildApp({ config, extras, settings, relay, blossom, metrics, plugins, adminApi, assets, renderPrometheus: f.renderPrometheus, logger: log });

    let started = false;
    let stopping: Promise<void> | undefined;
    const beamhop: Beamhop = {
      config, extras, logger, bus, hooks, stores, settings, relay, blossom, metrics, plugins, adminApi, assets, app, version: VERSION,
      fetch(req, env) {
        const ip = env?.ip ?? "127.0.0.1";
        try {
          req.headers.set(CLIENT_IP_HEADER, ip);
        } catch {
          const h = new Headers(req.headers);
          h.set(CLIENT_IP_HEADER, ip);
          req = new Request(req, { headers: h });
        }
        return app.fetch(req, { ...makeEnv(ip), ...env } as ServerEnv);
      },
      async start() {
        if (started) return;
        started = true;
        await relay.start();
        await metrics.start();
        await plugins.start();
      },
      stop() {
        stopping ??= (async () => {
          const step = async (name: string, fn: () => Promise<void> | void) => {
            try {
              await fn();
            } catch (err) {
              log.error(`shutdown: ${name} failed`, { error: (err as Error).message });
            }
          };
          await step("relay", () => relay.stop());
          await step("plugins", () => plugins.stop());
          await step("metrics", () => metrics.stop());
          await step("db", () => stores.db.close());
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
}

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
    return d.adminApi.nip86(c.req.raw);
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

  // Prometheus scrape endpoint
  if (d.extras.prometheus && d.renderPrometheus) {
    const render = d.renderPrometheus;
    app.get("/metrics", async (c) => {
      if (d.extras.metricsToken && c.req.header("authorization") !== `Bearer ${d.extras.metricsToken}`) {
        return c.text("unauthorized", 401, { "www-authenticate": 'Bearer realm="metrics"' });
      }
      return c.body(await render(d.metrics), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
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
    return c.html(html, 200, { "cache-control": "no-cache", vary: "Accept" });
  });

  app.notFound((c) => c.text("not found", 404));
  return app;
}
