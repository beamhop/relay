// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cloudflare runtime wiring: Worker `fetch`/`scheduled` handlers and the
 * `RelayRoom` Durable Object class, built from statically bundled modules.
 *
 * Request flow:
 *   Worker fetch ─ resolveRelay(Host, path) ─┬─ WebSocket upgrade → RelayRoom `<relay>#<shard>`
 *                                            └─ HTTP → kernel.http (Hono), kernel cached per isolate
 *   Cron Trigger → CronScheduler.runDue() on the Worker kernel
 */
import {
  type BeamhopConfig,
  type BeamhopModule,
  type Clock,
  type Kernel,
  type Logger,
  type MediaProcessor,
  type PubSub,
  type RouteContext,
  type Scheduler,
  createKernel,
  defineModule,
  parseConfig,
  resolveRelay,
  runRequestGates,
} from '@beamhop/core';
import { type AdapterImporters, type LoadedStores, loadStores } from './adapters.ts';
import type {
  DurableObjectStateLike,
  ExecutionContextLike,
  HibernatableWebSocket,
  ScheduledControllerLike,
} from './cf-types.ts';
import { type CfEnv, numberVar, shardCount } from './env.ts';
import { type BundledModules, resolveModules } from './plugins.ts';
import { CfCrypto, CfLogger, type LogSink, cfClock, parseLogLevel } from './ports/basic.ts';
import { type GuardOptions, GuardedEventStore } from './ports/guards.ts';
import { CfImagesMediaProcessor } from './ports/media.ts';
import { ShardedPubSub, shardName } from './ports/pubsub.ts';
import { CronScheduler } from './ports/scheduler.ts';
import {
  CONFIG_CHANNEL,
  H_COUNTRY,
  H_IP_HASH,
  H_RELAY,
  H_SHARD,
  RelayRoomCore,
  type RoomHooks,
} from './room.ts';

/** Key under which the route context is passed to Hono as `c.env[ROUTE_ENV_KEY]`. */
export const ROUTE_ENV_KEY = 'beamhopRoute';

/**
 * Registered first: copies the route context the runtime resolved into the Hono
 * `route` variable so every module route sees `c.var.route`.
 */
export const cfRuntimeModule: BeamhopModule = defineModule({
  id: 'runtime-cf',
  register(kernel) {
    kernel.http.use('*', async (c, next) => {
      const route = (c.env as Record<string, unknown> | undefined)?.[ROUTE_ENV_KEY];
      if (route) c.set('route', route as RouteContext);
      await next();
    });
  },
});

/** Module id of the plugin host (`createBundledPluginHost` from `@beamhop/plugins`). */
export const PLUGIN_HOST_ID = 'plugins';

export interface CloudflareRuntimeOptions extends BundledModules {
  /** Config bundled at build time (raw; validated with `parseConfig`). `BEAMHOP_CONFIG` wins. */
  config?: unknown;
  /** Extra modules registered after the runtime module (tests, custom builds). */
  modules?: BeamhopModule[];
  importers?: AdapterImporters;
  room?: RoomHooks;
  queryGuard?: Omit<GuardOptions, 'logger'>;
  logSink?: LogSink;
  clock?: Clock;
}

export interface SharedServices {
  env: CfEnv;
  logger: Logger;
  clock: Clock;
  crypto: CfCrypto;
  stores: LoadedStores;
  media?: MediaProcessor;
  shards: number;
  baseConfig: BeamhopConfig;
  modules: BeamhopModule[];
  createKernel(over: { pubsub: PubSub; scheduler: Scheduler; logger?: Logger }): Promise<Kernel>;
}

export interface WorkerContext {
  services: SharedServices;
  kernel: Kernel;
  scheduler: CronScheduler;
  pubsub: ShardedPubSub;
}

export function loadConfig(env: Pick<CfEnv, 'BEAMHOP_CONFIG'>, bundled: unknown): BeamhopConfig {
  if (env.BEAMHOP_CONFIG) return parseConfig(JSON.parse(env.BEAMHOP_CONFIG));
  return parseConfig(bundled ?? {});
}

