import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type {
  BeamhopConfig,
  BeamhopPlugin,
  BlossomService,
  BusEvents,
  EventBus,
  HookRegistry,
  Logger,
  MetricsService,
  PluginContext,
  PluginInfo,
  PluginManager,
  RelayEngine,
  SettingsService,
  Stores,
} from "@beamhop/sdk";
import { discoverPlugins, importSpecifier, type DiscoveredPlugin } from "./discovery";
import { fileBody } from "../static";
import { redactSecrets } from "./redact";

export interface PluginManagerDeps {
  config: BeamhopConfig;
  stores: Stores;
  settings: SettingsService;
  hooks: HookRegistry;
  bus: EventBus;
  logger: Logger;
  relay: RelayEngine;
  blossom?: BlossomService;
  metrics: MetricsService;
  /** plugin names enabled on first boot when no persisted state exists */
  defaultEnabled?: string[];
  /** skip filesystem discovery and use these instead (tests, embedding) */
  plugins?: { plugin: BeamhopPlugin; source?: "local" | "npm"; root?: string }[];
  /** auto-discover beamhop-plugin-* in node_modules (default true) */
  autoDiscoverNpm?: boolean;
  cwd?: string;
}

interface Entry {
  name: string;
  discovered?: DiscoveredPlugin;
  plugin?: BeamhopPlugin;
  source: "local" | "npm";
  root: string;
  status: "running" | "disabled" | "error";
  error?: string;
  /** persisted desired state */
  enabled: boolean;
  settingsValue?: Record<string, unknown>;
  settingsListeners: Set<(s: Record<string, unknown>) => void>;
  cleanups: (() => void)[];
  http?: Hono;
  adminHttp?: Hono;
  migrated: boolean;
  /** serializes enable/disable so concurrent calls can't run setup twice */
  transition?: Promise<void>;
}

export interface ServerPluginManager extends PluginManager {
  /** Discover + load all plugins and enable the ones marked enabled. */
  start(): Promise<void>;
  /** Teardown all running plugins without changing their persisted enabled state. */
  stop(): Promise<void>;
  /** Discover + load plugins and apply their database migrations without enabling them. Returns how many migrated. */
  migrate(): Promise<number>;
  /** Dispatch a public request for /plugins/:name/* (path rewritten relative to the plugin). */
  handlePublic(name: string, req: Request, env?: unknown): Promise<Response | undefined>;
  /** Serve the admin-ui bundle of a plugin (GET /admin/plugins-ui/:name.js). */
  uiBundle(name: string): Response | undefined;
  get(name: string): PluginInfo | undefined;
}

const KV_NS = "plugins";
const OWNER = (name: string) => `plugin:${name}`;

export class PluginError extends Error {
  constructor(message: string, readonly status = 400, readonly details?: unknown) {
    super(message);
  }
}

