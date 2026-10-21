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
import { EventBus } from './bus.ts';
import type { BeamhopConfig, EffectiveLimits, RelayConfig } from './config.ts';
import type { Connection, RequestGate, RequestGateContext, RouteContext } from './connection.ts';
import { PolicyPipeline } from './policy.ts';
import type { PolicyHooks } from './policy.ts';
import type { Notification, Ports, RelayId, RuntimeName } from './ports.ts';

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

export async function createKernel(opts: KernelOptions): Promise<Kernel> {
  let current = opts.config;
  const listeners = new Set<(n: BeamhopConfig, p: BeamhopConfig) => void>();
  const services = new Map<string, unknown>();
  const enabled = new Set<string>();
  let limitsResolver: ((relay: RelayConfig, tier?: string) => EffectiveLimits) | null = null;
  let notifier: (n: Notification) => Promise<void> = async () => {};

  const kernel: Kernel = {
    runtime: opts.runtime,
    ports: opts.ports,
    bus: new EventBus(),
    policy: new PolicyPipeline(),
    actions: new ActionRegistry(),
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
    async applyConfig(next) {
      const prev = current;
      current = next;
      for (const l of listeners) l(next, prev);
    },
    onConfigChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    moduleConfig<T>(id: string) {
      return current.modules[id] as T | undefined;
    },
    http: createKernelHttp(),
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
      services.set(name, service);
    },
    use<T>(name: string) {
      return services.get(name) as T | undefined;
    },
  };

  const ordered = topoSort(opts.modules);
  for (const m of ordered) {
    if (m.configSchema) {
      const raw = current.modules[m.id];
      current = {
        ...current,
        modules: { ...current.modules, [m.id]: m.configSchema.parse(raw ?? {}) },
      };
    }
    await m.register(kernel);
    enabled.add(m.id);
  }
  for (const m of ordered) await m.start?.(kernel);
  return kernel;
}

/**
 * Kernel Hono app with a first middleware that copies `env.route` (passed by the
 * runtime via {@link dispatchHttp}) into the `route` variable, before any module route runs.
 */
function createKernelHttp(): Hono<KernelEnv> {
  const app = new Hono<KernelEnv>();
  app.use('*', async (c, next) => {
    const env = c.env as { route?: RouteContext } | undefined;
    if (env && typeof env === 'object' && env.route) c.set('route', env.route);
    await next();
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
