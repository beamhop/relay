// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `enterprise-network` module (§12.10): IP/CIDR allowlists (relay + admin), mTLS device
 * certificates, zero-trust proxy identity, private-only mode. Loaded only when
 * `config.modules['enterprise-network']` exists. It registers a core `RequestGate`, so
 * runtimes expose the raw client IP to it in memory (never logged or stored); without
 * this module no gate exists and no raw IP leaves the runtime.
 */
import {
  type AuthProvider,
  type BeamhopModule,
  type Kernel,
  type Principal,
  type RequestGate,
  type RequestGateContext,
  type Role,
  defineModule,
} from '@beamhop/core';
import { IpAllowlist } from './cidr.ts';
import { NETWORK_MODULE_ID, type NetworkConfig, NetworkConfigSchema } from './config.ts';
import { MtlsVerifier } from './mtls.ts';
import { type ZeroTrustIdentity, ZeroTrustVerifier, proxySecretOk } from './zerotrust.ts';

interface AdminRecordLike {
  id: string;
  roles: Record<string, Role>;
}
interface AdminDirectoryLike {
  get(id: string): Promise<AdminRecordLike | null>;
  principalOf(rec: AdminRecordLike, via: Principal['via']): Principal;
}
interface AdminSessionsLike {
  issue(adminId: string, via: 'sso'): Promise<{ token: string; expiresAt: number }>;
}

interface Compiled {
  raw: unknown;
  cfg: NetworkConfig;
  admin: IpAllowlist;
  relays: Map<string, IpAllowlist>;
  mtls: MtlsVerifier | null;
}

