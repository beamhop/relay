// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `startServer`: Bun.serve + native WebSockets in front of the kernel.
 *
 * Request flow: ACME challenge → /healthz → proxy self-check → admin PWA assets →
 * resolve virtual relay (Host + path prefix) → WS upgrade to `kernel.ws` or
 * dispatch to `kernel.http` with the `route` variable set.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  BEAMHOP_VERSION,
  type BeamhopConfig,
  type BeamhopModule,
  type Kernel,
  type Logger,
  type OptionalModuleSource,
  type Ports,
  type RouteContext,
  createKernel,
  defineModule,
  dispatchHttp,
  manageOptionalModules,
  parseConfig,
  resolveRelay,
  runRequestGates,
  topoSort,
} from '@beamhop/core';
import type { Server } from 'bun';
import { type AssetServer, createAssetServer } from './assets.ts';
import { installConfigWriteBack } from './config-writeback.ts';
import { type DataLayout, ensureDataDir, parseListen, withDataDirDefaults } from './config.ts';
import { BunConnection, type WsData } from './connection.ts';
import { manageFollowingModules, optionalModuleSources } from './modules.ts';
import { JsonLogger } from './ports.ts';
import {
  DISK_SERVICE,
  HOST_SERVICE,
  PROCESS_SERVICE,
  TLS_SERVICE,
  countryFrom,
  diskService,
  hostService,
  tlsService,
} from './runtime-services.ts';
import {
  type ClaimCode,
  type ConfigServiceLike,
  lastKnownGood,
  obtainClaimCode,
} from './services.ts';
import { type StorageLoaders, createDefaultPorts } from './storage.ts';
import { createTeamApp } from './team.ts';
import {
  type AcmeBackend,
  AcmeManager,
  ChallengeStore,
  type EffectiveTls,
  acmeDomains,
  decideTls,
} from './tls.ts';
import { VerifyPool, defaultVerifyWorkers } from './verify-pool.ts';

/** Release version (root package.json, or the build-time `__BEAMHOP_VERSION__` define). */
export const VERSION = BEAMHOP_VERSION;
export const SELF_CHECK_PATH = '/.well-known/beamhop/self-check';
export const HEALTH_PATH = '/healthz';
export const ADMIN_MOUNT = '/admin';

const REQUIRED_PORTS: Array<keyof Ports> = [
  'events',
  'blobs',
  'blobIndex',
  'docs',
  'metrics',
  'pubsub',
  'scheduler',
  'clock',
  'logger',
  'crypto',
];

export interface StartServerOptions {
  config: BeamhopConfig;
  modules: BeamhopModule[];
  /** Port overrides. If complete, used as-is (tests); otherwise missing ports use Bun defaults. */
  ports?: Partial<Ports>;
  /** Override `node.listen` (use port 0 for an ephemeral port). */
  hostname?: string;
  port?: number;
  /** Safe mode: last-known-good config, plugins disabled. */
  safe?: boolean;
  logger?: Logger;
  /** Human-facing console output (banner, claim code). Defaults to stdout. */
  print?: (line: string) => void;
  /** Config file applied at boot; offered to `admin.config` as a new revision. */
  bootFile?: string;
  /**
   * Write settings changed in the admin app back to `bootFile` (GitOps, §3.4).
   * Default true; off in safe mode.
   */
  configWriteBack?: boolean;
  /** Config paths set by env vars / CLI flags; never written back to `bootFile`. */
  overridePaths?: string[][];
  tls?: {
    publicIps?: () => string[];
    acmeBackend?: AcmeBackend;
    directoryUrl?: string;
    /** Port for HTTP-01 challenges + redirect in ACME mode (default 80). */
    httpPort?: number;
  };
  /** Admin PWA on disk (dev); embedded assets take precedence. */
  pwaDir?: string;
  /** Team app build on disk (dev); embedded assets take precedence. Served at /app when `modules.team.enabled`. */
  teamDir?: string;
  /** Unmatched hosts are still dispatched (with `relayId: ''`) for these node-scope prefixes. */
  nodeScopePrefixes?: string[];
  shutdownTimeoutMs?: number;
  storageLoaders?: StorageLoaders;
  /** Max inbound WS frame (bytes). Per-relay limits are enforced by the relay module. */
  maxPayloadLength?: number;
  /**
   * Optional modules hot-loaded when their `config.modules[id]` section appears (and
   * unloaded when it disappears). Default: the enterprise packages of
   * {@link DEFAULT_MODULE_PACKAGES}; `false` turns hot loading off.
   */
  optionalModules?: OptionalModuleSource[] | false;
}

