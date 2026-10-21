// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Module system: every feature package (relay, blossom, admin-api, policy,
 * insights, alerts, media, plugins, enterprise…) is a BeamhopModule that plugs
 * into the kernel's extension points. Core never imports feature packages.
 *
 * Isolation rule (§12.0): a module that is not enabled is never registered,
 * so it contributes no hooks, routes, actions, cards, or hot-path cost.
 */
import { Hono } from 'hono';
import type { z } from 'zod';
import { ActionRegistry } from './actions.ts';
import type { ActionDef } from './actions.ts';
import type { AuthProvider, Principal } from './auth.ts';
import { type AppEventName, type AppEvents, EventBus } from './bus.ts';
import type { BeamhopConfig, EffectiveLimits, RelayConfig } from './config.ts';
import type { Connection, RequestGate, RequestGateContext, RouteContext } from './connection.ts';
import { PolicyPipeline } from './policy.ts';
import type { PolicyHooks } from './policy.ts';
import type {
  LogLevel,
  LogListener,
  Logger,
  Notification,
  Ports,
  RelayId,
  RuntimeName,
  Scheduler,
} from './ports.ts';

export type Subsystem =
  | 'relay'
  | 'blossom'
  | 'storage'
  | 'network'
  | 'moderation'
  | 'backups'
  | 'security';

export interface HealthResult {
  /** 0..100 */
  score: number;
  status: 'ok' | 'warn' | 'critical';
  /** Plain language. */
  message: string;
  technical?: string;
}

export interface HealthCheck {
  id: string;
  subsystem: Subsystem;
  /** Relative weight in the overall health score. */
  weight: number;
  run(relayId: RelayId | null): Promise<HealthResult>;
}

/**
 * Attention card / suggestion (§6.8, §6.9). Never auto-applied: the primary
 * action is executed only on explicit admin approval. Cards with the same
 * `batchKey` collapse into one card.
 */
export interface AttentionCard {
  id: string;
  relayId: RelayId | null;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  technical?: string;
  batchKey?: string;
  createdAt: number;
  primary?: { label: string; actionId: string; input: unknown };
  secondary?: { label: string; actionId: string; input: unknown };
  /** Playbook id to open for guided help (§6.10). */
  playbook?: string;
}

export interface CardSource {
  id: string;
  cards(relayId: RelayId | null): Promise<AttentionCard[]>;
}

export interface UiRoute {
  /** PWA path, e.g. `/settings/company`. */
  path: string;
  title: string;
  /** Where it appears. Absent modules contribute nothing to the PWA. */
  placement:
    | 'settings-section'
    | 'people-section'
    | 'activity-section'
    | 'media-section'
    | 'home-card';
  /** Lazy chunk name the PWA loads. */
  chunk: string;
}

export interface Playbook {
  id: string;
  title: string;
  steps: Array<{ title: string; body: string; actionId?: string; input?: unknown }>;
}

/** Access check used by the relay engine for read/write authorization (allowlist, WoT, SSO binding…). */
export interface AccessResolver {
  id: string;
  /**
   * Return `true`/`false` to decide, or `undefined` to abstain.
   * The first non-undefined answer (in registration order) wins; default is the relay's access mode.
   */
  canWrite?(relayId: RelayId, pubkey: string): Promise<boolean | undefined>;
  canRead?(relayId: RelayId, pubkey: string | null): Promise<boolean | undefined>;
  /** Tier id for this pubkey, or undefined to abstain. */
  tierOf?(relayId: RelayId, pubkey: string): Promise<string | undefined>;
}

export interface ConnectionHandler {
  onOpen(conn: Connection): void;
  onMessage(conn: Connection, raw: string): void;
  onClose(conn: Connection): void;
  /**
   * Optional. Called by runtimes that hibernate sockets (Cloudflare Durable Objects)
   * after a still-open connection was rebuilt on wake-up: `authed`, `challenge` and
   * JSON-serializable `state` entries (plain objects, arrays, Map, Set) are restored,
   * but in-memory indexes outside the connection are not. Handlers rebuild them here
   * (e.g. re-index subscriptions kept in `conn.state`). `onOpen` is NOT called again.
   */
  onRestore?(conn: Connection): void;
}

