// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * HTTP surface of the enterprise identity module. Registered ONLY when the
 * module is enabled (§12.0):
 *
 * - `GET  /api/v1/sso/providers`                 sign-in buttons (public)
 * - `GET  /api/v1/sso/:idp/start?audience=admin|team&returnTo=/path`
 * - `GET  /api/v1/sso/:idp/callback`             OIDC redirect URI
 * - `POST /api/v1/team/session`                  → `{ pubkey?, bunkerUrl?, mode }`
 * - `GET|POST /api/v1/team/link`                 self-custody challenge / signed proof
 * - `GET  /api/v1/team/directory`                company people list (team session)
 * - `GET  /api/v1/team/contacts`                 contact-list seeding suggestion
 * - `GET  /api/v1/team/profile`                  suggested kind 0 profile (self-custody)
 * - `POST /api/v1/team/logout`
 * - `GET  /app/config.json`                      team client feature flags
 * - `GET  /.well-known/nostr.json`               NIP-05 from bindings
 * - `/scim/v2/*`                                 SCIM 2.0 (see scim.ts)
 *
 * Admin SSO hands the admin session token to the admin app in the URL FRAGMENT
 * (`#sso_token=…&expires_at=…`), which never reaches servers or logs.
 */
import type { Kernel, KernelEnv } from '@beamhop/core';
import type { Context } from 'hono';
import type { Audience, IdpConfig } from './config.ts';
import { OidcClient } from './oidc.ts';
import { SCIM_BASE, scimRoutes } from './scim.ts';
import { type EnterpriseIdentityService, IdentityError } from './service.ts';
import { STATE_COOKIE, TEAM_COOKIE, type TeamSessionRecord } from './sessions.ts';
import { COL, bindingKey } from './store.ts';
import { readCookie, safeReturnTo, setCookie } from './util.ts';

