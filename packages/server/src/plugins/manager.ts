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
  /** also import every beamhop-plugin-* package found in node_modules (default false; config plugins.autoDiscoverNpm) */
  autoDiscoverNpm?: boolean;
  cwd?: string;
  /** lifecycle budgets in ms (defaults: import 30 s, setup 30 s, teardown 5 s — also the wait for running jobs) */
  timeouts?: { importMs?: number; setupMs?: number; teardownMs?: number };
}

type SettingsListener = (s: Record<string, unknown>) => void | Promise<void>;

/** Everything one setup() run registered. Once `dead`, anything it still registers is disposed at once. */
interface Activation {
  dead: boolean;
  /** setup() has resolved */
  settled: boolean;
  cleanups: (() => void)[];
  /** interval cancels of ctx.jobs.every */
  jobs: (() => void)[];
  /** job runs in progress */
  running: Set<Promise<void>>;
  settingsListeners: Set<SettingsListener>;
  http: Hono;
  adminHttp: Hono;
  /** aborts a pending setup() (disable/stop while enabling) */
  cancel(reason: Error): void;
  cancelled: Promise<never>;
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
  /** the current (pending or running) activation */
  activation?: Activation;
  migrated: boolean;
  /** serializes enable/disable so concurrent calls can't run setup twice */
  transition?: Promise<void>;
}

/** setup() was abandoned because the plugin was disabled (or the server stopped) meanwhile. */
class CancelledError extends Error {}

/**
 * Rejects after `ms`, or as soon as `cancelled` rejects (the operation itself keeps running; its late result or
 * rejection is ignored).
 */
function bounded<T>(p: Promise<T>, ms: number, what: string, cancelled?: Promise<never>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race(cancelled ? [p, expired, cancelled] : [p, expired]).finally(() => clearTimeout(timer));
}