export interface Kernel {
  readonly runtime: RuntimeName;
  readonly ports: Ports;
  readonly bus: EventBus;
  readonly policy: PolicyPipeline;
  readonly actions: ActionRegistry;
  config(): BeamhopConfig;
  relay(relayId: RelayId): RelayConfig | undefined;
  /** Resolved limits for relay (+ tier). Provided by the goals engine module. */
  limits(relayId: RelayId, tier?: string): EffectiveLimits;
  setLimitsResolver(fn: (relay: RelayConfig, tier?: string) => EffectiveLimits): void;
  /** Called by the config service after a new revision is committed. */
  applyConfig(next: BeamhopConfig): Promise<void>;
  onConfigChange(fn: (next: BeamhopConfig, prev: BeamhopConfig) => void): () => void;
  /** Module section from `config.modules[id]`, validated by that module's schema. */
  moduleConfig<T>(id: string): T | undefined;
  /**
   * `configSchema` of every registered module that declares one, keyed by module id
   * (validation of `config.modules.<id>` on config proposals, settings forms).
   * Optional for non-core kernel implementations.
   */
  moduleSchemas?(): Record<string, z.ZodType>;
  /**
   * Shared Hono app (runs on Bun and Cloudflare). The runtime sets `route` before dispatch;
   * admin-api auth middleware sets `principal`. Modules add routes directly.
   */
  readonly http: Hono<KernelEnv>;
  readonly authProviders: AuthProvider[];
  readonly access: AccessResolver[];
  readonly health: HealthCheck[];
  readonly cards: CardSource[];
  readonly ui: UiRoute[];
  readonly playbooks: Playbook[];
  readonly notify: (n: Notification) => Promise<void>;
  setNotifier(fn: (n: Notification) => Promise<void>): void;
  /** WebSocket handler (set by the relay module). */
  ws?: ConnectionHandler;
  /**
   * Opt-in request gates (network controls). Runtimes run them before dispatching
   * HTTP requests and WebSocket upgrades (see {@link runRequestGates}). Empty by default.
   */
  readonly gates?: RequestGate[];
  isEnabled(moduleId: string): boolean;
  /** Typed service registry so modules can expose APIs to dependents (e.g. `admin.config`). */
  provide<T>(name: string, service: T): void;
  use<T>(name: string): T | undefined;
  /**
   * Hot-enable a module while running: parse its config section, `register()` and
   * `start()` it. Everything it registers (hooks, routes, actions, access resolvers,
   * auth providers, health checks, cards, UI routes, playbooks, gates, services,
   * bus/config listeners, scheduled jobs) is tracked so {@link Kernel.disableModule}
   * can remove exactly that. No-op when already enabled. Optional for non-core kernels.
   */
  enableModule?(m: BeamhopModule): Promise<void>;
  /**
   * Hot-disable a module: `stop()` it and remove everything it registered.
   * Returns false when it was not enabled. Throws when an enabled module depends on it.
   */
  disableModule?(id: string): Promise<boolean>;
  /** Enabled modules in registration order (runtimes stop them in reverse on shutdown). */
  modules?(): BeamhopModule[];
  /**
   * Observe every line written through `ports.logger` (and its children), after the
   * runtime logger got it. Listeners must be cheap and must not log themselves.
   * Returns an unsubscribe function. Optional for non-core kernel implementations.
   */
  onLog?(fn: LogListener): () => void;
}

export type KernelEnv = {
  Variables: { route: RouteContext; principal?: Principal };
};