/** Service id of {@link bunRuntimeModule}'s secret file reader (key vault `kek.keyFile`). */
export const SECRET_FILES_SERVICE = 'runtime.secret-files';

/** Registered first: runtime services modules may need while registering. */
export function bunRuntimeModule(): BeamhopModule {
  return defineModule({
    id: 'runtime-bun',
    register(kernel) {
      kernel.provide(SECRET_FILES_SERVICE, {
        read: (path: string) => readFile(path, 'utf8'),
      });
    },
  });
}

export interface RunningServer {
  readonly kernel: Kernel;
  readonly ports: Ports;
  readonly server: Server<WsData>;
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly tls: EffectiveTls;
  readonly safe: boolean;
  readonly firstBoot: boolean;
  readonly claim: ClaimCode | null;
  readonly adminUrl: string;
  readonly layout: DataLayout;
  readonly memoryFallbacks: string[];
  connections(): number;
  stop(reason?: string): Promise<void>;
}

interface RequestMeta {
  ip: string;
  host: string;
  proto: 'http' | 'https';
}

function firstHeaderValue(v: string | null): string | undefined {
  const first = v?.split(',')[0]?.trim();
  return first || undefined;
}

function requestMeta(
  req: Request,
  url: URL,
  server: Server<WsData>,
  trustProxy: boolean,
  tlsActive: boolean,
): RequestMeta {
  let ip = server.requestIP(req)?.address ?? '0.0.0.0';
  let host = req.headers.get('host') ?? url.host;
  let proto: 'http' | 'https' = tlsActive || url.protocol === 'https:' ? 'https' : 'http';
  if (trustProxy) {
    const fwdFor =
      firstHeaderValue(req.headers.get('x-forwarded-for')) ??
      firstHeaderValue(req.headers.get('x-real-ip'));
    if (fwdFor) ip = fwdFor;
    const fwdHost = firstHeaderValue(req.headers.get('x-forwarded-host'));
    if (fwdHost) host = fwdHost;
    const fwdProto = firstHeaderValue(req.headers.get('x-forwarded-proto'))?.toLowerCase();
    if (fwdProto === 'https' || fwdProto === 'http') proto = fwdProto;
  }
  return { ip, host, proto };
}

