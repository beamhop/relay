import { adminApiModule } from '@beamhop/admin-api';
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test harness: a mock OIDC provider (Hono + jose: discovery, JWKS, authorize,
 * token endpoint with PKCE + client auth), a mock Google Directory API, and a
 * kernel with policy + relay + admin-api + enterprise-identity.
 */
import {
  type BeamhopModule,
  type Kernel,
  type NostrEvent,
  type Principal,
  type UnsignedEvent,
  createKernel,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  parseConfig,
} from '@beamhop/core';
import { policyModule } from '@beamhop/policy';
import { relayModule } from '@beamhop/relay';
import { memoryPorts } from '@beamhop/testkit';
import { Hono } from 'hono';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import {
  type FetchLike,
  type KeyVaultService,
  createEnterpriseIdentityModule,
} from '../src/index.ts';

export const ORIGIN = 'https://relay.example.com';

// ───────────────────────── mock IdP ─────────────────────────

export interface MockUser {
  sub: string;
  claims: Record<string, unknown>;
}

export interface MockIdp {
  issuer: string;
  app: Hono;
  clientId: string;
  clientSecret: string;
  /** User the next /authorize call signs in. */
  user: MockUser;
  /** Tamper switches for negative tests. */
  wrongNonce: boolean;
  tokenRequests: number;
}

export async function createMockIdp(
  issuer = 'https://idp.example.com',
  clientId = 'beamhop-client',
  clientSecret = 'shh',
): Promise<MockIdp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = await calculateJwkThumbprint(jwk);
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const codes = new Map<
    string,
    { user: MockUser; nonce: string; challenge: string; redirectUri: string; clientId: string }
  >();
  const app = new Hono();
  const idp: MockIdp = {
    issuer,
    app,
    clientId,
    clientSecret,
    user: { sub: 'user-1', claims: {} },
    wrongNonce: false,
    tokenRequests: 0,
  };
  const base = new URL(issuer);
  const prefix = base.pathname.replace(/\/$/, '');
  app.get(`${prefix}/.well-known/openid-configuration`, (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    }),
  );
  app.get(`${prefix}/jwks`, (c) => c.json({ keys: [jwk] }));
  app.get(`${prefix}/authorize`, (c) => {
    const q = (k: string) => c.req.query(k) ?? '';
    if (q('code_challenge_method') !== 'S256') return c.text('pkce required', 400);
    const code = crypto.randomUUID();
    codes.set(code, {
      user: idp.user,
      nonce: q('nonce'),
      challenge: q('code_challenge'),
      redirectUri: q('redirect_uri'),
      clientId: q('client_id'),
    });
    const to = new URL(q('redirect_uri'));
    to.searchParams.set('code', code);
    to.searchParams.set('state', q('state'));
    if (q('hd')) to.searchParams.set('hd_seen', q('hd'));
    return c.redirect(to.toString(), 302);
  });
  app.post(`${prefix}/token`, async (c) => {
    idp.tokenRequests++;
    const form = await c.req.parseBody();
    const code = String(form.code ?? '');
    const rec = codes.get(code);
    codes.delete(code);
    if (!rec) return c.json({ error: 'invalid_grant' }, 400);
    if (form.client_id !== clientId || form.client_secret !== clientSecret)
      return c.json({ error: 'invalid_client' }, 401);
    if (form.redirect_uri !== rec.redirectUri) return c.json({ error: 'invalid_grant' }, 400);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(form.code_verifier ?? '')),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    if (challenge !== rec.challenge) return c.json({ error: 'invalid_grant', pkce: true }, 400);
    const idToken = await new SignJWT({
      ...rec.user.claims,
      nonce: idp.wrongNonce ? 'nope' : rec.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid as string })
      .setIssuer(issuer)
      .setSubject(rec.user.sub)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return c.json({
      access_token: 'at-123',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  });
  return idp;
}