export interface BeamhopModule {
  id: string;
  /** Module ids that must be registered first. */
  dependsOn?: string[];
  /** Schema for `config.modules[id]` (feature modules outside core config). */
  configSchema?: z.ZodType;
  /**
   * Optional feature (enterprise…) that can be switched on and off while running.
   * Its HTTP routes live on a detachable per-module sub-app (dispatched after all
   * built-in routes) even when it is registered at boot. Modules enabled with
   * `kernel.enableModule()` always get one.
   */
  optional?: boolean;
  /** Registration must be cheap and side-effect free besides using the kernel. */
  register(kernel: Kernel): void | Promise<void>;
  /** Start background work (schedulers) after all modules registered. */
  start?(kernel: Kernel): void | Promise<void>;
  stop?(kernel: Kernel): void | Promise<void>;
}

const DEFAULT_LIMITS: EffectiveLimits = {
  maxEventBytes: 128 * 1024,
  maxSubscriptions: 50,
  maxFilters: 10,
  maxLimit: 500,
  eventsPerMinute: 120,
  reqPerMinute: 240,
  minPowDifficulty: 0,
  newKeyPowDifficulty: 0,
  maxCreatedAtFutureSeconds: 15 * 60,
  maxCreatedAtPastSeconds: 0,
  blockedKinds: [],
  spamThreshold: 0.8,
  maxBlobBytes: 50 * 1024 * 1024,
  defaultBlobQuotaBytes: 1024 * 1024 * 1024,
  overridden: [],
};

export interface KernelOptions {
  runtime: RuntimeName;
  ports: Ports;
  config: BeamhopConfig;
  modules: BeamhopModule[];
}

/** Response header a detachable module sub-app sets when none of its routes matched. */
const UNMATCHED_HEADER = 'x-beamhop-unmatched';
/** `env` key carrying the root app's `route`/`principal` variables into module sub-apps. */
const PARENT_VARS = '__beamhopParentVars';
/** Kernel arrays modules push into; tracked per module so they can be removed again. */
const TRACKED_LISTS = [
  'authProviders',
  'access',
  'health',
  'cards',
  'ui',
  'playbooks',
  'gates',
] as const;
type TrackedList = (typeof TRACKED_LISTS)[number];
/** Hono registration methods redirected to a module's sub-app while it registers. */
const ROUTE_METHODS = [
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'all',
  'on',
  'use',
  'route',
] as const;

/** Everything one module registered (its registration scope). */
interface ModuleScope {
  module: BeamhopModule;
  /** Detachable sub-app (optional / hot-enabled modules), else null (routes on the root app). */
  app: Hono<KernelEnv> | null;
  actions: string[];
  hooks: string[];
  services: Array<{ name: string; had: boolean; prev: unknown }>;
  offs: Array<() => void>;
  jobs: Set<string>;
  added: Map<TrackedList, unknown[]>;
  ws: { prev: ConnectionHandler | undefined; next: ConnectionHandler | undefined } | null;
  ports: Array<{ key: string; prev: unknown; next: unknown }>;
}

function newScope(module: BeamhopModule, detachable: boolean): ModuleScope {
  return {
    module,
    app: detachable ? createModuleApp() : null,
    actions: [],
    hooks: [],
    services: [],
    offs: [],
    jobs: new Set(),
    added: new Map(),
    ws: null,
    ports: [],
  };
}