const isWsUpgrade = (req: Request) =>
  (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function stripPrefix(req: Request, url: URL, prefix: string): Request {
  if (!prefix || !url.pathname.startsWith(prefix)) return req;
  const next = new URL(url);
  next.pathname = url.pathname.slice(prefix.length) || '/';
  return new Request(next, req);
}

/** Copy the values at `paths` from `from` into `into` (env/flag overrides beat saved settings). */
function withPaths(into: Record<string, unknown>, from: unknown, paths: string[][]) {
  for (const path of paths) {
    let src: unknown = from;
    for (const k of path) src = (src as Record<string, unknown> | undefined)?.[k];
    if (src === undefined) continue;
    let dst = into;
    for (const k of path.slice(0, -1)) {
      if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {};
      dst = dst[k] as Record<string, unknown>;
    }
    dst[path[path.length - 1] as string] = structuredClone(src);
  }
  return into;
}

function safeConfig(cfg: BeamhopConfig): BeamhopConfig {
  return { ...cfg, plugins: cfg.plugins.map((p) => ({ ...p, enabled: false })) };
}

function adminBaseUrl(config: BeamhopConfig, tls: EffectiveTls, port: number): string {
  const host = config.relays.flatMap((r) => r.hosts).find((h) => h !== '*' && !h.includes('*'));
  if (host && tls !== 'off') return `https://${host}`;
  if (host) return `http://${host}${port === 80 ? '' : `:${port}`}`;
  return `http://localhost:${port}`;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const layout = ensureDataDir(opts.config.node.dataDir);
  let bootConfig = withDataDirDefaults(opts.config, layout);
  const safe = opts.safe ?? false;
  const print = opts.print ?? ((line: string) => process.stdout.write(`${line}\n`));

  // ── Ports ──
  const logger =
    opts.logger ??
    opts.ports?.logger ??
    new JsonLogger({ level: (process.env.BEAMHOP_LOG_LEVEL as 'info') ?? 'info' });
  const complete = REQUIRED_PORTS.every((k) => opts.ports?.[k]);
  let closeDefaults: (() => Promise<void>) | undefined;
  let memoryFallbacks: string[] = [];
  let ports: Ports;
  let sqlService: { exec: unknown; path?: string; url?: string } | undefined;
  if (complete) {
    ports = opts.ports as Ports;
  } else {
    const defaults = await createDefaultPorts(bootConfig, layout, logger, opts.storageLoaders);
    ports = { ...defaults.ports, ...opts.ports, logger } as Ports;
    closeDefaults = defaults.close;
    memoryFallbacks = defaults.memoryFallbacks.filter((k) => !opts.ports?.[k as keyof Ports]);
    if (!opts.ports?.events) sqlService = defaults.sql;
  }

  // ── Signature checks off the event loop (PLAN §3.5) ──
  let verifyPool: VerifyPool | undefined;
  const verifyWorkers = bootConfig.node.verifyWorkers;
  if (!ports.verifier && verifyWorkers !== 0) {
    verifyPool = new VerifyPool({
      workers: verifyWorkers ?? defaultVerifyWorkers(),
      logger: logger.child({ component: 'verify' }),
    });
    ports = { ...ports, verifier: verifyPool };
  }

  // ── Kernel ──
  if (safe) {
    bootConfig = safeConfig(bootConfig);
    logger.log('warn', 'starting in SAFE MODE: plugins disabled, last known good settings', {});
  }
  const kernel = await createKernel({
    runtime: 'bun',
    ports,
    config: bootConfig,
    modules: [bunRuntimeModule(), ...opts.modules],
  });
  // Runtime facts for modules (lifecycle: safe mode, data dir, SQL snapshots).
  kernel.provide('runtime', { name: 'bun', safe, dataDir: layout.root });
  if (sqlService) kernel.provide('storage.sql', sqlService);
  kernel.provide(DISK_SERVICE, diskService(layout.root));
  kernel.provide(HOST_SERVICE, hostService(verifyPool?.size ?? 0));
  // Optional (enterprise) modules: hot-load/unload when `config.modules[id]` appears/disappears.
  if (opts.optionalModules !== false) {
    manageOptionalModules(
      kernel,
      opts.optionalModules ??
        optionalModuleSources({ secretsDir: layout.secretsDir, env: process.env }, logger),
    );
  }

  // Modules that follow a settings switch (the assistant on `ai.enabled`).
  if (opts.optionalModules !== false) manageFollowingModules(kernel, logger);

  if (safe) {
    const lkg = await lastKnownGood(kernel);
    if (lkg) {
      // Keep this boot's node section (listen address, data dir) — it got us running.
      const restored = parseConfig({ ...lkg, node: bootConfig.node });
      await kernel.applyConfig(safeConfig(withDataDirDefaults(restored, layout)));
      logger.log('warn', 'safe mode: restored last known good settings', {});
    } else {
      logger.log('warn', 'safe mode: no saved known-good settings; using boot settings', {});
    }
  } else if (opts.bootFile) {
    const svc = kernel.use<ConfigServiceLike>('admin.config');
    try {
      await svc?.adoptBootConfig?.(bootConfig, { source: 'file', path: opts.bootFile });
    } catch (err) {
      logger.log('error', 'could not record config file as a new revision', { err });
    }
  } else {
    // No settings file: what the app saved last is the source of truth after a restart.
    // This boot's node section (listen, data dir) and env/flag overrides still win.
    const saved = await kernel
      .use<ConfigServiceLike>('admin.config')
      ?.current?.()
      .catch((err: unknown) => {
        logger.log('error', 'saved settings could not be read', { err });
        return undefined;
      });
    if (saved && saved.revision > 1) {
      const raw = withPaths(
        { ...structuredClone(saved.config), node: bootConfig.node },
        bootConfig,
        opts.overridePaths ?? [],
      );
      try {
        await kernel.applyConfig(withDataDirDefaults(parseConfig(raw), layout));
        logger.log('info', 'saved settings restored', { revision: saved.revision });
      } catch (err) {
        logger.log('error', 'saved settings could not be applied; using boot settings', { err });
      }
    }
  }
  if (opts.bootFile) {
    if (safe) {
      logger.log('info', 'safe mode: app changes are not written to the settings file', {});
    } else if (opts.configWriteBack === false) {
      logger.log('info', 'writing app changes to the settings file is off', {
        file: opts.bootFile,
      });
    } else {
      installConfigWriteBack(kernel, {
        path: opts.bootFile,
        overridePaths: opts.overridePaths,
        logger: logger.child({ component: 'config-file' }),
      });
    }
  }

  // ── Listen / TLS ──
  const listen = parseListen(bootConfig.node.listen);
  const hostname = opts.hostname ?? listen.hostname;
  const wantedPort = opts.port ?? listen.port;
  const challenges = new ChallengeStore();
  let tlsDecision = decideTls(kernel.config(), wantedPort, opts.tls?.publicIps);
  let tlsOptions: { cert: string; key: string } | undefined;
  let httpServer: Server<undefined> | undefined;
  let acme: AcmeManager | undefined;

  if (tlsDecision.mode === 'acme') {
    const domains = acmeDomains(kernel.config());
    try {
      httpServer = Bun.serve({
        hostname,
        port: opts.tls?.httpPort ?? 80,
        fetch(req) {
          const url = new URL(req.url);
          const c = challenges.respond(url.pathname);
          if (c) return c;
          if (url.pathname === HEALTH_PATH) return json({ status: 'ok' });
          const target = new URL(url);
          target.protocol = 'https:';
          // HTTP-01 needs public :80, so public HTTPS is the standard :443 (even when
          // the container listens elsewhere behind a port mapping).
          target.port = '';
          return Response.redirect(target.toString(), 301);
        },
      });
      acme = new AcmeManager({
        tlsDir: layout.tlsDir,
        domains,
        email: bootConfig.node.tls.email,
        directoryUrl: opts.tls?.directoryUrl ?? process.env.BEAMHOP_ACME_DIRECTORY,
        challenges,
        logger: logger.child({ component: 'acme' }),
        backend: opts.tls?.acmeBackend,
      });
      const { pair } = await acme.ensure();
      tlsOptions = { cert: pair.cert, key: pair.key };
    } catch (err) {
      logger.log('error', 'could not get a TLS certificate; falling back to proxy mode', { err });
      tlsDecision = { mode: 'proxy', reason: 'ACME failed' };
      acme = undefined;
    }
  }
  logger.log('info', 'TLS mode decided', { mode: tlsDecision.mode, reason: tlsDecision.reason });
  kernel.provide(
    TLS_SERVICE,
    tlsService(
      () => tlsDecision.mode,
      () => acme,
    ),
  );

  // ── HTTP / WS ──
  const assets: AssetServer = createAssetServer({ mount: ADMIN_MOUNT, dir: opts.pwaDir });
  const teamApp = createTeamApp(kernel, { dir: opts.teamDir });
  // `/scim/`: company directory provisioning is node-wide (404 unless company sign-in is on).
  const nodeScope = opts.nodeScopePrefixes ?? [`${ADMIN_MOUNT}/`, '/api/', '/scim/'];
  const conns = new Set<BunConnection>();
  const startedAt = ports.clock.nowMs();
  let draining = false;

  const fetch = async (req: Request, server: Server<WsData>): Promise<Response | undefined> => {
    const url = new URL(req.url);
    const challenge = challenges.respond(url.pathname);
    if (challenge) return challenge;
    const cfg = kernel.config();
    const meta = requestMeta(req, url, server, cfg.node.trustProxy, !!tlsOptions);

    if (url.pathname === HEALTH_PATH) {
      return json(
        {
          status: draining ? 'draining' : 'ok',
          version: VERSION,
          safeMode: safe,
          tls: tlsDecision.mode,
          uptimeSeconds: Math.floor((ports.clock.nowMs() - startedAt) / 1000),
          connections: conns.size,
          memoryStorage: memoryFallbacks.length > 0,
        },
        draining ? 503 : 200,
      );
    }
    if (draining) return new Response('server is shutting down', { status: 503 });

    if (url.pathname === SELF_CHECK_PATH) {
      const nonce = url.searchParams.get('nonce') ?? undefined;
      if (isWsUpgrade(req)) {
        const ok = server.upgrade(req, { data: { selfCheck: { nonce, nodeId: cfg.node.id } } });
        return ok ? undefined : new Response('upgrade failed', { status: 400 });
      }
      return json(selfCheck(req, cfg, meta, tlsDecision.mode, nonce));
    }

    // Opt-in request gates (network controls); no-op and no raw IP exposure without gates.
    const clientIp = () => meta.ip;
    const asset = assets.serve(req, url.pathname);
    if (asset) {
      if (!kernel.gates?.length) return asset;
      const route: RouteContext = {
        relayId: '',
        publicUrl: `${meta.proto}://${meta.host}`,
        ipHash: ports.crypto.hashIp(meta.ip),
      };
      return (await runRequestGates(kernel, req, { route, upgrade: false, clientIp })) ?? asset;
    }

    const ipHash = ports.crypto.hashIp(meta.ip);
    const country = countryFrom(req, cfg);
    const relay = resolveRelay(cfg, url, meta.host);
    const team = await teamApp.serve(
      req,
      url.pathname,
      relay
        ? { relayId: relay.id, publicUrl: `${meta.proto}://${meta.host}${relay.pathPrefix ?? ''}` }
        : {},
    );
    if (team) return team;
    if (!relay) {
      if (nodeScope.some((p) => url.pathname.startsWith(p))) {
        const route: RouteContext = {
          relayId: '',
          publicUrl: `${meta.proto}://${meta.host}`,
          ipHash,
          ...(country ? { country } : {}),
        };
        const denied = await runRequestGates(kernel, req, { route, upgrade: false, clientIp });
        if (denied) return denied;
        return dispatchHttp(kernel, req, route);
      }
      return new Response('No relay is configured for this address.', { status: 404 });
    }

    const prefix = relay.pathPrefix ?? '';
    const route: RouteContext = {
      relayId: relay.id,
      publicUrl: `${meta.proto}://${meta.host}${prefix}`,
      ipHash,
      ...(country ? { country } : {}),
    };

    const denied = await runRequestGates(kernel, req, {
      route,
      upgrade: isWsUpgrade(req),
      clientIp,
    });
    if (denied) return denied;

    if (isWsUpgrade(req) && kernel.ws) {
      const conn = new BunConnection(
        ports.crypto.randomHex(8),
        relay.id,
        ipHash,
        ports.clock.now(),
        ports.crypto.randomHex(16),
        req.headers.get('user-agent') ?? undefined,
        country,
        meta.host.toLowerCase().replace(/:\d+$/, ''),
      );
      if (server.upgrade(req, { data: { conn } })) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    return dispatchHttp(kernel, stripPrefix(req, url, prefix), route);
  };

  const wsLog = logger.child({ component: 'ws' });
  const server = Bun.serve({
    hostname,
    port: wantedPort,
    ...(tlsOptions ? { tls: tlsOptions } : {}),
    fetch,
    error(err) {
      logger.log('error', 'request failed', { err });
      return new Response('Internal error', { status: 500 });
    },
    websocket: {
      data: {} as WsData,
      maxPayloadLength: opts.maxPayloadLength ?? 4 * 1024 * 1024,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        if (ws.data.selfCheck) {
          ws.send(
            JSON.stringify({
              type: 'beamhop-self-check',
              ok: true,
              nodeId: ws.data.selfCheck.nodeId,
              nonce: ws.data.selfCheck.nonce,
            }),
          );
          ws.close(1000, 'self-check ok');
          return;
        }
        const conn = ws.data.conn;
        if (!conn) return ws.close(1011, 'no connection');
        conn.attach(ws);
        conns.add(conn);
        if (draining) return conn.close(1001, 'server is restarting');
        try {
          kernel.ws?.onOpen(conn);
        } catch (err) {
          wsLog.log('error', 'ws open handler failed', { err, conn: conn.id });
        }
      },
      message(ws, message) {
        const conn = ws.data.conn;
        if (!conn) return;
        const raw = typeof message === 'string' ? message : Buffer.from(message).toString('utf8');
        try {
          kernel.ws?.onMessage(conn, raw);
        } catch (err) {
          wsLog.log('error', 'ws message handler failed', { err, conn: conn.id });
        }
      },
      close(ws) {
        const conn = ws.data.conn;
        if (!conn || !conns.has(conn)) return;
        conns.delete(conn);
        conn.closed = true;
        try {
          kernel.ws?.onClose(conn);
        } catch (err) {
          wsLog.log('error', 'ws close handler failed', { err, conn: conn.id });
        }
      },
    },
  });

  const port = server.port ?? wantedPort;
  const url = `${tlsOptions ? 'https' : 'http'}://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`;

  // ── Certificate renewal ──
  if (acme) {
    const manager = acme;
    ports.scheduler.every('runtime.tls.renew', 12 * 3600, async () => {
      const { pair, renewed } = await manager.ensure();
      if (!renewed) return;
      try {
        server.reload({ fetch, tls: { cert: pair.cert, key: pair.key } } as never);
        logger.log('info', 'TLS certificate renewed and loaded', {});
      } catch (err) {
        logger.log('warn', 'certificate renewed; restart to load it', { err });
      }
    });
  }

  // ── First boot / claim ──
  const firstBoot = !existsSync(layout.stateFile);
  if (firstBoot) {
    writeFileSync(
      layout.stateFile,
      JSON.stringify({
        firstBootAt: new Date(ports.clock.nowMs()).toISOString(),
        version: VERSION,
      }),
    );
  } else {
    try {
      JSON.parse(readFileSync(layout.stateFile, 'utf8'));
    } catch {
      logger.log('warn', 'state.json is unreadable; ignoring', {});
    }
  }
  let claim: ClaimCode | null = null;
  try {
    claim = await obtainClaimCode(kernel);
  } catch (err) {
    logger.log('error', 'could not create a claim code', { err });
  }
  const adminUrl =
    claim?.url ?? `${adminBaseUrl(kernel.config(), tlsDecision.mode, port)}${ADMIN_MOUNT}/`;
  if (firstBoot || claim) {
    print('');
    print('  Beamhop is running.');
    print(`  Admin:       ${adminUrl}`);
    if (claim)
      print(
        `  Claim code:  ${claim.code}   (one-time — enter it in the admin app to become owner)`,
      );
    if (safe) print('  SAFE MODE:   plugins are off and the last known good settings are in use.');
    if (memoryFallbacks.length)
      print('  WARNING:     storage is in memory — data will be lost on restart.');
    print('');
  }
  logger.log('info', 'server listening', {
    url,
    tls: tlsDecision.mode,
    safeMode: safe,
    relays: kernel.config().relays.length,
    signatureThreads: verifyPool?.size ?? 0,
  });

  // ── Shutdown ──
  let stopping: Promise<void> | undefined;
  const stop = (reason = 'shutdown'): Promise<void> => {
    stopping ??= (async () => {
      draining = true;
      logger.log('info', 'shutting down', { reason, connections: conns.size });
      for (const c of [...conns]) c.close(1001, 'server is restarting');
      const timeout = opts.shutdownTimeoutMs ?? 10_000;
      const graceful = server.stop(false);
      const timedOut = await Promise.race([
        graceful.then(() => false),
        Bun.sleep(timeout).then(() => true),
      ]);
      if (timedOut) await server.stop(true);
      httpServer?.stop(true);
      ports.scheduler.cancel('runtime.tls.renew');
      // Currently enabled modules (includes hot-enabled ones, excludes hot-disabled ones).
      const running = kernel.modules?.() ?? topoSort(opts.modules);
      for (const m of [...running].reverse()) {
        try {
          await m.stop?.(kernel);
        } catch (err) {
          logger.log('error', 'module stop failed', { module: m.id, err });
        }
      }
      // Remaining sockets were closed by server.stop; make sure handlers saw it.
      for (const c of [...conns]) {
        conns.delete(c);
        try {
          kernel.ws?.onClose(c);
        } catch {
          // ignore
        }
      }
      await verifyPool?.close();
      await closeDefaults?.();
      logger.log('info', 'stopped', {});
    })();
    return stopping;
  };
  kernel.provide(PROCESS_SERVICE, { stop });

  return {
    kernel,
    ports,
    server,
    url,
    hostname,
    port,
    tls: tlsDecision.mode,
    safe,
    firstBoot,
    claim,
    adminUrl,
    layout,
    memoryFallbacks,
    connections: () => conns.size,
    stop,
  };
}

/** Proxy/TLS self-check for `beamhop doctor` (never echoes raw IPs). */
function selfCheck(
  req: Request,
  cfg: BeamhopConfig,
  meta: RequestMeta,
  tls: EffectiveTls,
  nonce: string | undefined,
) {
  const h = (n: string) => req.headers.get(n);
  const seen = {
    host: meta.host,
    proto: meta.proto,
    forwardedFor: !!(h('x-forwarded-for') || h('x-real-ip')),
    forwardedHost: h('x-forwarded-host') ?? undefined,
    forwardedProto: h('x-forwarded-proto') ?? undefined,
  };
  const problems: Array<{ message: string; technical: string }> = [];
  const anyForwarded = seen.forwardedFor || !!seen.forwardedHost || !!seen.forwardedProto;
  if (tls === 'proxy') {
    if (!cfg.node.trustProxy && anyForwarded) {
      problems.push({
        message: 'Your proxy is sending visitor details, but Beamhop is set to ignore them.',
        technical: 'X-Forwarded-* present but node.trustProxy=false',
      });
    }
    if (cfg.node.trustProxy && !seen.forwardedFor) {
      problems.push({
        message:
          "Your proxy isn't passing on the visitor's address, so rate limits treat everyone as one person.",
        technical: 'node.trustProxy=true but no X-Forwarded-For / X-Real-IP header',
      });
    }
    if (cfg.node.trustProxy && !seen.forwardedProto) {
      problems.push({
        message: "Your proxy isn't saying whether visitors use a secure connection.",
        technical: 'missing X-Forwarded-Proto',
      });
    }
  }
  const url = new URL(req.url);
  const relay = resolveRelay(cfg, url, meta.host);
  if (!relay) {
    problems.push({
      message: `No relay is set up for ${meta.host}.`,
      technical: 'resolveRelay() returned undefined for Host',
    });
  }
  return {
    ok: problems.length === 0,
    nodeId: cfg.node.id,
    nonce,
    tls,
    trustProxy: cfg.node.trustProxy,
    seen,
    relay: relay
      ? { id: relay.id, publicUrl: `${meta.proto}://${meta.host}${relay.pathPrefix ?? ''}` }
      : null,
    websocket: {
      path: SELF_CHECK_PATH,
      hint: 'Open a WebSocket to this path; it replies with type "beamhop-self-check" and closes.',
    },
    problems,
  };
}