interface OidcStateRecord {
  idp: string;
  audience: Audience;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

export interface RouteDeps {
  kernel: Kernel;
  identity: EnterpriseIdentityService;
  oidc: OidcClient;
}

export function baseUrlOf(identity: EnterpriseIdentityService, req: Request): string {
  const configured = identity.cfg().publicUrl;
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(req.url).origin;
}

export function redirectUriOf(base: string, idpId: string): string {
  return `${base}/api/v1/sso/${idpId}/callback`;
}

function jsonError(err: unknown, kernel: Kernel): Response {
  if (err instanceof IdentityError)
    return Response.json({ error: err.message }, { status: err.status });
  kernel.ports.logger.log('warn', 'enterprise identity request failed', {
    module: 'enterprise-identity',
    err: String(err),
  });
  return Response.json({ error: 'Sign-in failed. Please try again.' }, { status: 400 });
}

export function registerRoutes(deps: RouteDeps): void {
  const { kernel, identity, oidc } = deps;
  const http = kernel.http;
  const cfg = () => identity.cfg();
  const secure = (req: Request) => baseUrlOf(identity, req).startsWith('https://');

  const idpOf = (id: string): IdpConfig => {
    const idp = identity.idp(id);
    if (!idp) throw new IdentityError(404, 'Unknown sign-in provider');
    return idp;
  };

  // ───────────── SSO ─────────────

  http.get('/api/v1/sso/providers', (c) => {
    const base = baseUrlOf(identity, c.req.raw);
    return c.json({
      providers: cfg().idps.map((i) => ({
        id: i.id,
        type: i.type,
        label: i.label ?? defaultLabel(i),
        audiences: i.audiences,
        startUrl: `${base}/api/v1/sso/${i.id}/start`,
      })),
    });
  });

  http.get('/api/v1/sso/:idp/start', async (c) => {
    try {
      const idp = idpOf(c.req.param('idp'));
      const audience = (c.req.query('audience') ?? 'team') as Audience;
      if (audience !== 'admin' && audience !== 'team')
        throw new IdentityError(400, 'Unknown sign-in audience');
      if (!idp.audiences.includes(audience))
        throw new IdentityError(403, 'This provider is not enabled for this app');
      const fallback = audience === 'admin' ? cfg().adminAppPath : cfg().teamAppPath;
      const base = baseUrlOf(identity, c.req.raw);
      const pending = await OidcClient.newPending();
      const url = await oidc.authorizationUrl(idp, redirectUriOf(base, idp.id), pending);
      await kernel.ports.docs.put<OidcStateRecord>(COL.oidcState, pending.state, {
        idp: idp.id,
        audience,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
        returnTo: safeReturnTo(c.req.query('returnTo'), fallback),
        expiresAt: kernel.ports.clock.now() + 600,
      });
      return new Response(null, {
        status: 302,
        headers: {
          location: url.toString(),
          'set-cookie': setCookie(STATE_COOKIE, pending.state, {
            maxAge: 600,
            path: '/api/v1/sso',
            secure: secure(c.req.raw),
          }),
          'cache-control': 'no-store',
        },
      });
    } catch (err) {
      return jsonError(err, kernel);
    }
  });

  http.get('/api/v1/sso/:idp/callback', async (c) => {
    const req = c.req.raw;
    const clearState = setCookie(STATE_COOKIE, '', {
      maxAge: 0,
      path: '/api/v1/sso',
      secure: secure(req),
    });
    try {
      const idp = idpOf(c.req.param('idp'));
      const state = c.req.query('state') ?? '';
      const docs = kernel.ports.docs;
      const rec = state ? await docs.get<OidcStateRecord>(COL.oidcState, state) : null;
      if (rec) await docs.delete(COL.oidcState, state);
      if (!rec || rec.idp !== idp.id || rec.expiresAt < kernel.ports.clock.now())
        throw new IdentityError(400, 'The sign-in link expired. Please start again.');
      // Login CSRF: the browser that started the flow must finish it.
      if (readCookie(req.headers.get('cookie'), STATE_COOKIE) !== state)
        throw new IdentityError(400, 'Please finish signing in in the same browser.');
      if (c.req.query('error'))
        throw new IdentityError(403, 'The identity provider did not approve the sign-in.');
      const base = baseUrlOf(identity, req);
      const claims = await oidc.callback(idp, redirectUriOf(base, idp.id), new URL(req.url), {
        state,
        nonce: rec.nonce,
        codeVerifier: rec.codeVerifier,
      });
      let b = await identity.upsertFromLogin(idp, claims);
      const headers = new Headers({ 'cache-control': 'no-store' });
      headers.append('set-cookie', clearState);
      const signedIn = (audience: 'admin' | 'team') =>
        identity.siem({
          stream: 'auth',
          type: audience === 'admin' ? 'sso.admin-sign-in' : 'sso.sign-in',
          summary: `${b.name ?? b.email ?? b.subject} signed in with ${idp.label ?? idp.id}${audience === 'admin' ? ' (admin app)' : ''}`,
          principalId: audience === 'admin' ? identity.adminId(b) : bindingKey(b.idp, b.subject),
          data: {
            idp: idp.id,
            binding: bindingKey(b.idp, b.subject),
            audience,
            ...(b.npub ? { pubkey: b.npub } : {}),
          },
        });
      if (rec.audience === 'admin') {
        const s = await identity.issueAdminSession(b);
        signedIn('admin');
        const frag = new URLSearchParams({ sso_token: s.token, expires_at: String(s.expiresAt) });
        headers.set('location', `${rec.returnTo}#${frag.toString()}`);
        return new Response(null, { status: 302, headers });
      }
      b = await identity.ensureManaged(b);
      const { token } = await identity.sessions.issue(bindingKey(b.idp, b.subject));
      signedIn('team');
      headers.append(
        'set-cookie',
        setCookie(TEAM_COOKIE, token, {
          maxAge: cfg().teamSessionTtlSeconds,
          path: '/',
          secure: secure(req),
        }),
      );
      headers.set('location', rec.returnTo);
      return new Response(null, { status: 302, headers });
    } catch (err) {
      const res = jsonError(err, kernel);
      res.headers.append('set-cookie', clearState);
      return res;
    }
  });

  // ───────────── team client ─────────────

  const withSession = async (
    c: Context<KernelEnv>,
    fn: (s: TeamSessionRecord) => Promise<Response>,
  ): Promise<Response> => {
    try {
      const s = await identity.sessions.fromRequest(c.req.raw);
      if (!s) return c.json({ error: 'Sign in with your company account first' }, 401);
      const b = await identity.store.get(s.bindingKey);
      if (!b || b.status === 'suspended' || b.status === 'deleted')
        return c.json({ error: 'Your company account is not active on this workspace' }, 401);
      return await fn(s);
    } catch (err) {
      return jsonError(err, kernel);
    }
  };

  http.post('/api/v1/team/session', (c) =>
    withSession(c, async (s) => {
      let b = await identity.store.get(s.bindingKey);
      if (!b) throw new IdentityError(401, 'Sign in with your company account first');
      b = await identity.ensureManaged(b);
      const mode = identity.modeOf(b);
      const kv = identity.svc.keyvault();
      if (mode === 'managed' && kv && b.npub) {
        const bunkerUrl = await kv.bunkerUrlFor(s.sid, s.bindingKey);
        return c.json({ mode, pubkey: b.npub, bunkerUrl });
      }
      if (b.npub && b.status === 'active') return c.json({ mode: 'self-custody', pubkey: b.npub });
      return c.json({ mode: 'link-required', linkUrl: '/api/v1/team/link' });
    }),
  );

  http.get('/api/v1/team/link', (c) =>
    withSession(c, async (s) => {
      const { challenge, expiresAt } = await identity.createChallenge(s.bindingKey);
      return c.json({ challenge, expiresAt, kinds: [22242, 27235], tag: 'challenge' });
    }),
  );

  http.post('/api/v1/team/link', (c) =>
    withSession(c, async (s) => {
      const body = (await c.req.json().catch(() => null)) as { event?: unknown } | null;
      const b = await identity.verifyLink(s.bindingKey, body?.event as never);
      return c.json({ mode: 'self-custody', pubkey: b.npub });
    }),
  );

  http.get('/api/v1/team/directory', (c) =>
    withSession(c, async () => c.json({ people: await identity.directory() })),
  );

  http.get('/api/v1/team/contacts', (c) =>
    withSession(c, async (s) => {
      const { team, org } = await identity.contactSuggestion(s.bindingKey);
      return c.json({
        team,
        org,
        template: { kind: 3, content: '', tags: team.map((pk) => ['p', pk]) },
      });
    }),
  );

  http.get('/api/v1/team/profile', (c) =>
    withSession(c, async (s) =>
      c.json({ profile: await identity.profileSuggestion(s.bindingKey) }),
    ),
  );

  http.post('/api/v1/team/logout', async (c) => {
    const s = await identity.sessions.fromRequest(c.req.raw);
    if (s) await kernel.ports.docs.delete(COL.teamSessions, `${s.bindingKey}/${s.sid}`);
    return new Response(null, {
      status: 204,
      headers: {
        'set-cookie': setCookie(TEAM_COOKIE, '', { maxAge: 0, secure: secure(c.req.raw) }),
      },
    });
  });

  http.get(`${cfg().teamAppPath.replace(/\/+$/, '')}/config.json`, (c) => {
    const teamIdps = cfg().idps.filter((i) => i.audiences.includes('team'));
    return c.json(
      {
        allowedRelays: [],
        features: {
          sso: teamIdps.length > 0,
          directory: true,
          // Placeholder until DM escrow (§12.8) lands in enterprise-compliance.
          escrowNotice: false,
        },
        sso: {
          providers: teamIdps.map((i) => ({
            id: i.id,
            label: i.label ?? defaultLabel(i),
            startUrl: `/api/v1/sso/${i.id}/start?audience=team`,
          })),
        },
      },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  // ───────────── NIP-05 ─────────────

  http.get('/.well-known/nostr.json', async (c) => {
    const cors = { 'access-control-allow-origin': '*', 'cache-control': 'max-age=300' };
    if (!cfg().nip05.enabled) return c.json({ names: {} }, 404, cors);
    const doc = await identity.nip05(c.req.query('name'));
    return c.json(doc, 200, cors);
  });

  // ───────────── SCIM ─────────────

  http.route(
    SCIM_BASE,
    scimRoutes({ kernel, identity, baseUrl: (r) => baseUrlOf(identity, r) }) as never,
  );
}

export function defaultLabel(i: IdpConfig): string {
  if (i.type === 'google') return 'Sign in with Google';
  if (i.type === 'microsoft') return 'Sign in with Microsoft';
  return 'Sign in with your company account';
}