export async function createKernel(opts: KernelOptions): Promise<Kernel> {
  let current = opts.config;
  const listeners = new Set<(n: BeamhopConfig, p: BeamhopConfig) => void>();
  const services = new Map<string, unknown>();
  const enabled = new Set<string>();
  const schemas: Record<string, z.ZodType> = {};
  let limitsResolver: ((relay: RelayConfig, tier?: string) => EffectiveLimits) | null = null;
  let notifier: (n: Notification) => Promise<void> = async () => {};

  // ── Registration scopes (hot enable/disable) ──
  const scopes = new Map<string, ModuleScope>();
  const order: BeamhopModule[] = [];
  /** Scopes with a detachable sub-app, in registration order (= dispatch order). */
  const detachable: ModuleScope[] = [];
  let active: ModuleScope | null = null;

  const http = createKernelHttp(() => detachable.map((s) => s.app as Hono<KernelEnv>));
  redirectRoutes(http, () => active?.app ?? null);

  const actions = new ActionRegistry();
  const registerAction = actions.register.bind(actions);
  actions.register = ((def: ActionDef) => {
    registerAction(def);
    active?.actions.push(def.id);
  }) as ActionRegistry['register'];

  const policy = new PolicyPipeline();
  const addHook = policy.add.bind(policy);
  policy.add = (h) => {
    const off = addHook(h);
    active?.hooks.push(h.id);
    return off;
  };

  const bus = new EventBus();
  const on = bus.on.bind(bus);
  bus.on = ((name: AppEventName, handler: (p: AppEvents[AppEventName]) => void) => {
    const off = on(name, handler);
    active?.offs.push(off);
    return off;
  }) as EventBus['on'];

  const baseScheduler = opts.ports.scheduler as Scheduler | undefined;
  const scheduler = baseScheduler
    ? new Proxy(baseScheduler, {
        get(t, k, r) {
          if (k === 'every')
            return (name: string, seconds: number, fn: () => Promise<void>) => {
              active?.jobs.add(name);
              return t.every(name, seconds, fn);
            };
          return Reflect.get(t, k, r);
        },
      })
    : undefined;
  const logListeners = new Set<LogListener>();
  const baseLogger = opts.ports.logger as Logger | undefined;
  const nowMs = () => opts.ports.clock?.nowMs() ?? Date.now();
  const logger = baseLogger ? teeLogger(baseLogger, {}, logListeners, nowMs) : undefined;
  const ports: Ports =
    scheduler || logger
      ? new Proxy(opts.ports, {
          get(t, k, r) {
            if (k === 'scheduler' && scheduler) return scheduler;
            if (k === 'logger' && logger) return logger;
            return Reflect.get(t, k, r);
          },
        })
      : opts.ports;

  const kernel: Kernel = {
    runtime: opts.runtime,
    ports,
    bus,
    policy,
    actions,
    config: () => current,
    relay: (id) => current.relays.find((r) => r.id === id),
    limits(relayId, tier) {
      const relay = current.relays.find((r) => r.id === relayId);
      if (!relay) return DEFAULT_LIMITS;
      return limitsResolver ? limitsResolver(relay, tier) : DEFAULT_LIMITS;
    },
    setLimitsResolver(fn) {
      limitsResolver = fn;
    },
    async applyConfig(raw) {
      const prev = current;
      const next = resolveSections(raw, prev);
      current = next;
      // Listeners may return a promise (e.g. hot-enabling a module); wait for all of them.
      const pending: Promise<unknown>[] = [];
      for (const l of [...listeners]) {
        const r = l(next, prev) as unknown;
        if (r && typeof (r as Promise<unknown>).then === 'function')
          pending.push(r as Promise<unknown>);
      }
      if (pending.length === 0) return;
      const failed = (await Promise.allSettled(pending)).find((r) => r.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
    },
    onConfigChange(fn) {
      listeners.add(fn);
      const off = () => {
        listeners.delete(fn);
      };
      active?.offs.push(off);
      return off;
    },
    moduleConfig<T>(id: string) {
      return current.modules[id] as T | undefined;
    },
    moduleSchemas() {
      return { ...schemas };
    },
    http,
    authProviders: [],
    access: [],
    health: [],
    cards: [],
    ui: [],
    playbooks: [],
    gates: [],
    notify: (n) => notifier(n),
    setNotifier(fn) {
      notifier = fn;
    },
    isEnabled: (id) => enabled.has(id),
    provide(name, service) {
      active?.services.push({ name, had: services.has(name), prev: services.get(name) });
      services.set(name, service);
    },
    use<T>(name: string) {
      return services.get(name) as T | undefined;
    },
    enableModule: (m) => serial(() => enable(m)),
    disableModule: (id) => serial(() => disable(id)),
    modules: () => [...order],
    onLog(fn) {
      logListeners.add(fn);
      const off = () => {
        logListeners.delete(fn);
      };
      active?.offs.push(off);
      return off;
    },
  };

  /**
   * Parse every enabled module's `config.modules.<id>` section with its `configSchema`
   * (defaults filled in), whichever path the config came from (settings file, app,
   * import, safe mode). A missing section of a module loaded at boot gets the defaults;
   * a missing section of a hot-enabled module stays missing (its absence is what
   * disables it). An invalid section keeps the module's previous one.
   */
  const resolveSections = (next: BeamhopConfig, prev: BeamhopConfig): BeamhopConfig => {
    let modules: Record<string, unknown> | null = null;
    for (const [id, schema] of Object.entries(schemas)) {
      const raw = next.modules[id];
      if (raw === undefined && scopes.get(id)?.app) continue;
      const r = schema.safeParse(raw ?? {});
      const value = r.success ? r.data : prev.modules[id];
      if (!r.success)
        ports.logger?.log('warn', 'invalid module settings ignored, keeping the previous ones', {
          module: id,
          error: r.error.message,
        });
      if (value === raw) continue;
      modules ??= { ...next.modules };
      if (value === undefined) delete modules[id];
      else modules[id] = value;
    }
    return modules ? { ...next, modules } : next;
  };

  const parseSection = (m: BeamhopModule) => {
    if (!m.configSchema) return;
    const raw = current.modules[m.id];
    current = {
      ...current,
      modules: { ...current.modules, [m.id]: m.configSchema.parse(raw ?? {}) },
    };
  };

  /** Run `fn` with `scope` active and record what it added to kernel lists, `ws` and ports. */
  const inScope = async (scope: ModuleScope, fn: () => unknown): Promise<void> => {
    const outer = active;
    const lists = new Map(
      TRACKED_LISTS.map((k) => [k, new Set<unknown>((kernel[k] as unknown[] | undefined) ?? [])]),
    );
    const ws = kernel.ws;
    const portsBefore = new Map(Object.entries(opts.ports));
    active = scope;
    try {
      await fn();
    } finally {
      active = outer;
      for (const k of TRACKED_LISTS) {
        const before = lists.get(k) as Set<unknown>;
        const added = ((kernel[k] as unknown[] | undefined) ?? []).filter((x) => !before.has(x));
        if (added.length) scope.added.set(k, [...(scope.added.get(k) ?? []), ...added]);
      }
      if (kernel.ws !== ws) scope.ws = { prev: scope.ws ? scope.ws.prev : ws, next: kernel.ws };
      for (const [key, next] of Object.entries(opts.ports)) {
        const prev = portsBefore.get(key);
        if (next !== prev) scope.ports.push({ key, prev, next });
      }
    }
  };

  /** Remove everything `scope` registered (after the module's own `stop()`). */
  const teardown = (scope: ModuleScope) => {
    for (const id of scope.actions) actions.unregister(id);
    for (const id of scope.hooks) policy.remove(id);
    for (const off of [...scope.offs].reverse()) {
      try {
        off();
      } catch {}
    }
    for (const name of scope.jobs) {
      try {
        baseScheduler?.cancel(name);
      } catch {}
    }
    for (const [k, items] of scope.added) {
      const list = kernel[k] as unknown[] | undefined;
      if (!list) continue;
      for (const item of items) {
        const i = list.indexOf(item);
        if (i >= 0) list.splice(i, 1);
      }
    }
    for (const s of [...scope.services].reverse()) {
      if (s.had) services.set(s.name, s.prev);
      else services.delete(s.name);
    }
    if (scope.ws && kernel.ws === scope.ws.next) kernel.ws = scope.ws.prev;
    const p = opts.ports as unknown as Record<string, unknown>;
    for (const c of [...scope.ports].reverse()) {
      if (p[c.key] !== c.next) continue;
      if (c.prev === undefined) delete p[c.key];
      else p[c.key] = c.prev;
    }
    const i = detachable.indexOf(scope);
    if (i >= 0) detachable.splice(i, 1);
  };

  const track = (scope: ModuleScope) => {
    scopes.set(scope.module.id, scope);
    if (scope.app) detachable.push(scope);
  };

  const forget = (m: BeamhopModule) => {
    enabled.delete(m.id);
    scopes.delete(m.id);
    delete schemas[m.id];
    const i = order.indexOf(m);
    if (i >= 0) order.splice(i, 1);
  };

  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function enable(m: BeamhopModule): Promise<void> {
    if (enabled.has(m.id)) return;
    const missing = (m.dependsOn ?? []).filter((d) => !enabled.has(d));
    if (missing.length)
      throw new Error(`module ${m.id} needs ${missing.join(', ')} to be enabled first`);
    const section = current.modules[m.id];
    parseSection(m);
    const scope = newScope(m, true);
    track(scope);
    try {
      await inScope(scope, () => m.register(kernel));
      enabled.add(m.id);
      order.push(m);
      if (m.configSchema) schemas[m.id] = m.configSchema;
      await inScope(scope, () => m.start?.(kernel));
    } catch (err) {
      try {
        await m.stop?.(kernel);
      } catch {}
      teardown(scope);
      forget(m);
      if (current.modules[m.id] !== section) {
        const modules = { ...current.modules };
        if (section === undefined) delete modules[m.id];
        else modules[m.id] = section;
        current = { ...current, modules };
      }
      throw err;
    }
  }

  async function disable(id: string): Promise<boolean> {
    const scope = scopes.get(id);
    if (!scope || !enabled.has(id)) return false;
    const dependents = order.filter((m) => m.id !== id && (m.dependsOn ?? []).includes(id));
    if (dependents.length)
      throw new Error(
        `module ${id} is needed by ${dependents.map((m) => m.id).join(', ')}; turn those off first`,
      );
    try {
      await scope.module.stop?.(kernel);
    } catch (err) {
      ports.logger?.log('error', 'module stop failed', { module: id, err: String(err) });
    }
    teardown(scope);
    forget(scope.module);
    return true;
  }

  const ordered = topoSort(opts.modules);
  for (const m of ordered) {
    parseSection(m);
    const scope = newScope(m, !!m.optional);
    track(scope);
    await inScope(scope, () => m.register(kernel));
    enabled.add(m.id);
    order.push(m);
    if (m.configSchema) schemas[m.id] = m.configSchema;
  }
  for (const m of ordered) {
    const scope = scopes.get(m.id) as ModuleScope;
    await inScope(scope, () => m.start?.(kernel));
  }
  return kernel;
}

/**
 * While a module with a detachable sub-app registers, route registrations made on
 * the root app (`kernel.http.get(…)` etc.) go to that sub-app instead. Request
 * handling (`fetch`/`request`) always uses the root app.
 */
function redirectRoutes(app: Hono<KernelEnv>, target: () => Hono<KernelEnv> | null): void {
  const root = app as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ROUTE_METHODS) {
    const original = (root[name] as (...a: unknown[]) => unknown).bind(app);
    root[name] = (...args: unknown[]) => {
      const sub = target();
      if (!sub) return original(...args);
      (sub as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.(...args);
      return app;
    };
  }
}

/** Per-module sub-app: inherits `route`/`principal` from the root app, marks misses. */
function createModuleApp(): Hono<KernelEnv> {
  const app = new Hono<KernelEnv>();
  app.use('*', async (c, next) => {
    const env = c.env as Record<string, unknown> | undefined;
    const vars = env?.[PARENT_VARS] as { route?: RouteContext; principal?: Principal } | undefined;
    const route = vars?.route ?? (env?.route as RouteContext | undefined);
    if (route) c.set('route', route);
    if (vars?.principal) c.set('principal', vars.principal);
    await next();
  });
  app.notFound(
    () => new Response('404 Not Found', { status: 404, headers: { [UNMATCHED_HEADER]: '1' } }),
  );
  return app;
}

/**
 * Kernel Hono app with a first middleware that copies `env.route` (passed by the
 * runtime via {@link dispatchHttp}) into the `route` variable, before any module route runs.
 * Requests no built-in route answers fall through to the detachable sub-apps of
 * optional modules (in registration order), then to a plain 404.
 */
function createKernelHttp(subApps: () => Hono<KernelEnv>[]): Hono<KernelEnv> {
  const app = new Hono<KernelEnv>();
  app.use('*', async (c, next) => {
    const env = c.env as { route?: RouteContext } | undefined;
    if (env && typeof env === 'object' && env.route) c.set('route', env.route);
    await next();
  });
  app.notFound(async (c) => {
    const apps = subApps();
    if (apps.length) {
      const env = {
        ...((c.env as Record<string, unknown> | undefined) ?? {}),
        [PARENT_VARS]: { route: c.get('route'), principal: c.get('principal') },
      };
      let exec: Parameters<Hono<KernelEnv>['fetch']>[2];
      try {
        exec = c.executionCtx;
      } catch {}
      const method = c.req.method;
      let body: ArrayBuffer | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          body = await c.req.arrayBuffer();
        } catch {}
      }
      for (const sub of apps) {
        const req = new Request(c.req.url, { method, headers: c.req.raw.headers, body });
        const res = await sub.fetch(req, env, exec);
        if (res.headers.get(UNMATCHED_HEADER) !== '1') return res;
      }
    }
    return c.text('404 Not Found', 404);
  });
  return app;
}