function randomShard(shards: number): number {
  if (shards <= 1) return 0;
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return (b[0] as number) % shards;
}

/** ISO 3166 country from Cloudflare's `cf-ipcountry` (`XX` unknown and `T1` Tor are dropped). */
export function cfCountry(req: Request): string | undefined {
  const v = req.headers.get('cf-ipcountry')?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) && v !== 'XX' ? v : undefined;
}

function isUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

/** Per-isolate cache keyed by the env object (stable for an isolate's lifetime). */
function cached<T>(build: (env: CfEnv) => Promise<T>): (env: CfEnv) => Promise<T> {
  const cache = new WeakMap<CfEnv, Promise<T>>();
  return (env) => {
    let p = cache.get(env);
    if (!p) {
      p = build(env);
      cache.set(env, p);
      // Do not cache failures: the next request retries.
      p.catch(() => cache.delete(env));
    }
    return p;
  };
}

export function createCloudflareRuntime(opts: CloudflareRuntimeOptions = {}) {
  const shared = cached<SharedServices>(async (env) => {
    const clock = opts.clock ?? cfClock;
    const logger = new CfLogger(
      parseLogLevel(env.LOG_LEVEL),
      { runtime: 'cloudflare' },
      opts.logSink,
    );
    const crypto = new CfCrypto(env.IP_HASH_SALT, clock, () =>
      logger.log('warn', 'IP_HASH_SALT secret is not set; using a temporary salt', {
        technical: 'wrangler secret put IP_HASH_SALT',
      }),
    );
    const baseConfig = loadConfig(env, opts.config);
    const stores = await loadStores(env, logger, opts.importers);
    const events = new GuardedEventStore(stores.events, {
      budgetMs: numberVar(env.QUERY_BUDGET_MS, 2000),
      ...opts.queryGuard,
      logger,
    });
    const media = env.IMAGES ? new CfImagesMediaProcessor(env.IMAGES) : undefined;
    // With the bundled plugin host (`@beamhop/plugins`) in `modules`, it loads the
    // enabled plugins itself; resolving them here too would register them twice.
    const hostLoaded = (opts.modules ?? []).some((m) => m.id === PLUGIN_HOST_ID);
    const modules = [
      cfRuntimeModule,
      ...(opts.modules ?? []),
      ...resolveModules(
        hostLoaded ? { builtins: opts.builtins ?? {} } : opts,
        hostLoaded ? { ...baseConfig, plugins: [] } : baseConfig,
        (msg, fields) => logger.log('warn', msg, fields),
      ),
    ];
    const services: SharedServices = {
      env,
      logger,
      clock,
      crypto,
      stores,
      shards: shardCount(env),
      baseConfig,
      modules,
      createKernel: (over) =>
        createKernel({
          runtime: 'cloudflare',
          config: baseConfig,
          modules,
          ports: {
            events,
            blobs: stores.blobs,
            blobIndex: stores.blobIndex,
            docs: stores.docs,
            metrics: stores.metrics,
            pubsub: over.pubsub,
            scheduler: over.scheduler,
            clock,
            logger: over.logger ?? logger,
            crypto,
            ...(media ? { media } : {}),
          },
        }),
    };
    if (media) services.media = media;
    return services;
  });

  const workerContext = cached<WorkerContext>(async (env) => {
    const services = await shared(env);
    const pubsub = new ShardedPubSub({
      namespace: env.RELAY_ROOM,
      relayIds: () => (ctx.kernel?.config() ?? services.baseConfig).relays.map((r) => r.id),
      shards: services.shards,
      logger: services.logger,
    });
    const scheduler = new CronScheduler(services.stores.docs, services.logger);
    const ctx = { services, pubsub, scheduler } as WorkerContext;
    ctx.kernel = await services.createKernel({ pubsub, scheduler });
    // Propagate config revisions committed in the Worker to every room's kernel.
    ctx.kernel.onConfigChange((next) => {
      void pubsub.publish(CONFIG_CHANNEL, next);
    });
    return ctx;
  });

  async function fetch(
    req: Request,
    env: CfEnv,
    execCtx?: ExecutionContextLike,
  ): Promise<Response> {
    let ctx: WorkerContext;
    try {
      ctx = await workerContext(env);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'Startup failed', error: String(err) }));
      return new Response('The server could not start. Check the logs.', { status: 500 });
    }
    const { kernel, services } = ctx;
    const url = new URL(req.url);
    const relay = resolveRelay(kernel.config(), url, req.headers.get('host'));
    if (!relay) {
      return new Response('No relay is configured for this address.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const ip = req.headers.get('cf-connecting-ip');
    const ipHash = ip ? services.crypto.hashIp(ip) : 'unknown';
    const country = cfCountry(req);
    const route: RouteContext = {
      relayId: relay.id,
      publicUrl: `${url.protocol}//${url.host}${relay.pathPrefix ?? ''}`,
      ipHash,
      ...(country ? { country } : {}),
    };
    // Opt-in request gates (network controls); no-op and no raw IP exposure without gates.
    if (kernel.gates?.length) {
      try {
        const denied = await runRequestGates(kernel, req, {
          route,
          upgrade: isUpgrade(req),
          clientIp: () => ip ?? undefined,
        });
        if (denied) return denied;
      } catch (err) {
        services.logger.log('error', 'Request gate failed', { error: String(err) });
        return new Response('Access check failed.', { status: 503 });
      }
    }

    if (isUpgrade(req)) {
      const shard = randomShard(services.shards);
      const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(shardName(relay.id, shard)));
      const headers = new Headers(req.headers);
      // Rooms only ever see the hashed IP.
      for (const h of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip']) {
        headers.delete(h);
      }
      headers.set(H_RELAY, relay.id);
      headers.set(H_SHARD, String(shard));
      headers.set(H_IP_HASH, ipHash);
      if (country) headers.set(H_COUNTRY, country);
      else headers.delete(H_COUNTRY);
      return stub.fetch(new Request(req.url, { method: req.method, headers }));
    }

    try {
      return await kernel.http.fetch(
        req,
        { ...env, [ROUTE_ENV_KEY]: route },
        execCtx as Parameters<typeof kernel.http.fetch>[2],
      );
    } catch (err) {
      services.logger.log('error', 'Request failed', { error: String(err), path: url.pathname });
      return new Response('Something went wrong.', { status: 500 });
    }
  }

  async function scheduled(
    controller: ScheduledControllerLike,
    env: CfEnv,
    _execCtx?: ExecutionContextLike,
  ): Promise<string[]> {
    const ctx = await workerContext(env);
    return ctx.scheduler.runDue(controller.scheduledTime);
  }

  const roomHooks = opts.room;

  /** Durable Object class; export it from the Worker entry as `RelayRoom`. */
  class RelayRoom {
    readonly core: RelayRoomCore;

    constructor(state: DurableObjectStateLike, env: CfEnv) {
      this.core = new RelayRoomCore(state, () => shared(env), roomHooks);
    }

    fetch(req: Request): Promise<Response> {
      return this.core.fetch(req);
    }

    webSocketMessage(ws: HibernatableWebSocket, message: string | ArrayBuffer): Promise<void> {
      return this.core.webSocketMessage(ws, message);
    }

    webSocketClose(ws: HibernatableWebSocket, code: number, reason: string): Promise<void> {
      return this.core.webSocketClose(ws, code, reason);
    }

    webSocketError(ws: HibernatableWebSocket): Promise<void> {
      return this.core.webSocketError(ws);
    }

    alarm(): Promise<void> {
      return this.core.alarm();
    }
  }

  return {
    worker: { fetch, scheduled },
    RelayRoom,
    /** Exposed for tests and tooling. */
    internals: { shared, workerContext },
  };
}

export type CloudflareRuntime = ReturnType<typeof createCloudflareRuntime>;