/** Route outbound fetches to mock Hono apps by origin. */
export function routedFetch(
  routes: Record<string, { fetch: (r: Request) => Response | Promise<Response> }>,
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    calls.push(`${req.method} ${req.url}`);
    const origin = new URL(req.url).origin;
    const app = routes[origin];
    if (!app) return new Response('no route', { status: 502 });
    return app.fetch(req);
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

// ───────────────────────── keyvault fake ─────────────────────────

export class FakeKeyVault implements KeyVaultService {
  keys = new Map<string, string>();
  destroyed: string[] = [];
  revoked: string[] = [];
  async ensureKey(subjectId: string) {
    let sk = this.keys.get(subjectId);
    if (!sk) {
      sk = generateSecretKey();
      this.keys.set(subjectId, sk);
    }
    return getPublicKey(sk);
  }
  async bunkerUrlFor(sessionId: string, subjectId?: string) {
    const pk = subjectId ? await this.ensureKey(subjectId) : 'x';
    return `bunker://${pk}?relay=wss%3A%2F%2Frelay.example.com&secret=${sessionId}`;
  }
  async sign(subjectId: string, ev: UnsignedEvent): Promise<NostrEvent> {
    const sk = this.keys.get(subjectId);
    if (!sk) throw new Error('no key');
    return finalizeEvent(
      { kind: ev.kind, tags: ev.tags, content: ev.content, created_at: ev.created_at },
      sk,
    );
  }
  async revokeSessions(subjectId: string) {
    this.revoked.push(subjectId);
  }
  async destroyKey(subjectId: string) {
    this.destroyed.push(subjectId);
    this.keys.delete(subjectId);
  }
}

export function keyvaultModule(kv: KeyVaultService): BeamhopModule {
  return {
    id: 'enterprise-keyvault',
    register(k) {
      k.provide('enterprise.keyvault', kv);
    },
  };
}

// ───────────────────────── kernel ─────────────────────────

export interface Harness {
  kernel: Kernel;
  ports: ReturnType<typeof memoryPorts>;
  req(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
}

export async function makeKernel(opts: {
  enterprise?: Record<string, unknown> | null;
  fetch?: FetchLike;
  extraModules?: BeamhopModule[];
  ownerPubkey?: string;
  includeEnterprise?: boolean;
}): Promise<Harness> {
  const ports = memoryPorts();
  const modules: Record<string, unknown> = {};
  if (opts.enterprise) modules['enterprise-identity'] = opts.enterprise;
  const config = parseConfig({
    node: { id: 'n1' },
    relays: [
      {
        id: 'corp',
        hosts: ['relay.example.com'],
        persona: 'organization',
        access: { mode: 'allowlist' },
        tiers: [
          { id: 'default', name: 'Default' },
          { id: 'staff', name: 'Staff' },
          { id: 'exec', name: 'Executive' },
        ],
        info: opts.ownerPubkey ? { pubkey: opts.ownerPubkey } : {},
      },
      { id: 'public', hosts: ['public.example.com'] },
    ],
    modules,
  });
  const list: BeamhopModule[] = [policyModule, relayModule, adminApiModule];
  list.push(...(opts.extraModules ?? []));
  if (opts.includeEnterprise !== false)
    // Never touch the real network: unknown origins answer 502.
    list.push(createEnterpriseIdentityModule({ fetch: opts.fetch ?? routedFetch({}) }));
  const kernel = await createKernel({ runtime: 'test', ports, config, modules: list });
  return {
    kernel,
    ports,
    async req(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.cookie) headers.set('cookie', init.cookie);
      const { cookie: _c, ...rest } = init;
      return kernel.http.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }), {
        route: { relayId: 'corp', publicUrl: ORIGIN, ipHash: 'x' },
      });
    },
  };
}

/** Extract `name=value` from Set-Cookie headers. */
export function cookieFrom(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  for (const c of all) {
    const m = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(c);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return undefined;
}

/** Drive the browser part of the code flow: start → IdP authorize → callback. */
export async function ssoLogin(
  h: Harness,
  idp: MockIdp,
  idpId: string,
  audience: 'admin' | 'team',
): Promise<Response> {
  const start = await h.req(`/api/v1/sso/${idpId}/start?audience=${audience}`);
  if (start.status !== 302) throw new Error(`start failed ${start.status} ${await start.text()}`);
  const state = cookieFrom(start, 'bh_sso');
  const auth = await idp.app.fetch(new Request(start.headers.get('location') as string));
  const cb = new URL(auth.headers.get('location') as string);
  return h.req(`${cb.pathname}${cb.search}`, { cookie: `bh_sso=${state}` });
}

const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };

export async function runAction(kernel: Kernel, id: string, input: unknown) {
  const a = kernel.actions.get(id);
  if (!a) throw new Error(`no action ${id}`);
  const parsed = a.input.parse(input);
  return a.run(parsed, { principal: OWNER, relayId: null, ports: kernel.ports });
}

export async function previewAction(kernel: Kernel, id: string, input: unknown) {
  const a = kernel.actions.get(id);
  if (!a?.preview) throw new Error(`no preview for ${id}`);
  return a.preview(a.input.parse(input), { principal: OWNER, relayId: null, ports: kernel.ports });
}