/**
 * Runtime helper: dispatch a request to `kernel.http` with the resolved route.
 * `env` carries extra runtime bindings (e.g. Cloudflare env); `route` is added to it.
 */
export function dispatchHttp(
  kernel: Pick<Kernel, 'http'>,
  req: Request,
  route: RouteContext,
  env: Record<string, unknown> = {},
  executionCtx?: Parameters<Hono<KernelEnv>['fetch']>[2],
): Response | Promise<Response> {
  return kernel.http.fetch(req, { ...env, route }, executionCtx);
}

/**
 * Runtime helper: run the kernel's request gates. Returns a Response when a gate
 * stops the request. `clientIp` is a thunk so runtimes only resolve/expose the raw
 * IP when at least one gate is registered.
 */
export async function runRequestGates(
  kernel: Pick<Kernel, 'gates'>,
  req: Request,
  ctx: Omit<RequestGateContext, 'clientIp'> & { clientIp?: () => string | undefined },
): Promise<Response | undefined> {
  const gates = kernel.gates;
  if (!gates || gates.length === 0) return undefined;
  const ip = ctx.clientIp?.();
  const gctx: RequestGateContext = { route: ctx.route, upgrade: ctx.upgrade };
  if (ip) gctx.clientIp = ip;
  for (const g of gates) {
    const res = await g.check(req, gctx);
    if (res) return res;
  }
  return undefined;
}