function validatePluginShape(mod: unknown): BeamhopPlugin {
  const m = mod as Record<string, unknown> | undefined;
  const p = (m && typeof m === "object" && "default" in m ? m.default : m) as Partial<BeamhopPlugin> | undefined;
  if (!p || typeof p !== "object") throw new Error("module has no default export");
  if (typeof p.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(p.name)) throw new Error("plugin.name must be a url-safe string");
  if (typeof p.version !== "string") throw new Error("plugin.version must be a string");
  if (typeof p.setup !== "function") throw new Error("plugin.setup must be a function");
  if (p.teardown !== undefined && typeof p.teardown !== "function") throw new Error("plugin.teardown must be a function");
  if (p.settings !== undefined && typeof (p.settings as { safeParse?: unknown }).safeParse !== "function") throw new Error("plugin.settings must be a zod schema");
  if (p.migrations !== undefined && !Array.isArray(p.migrations)) throw new Error("plugin.migrations must be an array");
  if (p.ui !== undefined && typeof p.ui !== "string") throw new Error("plugin.ui must be a path string");
  return p as BeamhopPlugin;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Config handed to plugins with server secrets removed. Plugins are trusted in-process code (they get the db),
 * but there's no reason to hand them keys they don't need, and it keeps secrets out of plugin logs/dumps.
 */
export function redactConfigForPlugins(config: BeamhopConfig): Readonly<BeamhopConfig> {
  const c = structuredClone(config);
  delete c.relaySecretKey;
  delete c.admin.sessionSecret;
  if (c.admin.vapid) c.admin.vapid = { ...c.admin.vapid, privateKey: "" };
  if (c.blossom.s3) c.blossom.s3 = { ...c.blossom.s3, accessKeyId: "", secretAccessKey: "" };
  if (c.database.postgresUrl) {
    try {
      const u = new URL(c.database.postgresUrl);
      u.password = "";
      c.database.postgresUrl = u.toString();
    } catch {
      c.database.postgresUrl = "";
    }
  }
  if (Object.keys(c.metrics.otel.headers).length) c.metrics.otel.headers = {};
  return Object.freeze(c);
}

/** Rewrites `/anything/<name>/rest` → `/rest` keeping the query string. */
function rewriteRequest(req: Request, name: string, marker: string): Request {
  const url = new URL(req.url);
  const path = url.pathname;
  const needle = `${marker}/${name}`;
  let idx = path.indexOf(needle + "/");
  if (idx < 0 && path.endsWith(needle)) idx = path.length - needle.length;
  if (idx < 0) {
    idx = path.indexOf(`/${name}/`);
    url.pathname = idx < 0 ? "/" : path.slice(idx + name.length + 1);
  } else {
    url.pathname = path.slice(idx + needle.length) || "/";
  }
  return new Request(url, req);
}

/** Public plugin routes are anonymous: drop identity headers a client could forge to look like the admin proxy. */
function stripAdminIdentity(req: Request): Request {
  const spoofed = [...req.headers.keys()].filter((h) => h.toLowerCase().startsWith("x-beamhop-admin-"));
  if (!spoofed.length) return req;
  const headers = new Headers(req.headers);
  for (const h of spoofed) headers.delete(h);
  return new Request(req, { headers });
}

export function createPluginManager(deps: PluginManagerDeps): ServerPluginManager {
  const log = deps.logger.child("plugins");
  const entries = new Map<string, Entry>();
  const { kv, audit } = deps.stores;
  const defaultEnabled = new Set(deps.defaultEnabled ?? []);
  const pluginConfig = redactConfigForPlugins(deps.config);

  /** Runs state transitions of one plugin one at a time. */
  const serialize = (e: Entry, fn: () => Promise<void>): Promise<void> => {
    const next = (e.transition ?? Promise.resolve()).then(fn, fn);
    e.transition = next.catch(() => {});
    return next;
  };

  const info = (e: Entry): PluginInfo => {
    let settingsSchema: Record<string, unknown> | undefined;
    if (e.plugin?.settings) {
      try {
        settingsSchema = z.toJSONSchema(e.plugin.settings as z.ZodType, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
      } catch (err) {
        log.warn(`cannot convert settings schema of ${e.name}`, { error: errMsg(err) });
      }
    }
    return {
      name: e.name,
      version: e.plugin?.version ?? e.discovered?.version ?? "0.0.0",
      description: e.plugin?.description ?? e.discovered?.description ?? "",
      source: e.source,
      enabled: e.enabled,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
      ...(settingsSchema ? { settingsSchema } : {}),
      ...(e.plugin?.ui ? { uiUrl: `/admin/plugins-ui/${encodeURIComponent(e.name)}.js?v=${encodeURIComponent(e.plugin.version)}` } : {}),
    };
  };

  const must = (name: string) => {
    const e = entries.get(name);
    if (!e) throw new PluginError(`plugin not found: ${name}`, 404);
    return e;
  };

  function parseSettings(e: Entry, raw: unknown, strict: boolean): Record<string, unknown> {
    const schema = e.plugin?.settings as z.ZodType | undefined;
    if (!schema) return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const r = schema.safeParse(raw ?? {});
    if (r.success) return r.data as Record<string, unknown>;
    if (strict) {
      const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new PluginError(`invalid settings: ${msg}`, 400, r.error.issues);
    }
    log.warn(`stored settings of ${e.name} are invalid, falling back to defaults`);
    const d = schema.safeParse({});
    if (d.success) return d.data as Record<string, unknown>;
    throw new Error("plugin settings have required fields without defaults; configure them before enabling");
  }

  async function loadSettings(e: Entry) {
    if (e.settingsValue) return e.settingsValue;
    const raw = await kv.get(KV_NS, `settings:${e.name}`);
    e.settingsValue = parseSettings(e, raw, false);
    return e.settingsValue;
  }

  function cleanup(e: Entry) {
    for (const fn of e.cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (err) {
        log.warn(`cleanup failed for ${e.name}`, { error: errMsg(err) });
      }
    }
    deps.hooks.removeOwner(OWNER(e.name));
    e.http = undefined;
    e.adminHttp = undefined;
    e.settingsListeners.clear();
  }

  async function activate(e: Entry) {
    const plugin = e.plugin!;
    if (!e.migrated && plugin.migrations?.length) {
      await deps.stores.db.migrate(OWNER(e.name), plugin.migrations);
    }
    e.migrated = true;
    const settingsValue = await loadSettings(e);
    const owner = OWNER(e.name);
    const plog = deps.logger.child(owner);
    const http = new Hono();
    const adminHttp = new Hono();
    const track = (fn: () => void) => {
      e.cleanups.push(fn);
      return () => {
        const i = e.cleanups.indexOf(fn);
        if (i >= 0) e.cleanups.splice(i, 1);
        fn();
      };
    };
    const ctx: PluginContext = {
      name: e.name,
      logger: plog,
      config: pluginConfig,
      db: deps.stores.db,
      events: deps.stores.events,
      users: deps.stores.users,
      kv: deps.stores.kv,
      audit: deps.stores.audit,
      bus: deps.bus,
      relay: deps.relay,
      blossom: deps.blossom,
      metrics: deps.metrics,
      runtimeSettings: () => deps.settings.get(),
      settings: {
        get: () => e.settingsValue ?? settingsValue,
        onChange: (fn) => {
          e.settingsListeners.add(fn);
          return () => e.settingsListeners.delete(fn);
        },
      },
      hooks: {
        onWrite: (fn, p) => track(deps.hooks.onWrite(fn, owner, p)),
        onQuery: (fn, p) => track(deps.hooks.onQuery(fn, owner, p)),
        onVisibility: (fn, p) => track(deps.hooks.onVisibility(fn, owner, p)),
        onBlobUpload: (fn, p) => track(deps.hooks.onBlobUpload(fn, owner, p)),
      },
      http,
      adminHttp,
      jobs: {
        every(jobName, intervalMs, fn) {
          let running = false;
          const t = setInterval(async () => {
            if (running) return;
            running = true;
            try {
              await fn();
            } catch (err) {
              plog.error(`job ${jobName} failed`, { error: errMsg(err) });
            } finally {
              running = false;
            }
          }, Math.max(100, intervalMs));
          (t as { unref?: () => void }).unref?.();
          return track(() => clearInterval(t));
        },
      },
      on: <K extends keyof BusEvents>(name: K, fn: (p: BusEvents[K]) => void) => track(deps.bus.on(name, fn)),
    };
    e.http = http;
    e.adminHttp = adminHttp;
    try {
      await plugin.setup(ctx as never);
    } catch (err) {
      try {
        await plugin.teardown?.();
      } catch {}
      cleanup(e);
      throw err;
    }
  }

  async function enableEntry(e: Entry) {
    if (!e.plugin) throw new PluginError(`plugin ${e.name} failed to load: ${e.error ?? "unknown error"}`, 409);
    if (e.status === "running") return;
    try {
      await activate(e);
      e.status = "running";
      e.error = undefined;
      log.info(`enabled ${e.name}@${e.plugin.version}`);
    } catch (err) {
      e.status = "error";
      e.error = errMsg(err);
      log.error(`failed to enable ${e.name}`, { error: e.error });
    }
  }

  async function deactivate(e: Entry) {
    if (e.status === "running") {
      try {
        await e.plugin?.teardown?.();
      } catch (err) {
        log.warn(`teardown of ${e.name} failed`, { error: errMsg(err) });
      }
    }
    cleanup(e);
    if (e.status !== "error" || e.plugin) e.status = "disabled";
  }

  const adminRoutes = new Hono();
  adminRoutes.all("/:name/*", async (c) => {
    const name = c.req.param("name");
    const e = entries.get(name);
    if (!e || e.status !== "running" || !e.adminHttp) return c.json({ error: `plugin ${name} is not running` }, 404);
    return e.adminHttp.fetch(rewriteRequest(c.req.raw, name, "/x"), c.env);
  });
  adminRoutes.all("/:name", (c) => c.redirect(new URL(c.req.url).pathname + "/"));

  let loadedOnce: Promise<void> | undefined;
  /** Discover + import + validate plugins once (imports run module top-level code; setup only runs on enable). */
  const loadAll = () =>
    (loadedOnce ??= (async () => {
      const loaded: { plugin?: BeamhopPlugin; error?: string; discovered?: DiscoveredPlugin; source: "local" | "npm"; root: string }[] = [];
      if (deps.plugins) {
        for (const p of deps.plugins) {
          try {
            loaded.push({ plugin: validatePluginShape(p.plugin), source: p.source ?? "local", root: p.root ?? process.cwd() });
          } catch (err) {
            loaded.push({ error: errMsg(err), source: p.source ?? "local", root: p.root ?? process.cwd(), discovered: { id: String((p.plugin as { name?: unknown })?.name ?? "unknown"), entry: "", root: "", source: "local" } });
          }
        }
      } else {
        const found = discoverPlugins({ dir: deps.config.plugins.dir, packages: deps.config.plugins.packages, cwd: deps.cwd, autoDiscoverNpm: deps.autoDiscoverNpm });
        for (const d of found) {
          try {
            const mod = await import(importSpecifier(d.entry));
            loaded.push({ plugin: validatePluginShape(mod), discovered: d, source: d.source, root: d.root });
          } catch (err) {
            log.error(`failed to load plugin ${d.id} (${d.entry})`, { error: errMsg(err) });
            loaded.push({ error: errMsg(err), discovered: d, source: d.source, root: d.root });
          }
        }
      }
      for (const l of loaded) {
        const name = l.plugin?.name ?? l.discovered!.id.replace(/^(@[^/]+\/)?beamhop-plugin-/, "");
        if (entries.has(name)) {
          log.warn(`duplicate plugin name ${name} (${l.discovered?.entry ?? "inline"}), skipping`);
          continue;
        }
        const stored = await kv.get<boolean>(KV_NS, `enabled:${name}`);
        entries.set(name, {
          name,
          plugin: l.plugin,
          discovered: l.discovered,
          source: l.source,
          root: l.root,
          status: l.plugin ? "disabled" : "error",
          error: l.error,
          enabled: stored ?? defaultEnabled.has(name),
          settingsListeners: new Set(),
          cleanups: [],
          migrated: false,
        });
      }
    })());

  const manager: ServerPluginManager = {
    adminRoutes,
    list: () => [...entries.values()].map(info).sort((a, b) => a.name.localeCompare(b.name)),
    get: (name) => {
      const e = entries.get(name);
      return e ? info(e) : undefined;
    },

    async start() {
      await loadAll();
      for (const e of entries.values()) if (e.enabled && e.plugin) await serialize(e, () => enableEntry(e));
      log.info(`${entries.size} plugin(s) found, ${[...entries.values()].filter((e) => e.status === "running").length} running`);
    },

    async migrate() {
      await loadAll();
      let n = 0;
      for (const e of entries.values()) {
        // disabled plugins get their migrations when they're enabled; touching their tables now is a side effect
        if (!e.enabled || !e.plugin?.migrations?.length || e.migrated) continue;
        await deps.stores.db.migrate(OWNER(e.name), e.plugin.migrations);
        e.migrated = true;
        n++;
      }
      return n;
    },

    async stop() {
      for (const e of [...entries.values()].reverse()) if (e.status === "running") await serialize(e, () => deactivate(e));
    },

    async enable(name, actor) {
      const e = must(name);
      e.enabled = true;
      await kv.set(KV_NS, `enabled:${name}`, true);
      await serialize(e, () => enableEntry(e));
      await audit.record({ actor, action: "plugin.enable", target: name, details: { status: e.status, ...(e.error ? { error: e.error } : {}) }, ip: null });
      if (e.status === "error") throw new PluginError(`plugin ${name} failed to start: ${e.error}`, 500);
    },

    async disable(name, actor) {
      const e = must(name);
      e.enabled = false;
      await kv.set(KV_NS, `enabled:${name}`, false);
      await serialize(e, () => deactivate(e));
      if (e.plugin) e.error = undefined;
      await audit.record({ actor, action: "plugin.disable", target: name, details: {}, ip: null });
      log.info(`disabled ${name}`);
    },

    async getSettings(name) {
      const e = must(name);
      if (!e.plugin) return {};
      return loadSettings(e).catch(async () => ((await kv.get(KV_NS, `settings:${name}`)) ?? {}) as Record<string, unknown>);
    },

    async updateSettings(name, values, actor) {
      const e = must(name);
      if (!e.plugin) throw new PluginError(`plugin ${name} failed to load`, 409);
      const parsed = parseSettings(e, values, true);
      await kv.set(KV_NS, `settings:${name}`, parsed);
      e.settingsValue = parsed;
      for (const fn of [...e.settingsListeners]) {
        try {
          fn(parsed);
        } catch (err) {
          log.warn(`settings listener of ${name} failed`, { error: errMsg(err) });
        }
      }
      // never write credentials into the audit log (readable with audit.view)
      const redacted = redactSecrets(parsed, info(e).settingsSchema);
      await audit.record({ actor, action: "plugin.settings", target: name, details: { values: redacted }, ip: null });
      return parsed;
    },

    async handlePublic(name, req, env) {
      const e = entries.get(name);
      if (!e || e.status !== "running" || !e.http) return undefined;
      return e.http.fetch(stripAdminIdentity(rewriteRequest(req, name, "/plugins")), env);
    },

    uiBundle(name) {
      const e = entries.get(name);
      // served without login, so only for plugins that are actually running
      if (!e?.plugin?.ui || e.status !== "running") return undefined;
      const p = isAbsolute(e.plugin.ui) ? e.plugin.ui : resolve(e.root, e.plugin.ui);
      if (!existsSync(p)) return undefined;
      return new Response(fileBody(p), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
    },
  };
  return manager;
}