function deny(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function relativePath(req: Request, ctx: RequestGateContext): string {
  const path = new URL(req.url).pathname;
  let prefix = '';
  try {
    prefix = new URL(ctx.route.publicUrl).pathname.replace(/\/$/, '');
  } catch {}
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;
}

export interface NetworkControls {
  /** Evaluate a request (exposed for tests and tooling). */
  check(req: Request, ctx: RequestGateContext): Promise<Response | undefined>;
  /** Verified zero-trust identity of a request, if any. */
  identity(req: Request): Promise<ZeroTrustIdentity | null>;
}

export function createNetworkControls(kernel: Kernel): NetworkControls {
  let compiled: Compiled | null = null;
  const verified = new WeakMap<Request, ZeroTrustIdentity | null>();
  const zt = new ZeroTrustVerifier(() => kernel.ports.clock.now());
  const log = kernel.ports.logger.child({ module: NETWORK_MODULE_ID });

  const settings = (): Compiled => {
    const raw = kernel.moduleConfig<unknown>(NETWORK_MODULE_ID);
    if (compiled && compiled.raw === raw) return compiled;
    const cfg = NetworkConfigSchema.parse(raw ?? {});
    const relays = new Map<string, IpAllowlist>();
    for (const [id, list] of Object.entries(cfg.allowlist.relays))
      relays.set(id, new IpAllowlist(list));
    let mtls: MtlsVerifier | null = null;
    if (cfg.mtls.enabled && cfg.mtls.caPem) {
      mtls = new MtlsVerifier(cfg.mtls.caPem, {
        allowedSubjects: cfg.mtls.allowedSubjects,
        now: () => new Date(kernel.ports.clock.nowMs()),
      });
    }
    compiled = { raw, cfg, admin: new IpAllowlist(cfg.allowlist.admin), relays, mtls };
    return compiled;
  };

  const identity = async (req: Request): Promise<ZeroTrustIdentity | null> => {
    if (verified.has(req)) return verified.get(req) ?? null;
    const { cfg } = settings();
    if (cfg.zeroTrust.provider === 'off') return null;
    const r = await zt.verify(req, cfg.zeroTrust, kernel.config().node.trustProxy);
    const id = r.ok ? r.identity : null;
    verified.set(req, id);
    return id;
  };

  const check = async (req: Request, ctx: RequestGateContext): Promise<Response | undefined> => {
    const c = settings();
    const { cfg } = c;
    const path = relativePath(req, ctx);
    const isAdmin = ctx.route.relayId === '' || cfg.adminPaths.some((p) => path.startsWith(p));
    const relayId = ctx.route.relayId;

    // 1. IP allowlists (raw IP only used here, in memory).
    const list = isAdmin ? c.admin : relayId ? c.relays.get(relayId) : undefined;
    if (list && !list.allows(ctx.clientIp)) {
      log.log('info', 'request blocked by IP allowlist', {
        ipHash: ctx.route.ipHash,
        relayId,
        admin: isAdmin,
      });
      return deny(403, 'Access from your network is not allowed.');
    }

    // 2. mTLS device certificates.
    const m = cfg.mtls;
    if (m.enabled && (m.scope === 'all' || (m.scope === 'admin') === isAdmin)) {
      if (!c.mtls) return deny(403, 'Device certificates are required but not configured.');
      if (!proxySecretOk(req, m.proxySecret, kernel.config().node.trustProxy))
        return deny(403, 'Your device could not be verified.');
      if (m.verifyHeader && (req.headers.get(m.verifyHeader) ?? '').toUpperCase() !== 'SUCCESS')
        return deny(403, 'Your device certificate was not accepted.');
      const r = await c.mtls.verifyHeader(req.headers.get(m.certHeader));
      if (!r.ok) {
        log.log('info', 'request blocked: device certificate', {
          ipHash: ctx.route.ipHash,
          reason: r.reason,
        });
        return deny(403, r.reason ?? 'Your device could not be verified.');
      }
    }

    // 3. Zero-trust proxy identity.
    const z = cfg.zeroTrust;
    if (z.provider !== 'off' && (z.scope === 'all' || isAdmin)) {
      if (!(await identity(req)))
        return deny(401, 'Please sign in through your company access gateway.');
    }

    // 4. Private-only mode: no landing/status pages; minimal NIP-11.
    if (cfg.privateOnly.enabled && relayId && !isAdmin && !ctx.upgrade) {
      const accept = req.headers.get('accept') ?? '';
      if (
        req.method === 'GET' &&
        (path === '/' || path === '') &&
        accept.includes('application/nostr+json')
      ) {
        const relay = kernel.relay(relayId);
        return new Response(
          JSON.stringify({
            name: relay?.info.name ?? 'Private relay',
            software: 'beamhop',
            limitation: {
              auth_required: relay?.access.authRequired.read ?? true,
              restricted_writes: true,
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/nostr+json',
              'access-control-allow-origin': '*',
            },
          },
        );
      }
      const isPortal = path === '/portal' || path.startsWith('/portal/');
      if (
        path === '/' ||
        path === '' ||
        path === '/status' ||
        path === '/status.json' ||
        (isPortal && !cfg.privateOnly.keepPortal)
      ) {
        return deny(404, 'Not found.');
      }
    }
    return undefined;
  };

  return { check, identity };
}

export const networkModule: BeamhopModule = defineModule({
  id: NETWORK_MODULE_ID,
  configSchema: NetworkConfigSchema,
  register(kernel) {
    const controls = createNetworkControls(kernel);
    kernel.provide('enterprise.network', controls);
    const gate: RequestGate = {
      id: NETWORK_MODULE_ID,
      check: (req, ctx) => controls.check(req, ctx),
    };
    if (!kernel.gates) {
      kernel.ports.logger.log(
        'error',
        'this runtime has no request gates; network controls are inactive',
        {},
      );
    } else {
      kernel.gates.push(gate);
    }

    // Zero-trust identity → admin principal (after the built-in providers).
    const adminIdFor = (idn: ZeroTrustIdentity): string | undefined => {
      const cfg = NetworkConfigSchema.parse(kernel.moduleConfig(NETWORK_MODULE_ID) ?? {});
      return cfg.zeroTrust.admins[idn.email] ?? cfg.zeroTrust.admins[idn.subject];
    };
    const provider: AuthProvider = {
      id: 'zero-trust',
      label: 'Company access gateway',
      async authenticate(req) {
        if (req.headers.get('authorization')) return null;
        const idn = await controls.identity(req);
        if (!idn) return null;
        const adminId = adminIdFor(idn);
        const dir = kernel.use<AdminDirectoryLike>('admin.directory');
        if (!adminId || !dir) return null;
        const rec = await dir.get(adminId);
        return rec ? dir.principalOf(rec, 'sso') : null;
      },
    };
    kernel.authProviders.push(provider);

    // Exchange a verified gateway identity for a normal admin session (PWA sign-in).
    kernel.http.post('/api/zero-trust/session', async (c) => {
      const idn = await controls.identity(c.req.raw);
      if (!idn) return c.json({ error: 'Sign in through your company access gateway' }, 401);
      const adminId = adminIdFor(idn);
      const sessions = kernel.use<AdminSessionsLike>('admin.sessions');
      const dir = kernel.use<AdminDirectoryLike>('admin.directory');
      if (!adminId || !sessions || !dir || !(await dir.get(adminId)))
        return c.json({ error: 'Your account is not an admin here' }, 403);
      return c.json(await sessions.issue(adminId, 'sso'));
    });

    kernel.health.push({
      id: 'enterprise-network.proxy-trust',
      subsystem: 'security',
      weight: 1,
      async run() {
        const cfg = NetworkConfigSchema.parse(kernel.moduleConfig(NETWORK_MODULE_ID) ?? {});
        const trust = kernel.config().node.trustProxy;
        const needs =
          (cfg.mtls.enabled && !cfg.mtls.proxySecret) ||
          (cfg.zeroTrust.provider === 'entra-app-proxy' && !cfg.zeroTrust.proxySecret) ||
          cfg.allowlist.admin.length > 0 ||
          Object.keys(cfg.allowlist.relays).length > 0;
        if (needs && !trust && kernel.runtime === 'bun')
          return {
            score: 60,
            status: 'warn',
            message:
              'Network controls see your proxy’s address, not your users’ — turn on “behind a proxy”',
            technical:
              'node.trustProxy=false: client IP / identity headers from the proxy are ignored',
          };
        if (cfg.mtls.enabled && !cfg.mtls.caPem)
          return {
            score: 30,
            status: 'critical',
            message: 'Device certificates are required but no company CA is set',
            technical: 'modules.enterprise-network.mtls.caPem missing',
          };
        return { score: 100, status: 'ok', message: 'Network controls are active' };
      },
    });
    kernel.ui.push({
      path: '/settings/network',
      title: 'Network access',
      placement: 'settings-section',
      chunk: 'enterprise-network',
    });
  },
  stop(kernel) {
    const i = kernel.gates?.findIndex((g) => g.id === NETWORK_MODULE_ID) ?? -1;
    if (i >= 0) kernel.gates?.splice(i, 1);
  },
});