const noop = () => {};

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
  const { kv } = deps.stores;
  const defaultEnabled = new Set(deps.defaultEnabled ?? []);
  const pluginConfig = redactConfigForPlugins(deps.config);
  const importMs = deps.timeouts?.importMs ?? 30_000;
  const setupMs = deps.timeouts?.setupMs ?? 30_000;
  const teardownMs = deps.timeouts?.teardownMs ?? 5_000;

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

  function newActivation(): Activation {
    let cancel!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => (cancel = reject));
    cancelled.catch(noop);
    return { dead: false, settled: false, cleanups: [], jobs: [], running: new Set(), settingsListeners: new Set(), http: new Hono(), adminHttp: new Hono(), cancel, cancelled };
  }

  /** Removes everything an activation registered and makes later registrations of it no-ops. */
  function dispose(e: Entry, act: Activation) {
    act.dead = true;
    for (const stop of act.jobs.splice(0)) stop();
    for (const fn of act.cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (err) {
        log.warn(`cleanup failed for ${e.name}`, { error: errMsg(err) });
      }
    }
    act.settingsListeners.clear();
    if (e.activation === act) {
      deps.hooks.removeOwner(OWNER(e.name));
      e.activation = undefined;
    }
  }

  /** Stops scheduling jobs and waits (bounded) for runs in progress, so teardown doesn't pull state from under them. */
  async function drainJobs(e: Entry, act: Activation) {
    for (const stop of act.jobs.splice(0)) stop();
    if (!act.running.size) return;
    await bounded(Promise.all(act.running), teardownMs, `jobs of ${e.name}`).catch((err) => log.warn(errMsg(err)));
  }

  async function runTeardown(e: Entry) {
    try {
      await bounded(Promise.resolve().then(() => e.plugin?.teardown?.()), teardownMs, `teardown of ${e.name}`);
    } catch (err) {
      log.warn(`teardown of ${e.name} failed`, { error: errMsg(err) });
    }
  }

  async function activate(e: Entry) {
    const plugin = e.plugin!;
    const act = newActivation();
    e.activation = act;
    const owner = OWNER(e.name);
    const plog = deps.logger.child(owner);
    // registrations made after the activation was abandoned (setup timed out, failed or was cancelled, and kept
    // running in the background) are undone at once
    const track = (fn: () => void) => {
      if (act.dead) {
        try {
          fn();
        } catch {}
        return noop;
      }
      act.cleanups.push(fn);
      return () => {
        const i = act.cleanups.indexOf(fn);
        if (i >= 0) act.cleanups.splice(i, 1);
        fn();
      };
    };
    const on = <K extends keyof BusEvents>(name: K, fn: (p: BusEvents[K]) => unknown) => track(deps.bus.on(name, fn));
    try {
      if (!e.migrated && plugin.migrations?.length) {
        await deps.stores.db.migrate(owner, plugin.migrations);
      }
      e.migrated = true;
      const settingsValue = await loadSettings(e);
      const ctx: PluginContext = {
        name: e.name,
        logger: plog,
        config: pluginConfig,
        db: deps.stores.db,
        events: deps.stores.events,
        users: deps.stores.users,
        kv: deps.stores.kv,
        audit: deps.stores.audit,
        bus: {
          on,
          emit(name, payload) {
            // core events (event.accepted, user.updated, …) drive metrics, admin SSE and caches: core emits them
            if (name !== "alert") throw new Error(`plugins may only emit "alert" on the bus, not "${String(name)}"`);
            deps.bus.emit("alert", payload);
          },
        },
        relay: deps.relay,
        blossom: deps.blossom,
        metrics: deps.metrics,
        runtimeSettings: () => deps.settings.get(),
        settings: {
          get: () => e.settingsValue ?? settingsValue,
          onChange: (fn) => {
            if (act.dead) return noop;
            act.settingsListeners.add(fn as SettingsListener);
            return () => act.settingsListeners.delete(fn as SettingsListener);
          },
        },
        hooks: {
          onWrite: (fn, o) => track(deps.hooks.onWrite(fn, owner, o)),
          onQuery: (fn, o) => track(deps.hooks.onQuery(fn, owner, o)),
          onVisibility: (fn, o) => track(deps.hooks.onVisibility(fn, owner, o)),
          onBlobUpload: (fn, o) => track(deps.hooks.onBlobUpload(fn, owner, o)),
        },
        http: act.http,
        adminHttp: act.adminHttp,
        jobs: {
          every(jobName, intervalMs, fn) {
            if (act.dead) return noop;
            let current: Promise<void> | undefined;
            const t = setInterval(() => {
              if (current || act.dead) return;
              const run = (async () => {
                try {
                  await fn();
                } catch (err) {
                  plog.error(`job ${jobName} failed`, { error: errMsg(err) });
                }
              })().finally(() => {
                act.running.delete(run);
                current = undefined;
              });
              current = run;
              act.running.add(run);
            }, Math.max(100, intervalMs));
            (t as { unref?: () => void }).unref?.();
            const stop = () => clearInterval(t);
            act.jobs.push(stop);
            return track(stop);
          },
        },
        on,
      };
      await bounded(Promise.resolve().then(() => plugin.setup(ctx as never)), setupMs, `setup of ${e.name}`, act.cancelled);
      act.settled = true;
    } catch (err) {
      // a timed-out or cancelled setup keeps running: mark the activation dead first so whatever it still
      // registers is disposed, then give the plugin its teardown
      act.dead = true;
      await drainJobs(e, act);
      await runTeardown(e);
      dispose(e, act);
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
      if (err instanceof CancelledError) {
        e.status = "disabled";
        e.error = undefined;
        log.info(`enabling ${e.name} was cancelled: ${err.message}`);
        return;
      }
      e.status = "error";
      e.error = errMsg(err);
      log.error(`failed to enable ${e.name}`, { error: e.error });
    }
  }

  /** Aborts a setup() still in progress so disable/stop don't queue behind a hung enable. */
  function cancelPending(e: Entry, why: string) {
    const act = e.activation;
    if (act && !act.settled && !act.dead) act.cancel(new CancelledError(why));
  }

  async function deactivate(e: Entry) {
    const act = e.activation;
    if (act && e.status === "running") {
      await drainJobs(e, act);
      await runTeardown(e);
    }
    if (act) dispose(e, act);
    deps.hooks.removeOwner(OWNER(e.name));
    if (e.status !== "error" || e.plugin) e.status = "disabled";
  }

  const adminRoutes = new Hono();
  // `/:name/*` also matches the bare `/:name`
  adminRoutes.all("/:name/*", async (c) => {
    const name = c.req.param("name");
    const e = entries.get(name);
    if (!e || e.status !== "running" || !e.activation) return c.json({ error: `plugin ${name} is not running` }, 404);
    return e.activation.adminHttp.fetch(rewriteRequest(c.req.raw, name, "/x"), c.env);
  });

  let stopping = false;
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
            // a module whose top-level code hangs must not block startup (it keeps running, unreferenced)
            const mod = await bounded(import(importSpecifier(d.entry)), importMs, `import of ${d.id}`);
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
      stopping = false;
      await loadAll();
      // one at a time, in discovery order (hook order between equal priorities follows it); each setup is bounded
      for (const e of entries.values()) {
        if (stopping) break;
        if (e.enabled && e.plugin) await serialize(e, () => enableEntry(e));
      }
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
      stopping = true;
      const all = [...entries.values()].reverse();
      for (const e of all) cancelPending(e, "server stopping");
      for (const e of all) if (e.status === "running" || e.activation) await serialize(e, () => deactivate(e));
    },

    async enable(name, actor) {
      const e = must(name);
      await serialize(e, async () => {
        await enableEntry(e);
        // persisted only once setup succeeded: a plugin that can't start isn't retried at every boot
        if (e.status === "running") {
          e.enabled = true;
          await kv.set(KV_NS, `enabled:${name}`, true);
        }
      });
      log.debug(`enable ${name} requested by ${actor}: ${e.status}`);
      if (e.status === "error") throw new PluginError(`plugin ${name} failed to start: ${e.error}`, 500);
      if (e.status !== "running") throw new PluginError(`enabling ${name} was cancelled`, 409);
    },

    async disable(name, actor) {
      const e = must(name);
      // a hung setup() is abandoned instead of waited for
      cancelPending(e, `disabled by ${actor}`);
      await serialize(e, async () => {
        e.enabled = false;
        await kv.set(KV_NS, `enabled:${name}`, false);
        await deactivate(e);
      });
      if (e.plugin) e.error = undefined;
      log.info(`disabled ${name} (by ${actor})`);
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
      const failed = (err: unknown) => log.warn(`settings listener of ${name} failed`, { error: errMsg(err) });
      for (const fn of [...(e.activation?.settingsListeners ?? [])]) {
        try {
          const r = fn(parsed);
          if (r && typeof (r as Promise<void>).then === "function") (r as Promise<void>).then(undefined, failed);
        } catch (err) {
          failed(err);
        }
      }
      log.debug(`settings of ${name} updated by ${actor}`);
      return parsed;
    },

    async handlePublic(name, req, env) {
      const e = entries.get(name);
      if (!e || e.status !== "running" || !e.activation) return undefined;
      return e.activation.http.fetch(stripAdminIdentity(rewriteRequest(req, name, "/plugins")), env);
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