export function topoSort(modules: BeamhopModule[]): BeamhopModule[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const out: BeamhopModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (m: BeamhopModule) => {
    const s = state.get(m.id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`module dependency cycle at ${m.id}`);
    state.set(m.id, 'visiting');
    for (const dep of m.dependsOn ?? []) {
      const d = byId.get(dep);
      if (!d) throw new Error(`module ${m.id} depends on missing module ${dep}`);
      visit(d);
    }
    state.set(m.id, 'done');
    out.push(m);
  };
  for (const m of modules) visit(m);
  return out;
}

/** Helper for module authors. */
export function defineModule(m: BeamhopModule): BeamhopModule {
  return m;
}

export type { ActionDef, PolicyHooks };

/** Logger that forwards to `inner` and reports each line (with child fields) to `listeners`. */
function teeLogger(
  inner: Logger,
  base: Record<string, unknown>,
  listeners: Set<LogListener>,
  nowMs: () => number,
): Logger {
  return {
    log(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
      inner.log(level, msg, fields);
      if (listeners.size === 0) return;
      const rec = { at: nowMs(), level, msg, fields: { ...base, ...fields } };
      for (const l of listeners) {
        try {
          l(rec);
        } catch {
          // a broken listener never breaks logging
        }
      }
    },
    child(fields: Record<string, unknown>) {
      return teeLogger(inner.child(fields), { ...base, ...fields }, listeners, nowMs);
    },
  };
}
