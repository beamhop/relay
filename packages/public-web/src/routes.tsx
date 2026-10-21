// SPDX-License-Identifier: AGPL-3.0-or-later
/** @jsxImportSource hono/jsx */
/**
 * Public pages router. A catch-all on the shared kernel app claims only the
 * public paths of the resolved virtual relay (after its path prefix), never
 * NIP-11 (`Accept: application/nostr+json`) or WebSocket upgrades, and
 * forwards them to an internal Hono app with a per-request {@link PageCtx}.
 */
import {
  type Kernel,
  type NostrEvent,
  type Principal,
  type RelayConfig,
  resolveRelay,
  validateEventShape,
  verifyEvent,
} from '@beamhop/core';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  FILES_LIMIT,
  type PolicyLike,
  VANISH_LOG,
  canWrite,
  deleteFile,
  exportStream,
  filesOf,
  planOf,
  storageOf,
} from './account.ts';
import { type PageCtx, moduleConfig } from './config.ts';
import type { IncidentStore } from './incidents.ts';
import { qrSvg } from './qr.ts';
import {
  COOKIE,
  MAX_SKEW_SECONDS,
  consumeChallenge,
  csrfToken,
  issueChallenge,
  npub,
  readSession,
  safeEqual,
  signSession,
  verifyNip98,
} from './session.ts';
import { type StatusLevel, levelOf } from './status.ts';
import { type StringKey, pickLocale, translator } from './strings.ts';
import { DAY, overallRatio, uptimeDays } from './uptime.ts';
import { LandingPage } from './views/landing.tsx';
import { Layout } from './views/layout.tsx';
import { type Flash, LoginPage, PortalPage } from './views/portal.tsx';
import { StatusPage } from './views/status.tsx';

type Env = { Bindings: { pw: PageCtx } };
type C = Context<Env>;

export type Surface = 'landing' | 'portal' | 'status';

export function surfaceOf(path: string): Surface | null {
  if (path === '/' || path === '') return 'landing';
  if (path === '/portal' || path.startsWith('/portal/')) return 'portal';
  if (path === '/status' || path === '/status.json') return 'status';
  return null;
}

function securityHeaders(
  nonce: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    ...extra,
  };
}

function notFoundResponse(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}

/** Messages that can be shown after a redirect (`?m=`). */
const FLASH: Record<string, { key: StringKey; kind: Flash['kind'] }> = {
  deleted: { key: 'portal.files.deleted', kind: 'ok' },
  'invite-ok': { key: 'portal.invite.ok', kind: 'ok' },
  'invite-unknown': { key: 'portal.invite.unknown', kind: 'err' },
  'invite-expired': { key: 'portal.invite.expired', kind: 'err' },
  'invite-used-up': { key: 'portal.invite.used-up', kind: 'err' },
  'invite-unavailable': { key: 'portal.invite.unavailable', kind: 'err' },
  vanished: { key: 'portal.vanish.done', kind: 'ok' },
  'vanish-bad': { key: 'portal.vanish.bad', kind: 'err' },
  csrf: { key: 'portal.error.csrf', kind: 'err' },
  session: { key: 'portal.error.session', kind: 'err' },
};

export interface RouterDeps {
  kernel: Kernel;
  incidents: IncidentStore;
  bootedAt: number;
}

export function registerRoutes(deps: RouterDeps): void {
  const { kernel } = deps;
  const app = createPagesApp(deps);

  kernel.http.on(['GET', 'HEAD', 'POST'], '*', async (c, next) => {
    if ((c.req.header('upgrade') ?? '').toLowerCase() === 'websocket') return next();
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('application/nostr+json')) return next();
    const url = new URL(c.req.url);
    const route = c.get('route');
    const relay = route
      ? kernel.relay(route.relayId)
      : resolveRelay(kernel.config(), url, c.req.header('host'));
    if (!relay) return next();
    const prefix = (relay.pathPrefix ?? '').replace(/\/+$/, '');
    let sub = url.pathname;
    if (prefix) {
      if (sub !== prefix && !sub.startsWith(`${prefix}/`)) return next();
      sub = sub.slice(prefix.length) || '/';
    }
    const surface = surfaceOf(sub);
    if (!surface) return next();
    // The root belongs to NIP-11 / other clients unless a browser asks for HTML.
    if (surface === 'landing' && !accept.includes('text/html')) return next();
    if (!relay.public[surface]) return notFoundResponse();

    const publicUrl = (route?.publicUrl ?? `${url.origin}${prefix}`).replace(/\/+$/, '');
    const cfg = moduleConfig(kernel);
    const locale = pickLocale(c.req.header('accept-language'));
    const pw: PageCtx = {
      kernel,
      relay,
      publicUrl,
      wsUrl: publicUrl.replace(/^http/, 'ws'),
      base: prefix,
      nonce: kernel.ports.crypto.randomHex(16),
      t: translator(locale),
      locale,
      cfg,
      branding: cfg.branding[relay.id] ?? { theme: 'auto' },
      secure: publicUrl.startsWith('https:'),
    };
    const inner = new Request(new URL(`${sub}${url.search}`, url.origin), c.req.raw);
    return app.fetch(inner, { pw });
  });
}

function html(c: C, node: unknown, status = 200, cache = 'no-cache'): Response {
  const pw = c.env.pw;
  return new Response(`${node}`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cache,
      vary: 'Accept, Accept-Language, Cookie',
      ...securityHeaders(pw.nonce),
    },
  });
}

async function statusSummary(deps: RouterDeps, relay: RelayConfig) {
  const all = await deps.incidents.list(relay.id, 50);
  const open = all.filter((i) => i.state !== 'resolved');
  return { all, open, level: levelOf(open) };
}

function createPagesApp(deps: RouterDeps): Hono<Env> {
  const { kernel, incidents } = deps;
  const { ports } = kernel;
  const app = new Hono<Env>();

  app.notFound((c) => {
    const pw = c.env.pw;
    const { t } = pw;
    return html(
      c,
      <Layout ctx={pw} title={t('error.notFound')} page="error">
        <h1>{t('error.notFound')}</h1>
        <p>
          <a href={`${pw.base}/`}>{t('error.back')}</a>
        </p>
      </Layout>,
      404,
    );
  });

  // ───────────────────────────── landing ─────────────────────────────
  app.get('/', async (c) => {
    const pw = c.env.pw;
    let level: StatusLevel | null = null;
    if (pw.relay.public.status) level = (await statusSummary(deps, pw.relay)).level;
    const svg = qrSvg(pw.wsUrl, { label: pw.t('landing.connect.qr') });
    return html(c, <LandingPage ctx={pw} level={level} qrSvg={svg} />);
  });

  // ───────────────────────────── status ─────────────────────────────
  const statusData = async (pw: PageCtx) => {
    const { all, open, level } = await statusSummary(deps, pw.relay);
    const days = await uptimeDays(kernel, pw.relay.id, pw.cfg.uptimeDays, deps.bootedAt, all);
    const now = ports.clock.now();
    const resolved = all.filter(
      (i) => i.state === 'resolved' && (i.resolvedAt ?? 0) > now - 14 * DAY,
    );
    return { open, level, days, resolved, overall: overallRatio(days) };
  };

  app.get('/status', async (c) => {
    const pw = c.env.pw;
    const d = await statusData(pw);
    return html(
      c,
      <StatusPage
        ctx={pw}
        level={d.level}
        days={d.days}
        overall={d.overall}
        upSeconds={ports.clock.now() - deps.bootedAt}
        open={d.open}
        resolved={d.resolved.slice(0, 10)}
      />,
    );
  });

  app.get('/status.json', async (c) => {
    const pw = c.env.pw;
    const d = await statusData(pw);
    return c.json(
      {
        level: d.level,
        label: pw.t(`status.badge.${d.level}`),
        uptime: d.overall,
        incidents: d.open.map((i) => ({
          id: i.id,
          title: i.title,
          impact: i.impact,
          state: i.state,
          openedAt: i.openedAt,
          updatedAt: i.updates[i.updates.length - 1]?.at ?? i.openedAt,
        })),
      },
      200,
      { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
    );
  });

  // ───────────────────────────── portal ─────────────────────────────
  const cookiePath = (pw: PageCtx) => `${pw.base}/portal`;
  const session = (c: C) => readSession(ports, getCookie(c, COOKIE), c.env.pw.relay.id);
  const redirect = (c: C, query = '') =>
    new Response(null, {
      status: 303,
      headers: { location: `${c.env.pw.base}/portal${query}`, 'cache-control': 'no-store' },
    });
  const sameOrigin = (c: C) => {
    const origin = c.req.header('origin');
    if (!origin || origin === 'null') return origin !== 'null';
    return origin === new URL(c.env.pw.publicUrl).origin || origin === new URL(c.req.url).origin;
  };
  /** Validates session + CSRF for form posts; returns the form or a redirect. */
  const formPost = async (c: C) => {
    const s = await session(c);
    if (!s) return { error: redirect(c, '?m=session') } as const;
    if (!sameOrigin(c)) return { error: redirect(c, '?m=csrf') } as const;
    const form = await c.req.formData();
    const token = String(form.get('csrf') ?? '');
    if (!safeEqual(token, await csrfToken(ports, s.token)))
      return { error: redirect(c, '?m=csrf') } as const;
    return { s, form } as const;
  };

  app.post('/portal/challenge', async (c) => {
    const pw = c.env.pw;
    return c.json(
      { challenge: await issueChallenge(ports, pw.relay.id), url: `${pw.publicUrl}/portal/login` },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  app.post('/portal/login', async (c) => {
    const pw = c.env.pw;
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.length > 4096) return c.json({ error: 'too large' }, 413);
    const auth = await verifyNip98(c.req.header('authorization'), {
      url: `${pw.publicUrl}/portal/login`,
      method: 'POST',
      body,
      now: ports.clock.now(),
    });
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    let challenge = '';
    try {
      challenge = String(
        (JSON.parse(new TextDecoder().decode(body)) as { challenge?: unknown }).challenge ?? '',
      );
    } catch {
      return c.json({ error: 'bad body' }, 400);
    }
    if (!(await consumeChallenge(ports, pw.relay.id, challenge)))
      return c.json({ error: 'bad challenge' }, 401);
    const exp = ports.clock.now() + pw.cfg.sessionMinutes * 60;
    const token = await signSession(ports, { pubkey: auth.pubkey, relayId: pw.relay.id, exp });
    setCookie(c, COOKIE, token, {
      path: cookiePath(pw),
      httpOnly: true,
      secure: pw.secure,
      sameSite: 'Strict',
      maxAge: pw.cfg.sessionMinutes * 60,
    });
    c.header('cache-control', 'no-store');
    return c.json({ ok: true, pubkey: auth.pubkey });
  });

  app.post('/portal/logout', async (c) => {
    const r = await formPost(c);
    if ('error' in r) return r.error;
    deleteCookie(c, COOKIE, { path: cookiePath(c.env.pw) });
    c.header('cache-control', 'no-store');
    return c.redirect(`${c.env.pw.base}/portal`, 303);
  });

  app.get('/portal', async (c) => {
    const pw = c.env.pw;
    const { relay, t } = pw;
    const m = FLASH[c.req.query('m') ?? ''];
    const flash: Flash | undefined = m
      ? {
          kind: m.kind,
          text: t(m.key, {
            events: Number(c.req.query('e') ?? 0),
            files: Number(c.req.query('f') ?? 0),
          }),
        }
      : undefined;
    const s = await session(c);
    if (!s) return html(c, <LoginPage ctx={pw} flash={flash} />, 200, 'no-store');

    const policy = kernel.use<PolicyLike>('policy');
    const [plan, member] = await Promise.all([
      planOf(kernel, relay, s.pubkey, t),
      canWrite(kernel, relay, s.pubkey),
    ]);
    const storage = relay.blossom.enabled ? await storageOf(kernel, relay, s.pubkey) : null;
    const files = relay.blossom.enabled ? await filesOf(kernel, relay.id, s.pubkey) : [];
    return html(
      c,
      <PortalPage
        ctx={pw}
        data={{
          pubkey: s.pubkey,
          npub: npub(s.pubkey),
          tierName: plan.tierName,
          member,
          plan: plan.lines,
          storage,
          files,
          filesLimit: FILES_LIMIT,
          csrf: await csrfToken(ports, s.token),
          invite: {
            show: relay.access.mode === 'allowlist' && !!policy?.redeemInvite,
            code: (c.req.query('invite') ?? '').slice(0, 128),
          },
          flash,
        }}
      />,
      200,
      'no-store',
    );
  });

  app.post('/portal/invite', async (c) => {
    const r = await formPost(c);
    if ('error' in r) return r.error;
    const pw = c.env.pw;
    const policy = kernel.use<PolicyLike>('policy');
    if (!policy?.redeemInvite || pw.relay.access.mode !== 'allowlist')
      return redirect(c, '?m=invite-unavailable');
    const code = String(r.form.get('code') ?? '')
      .trim()
      .slice(0, 128);
    const res = await policy.redeemInvite(pw.relay.id, code, r.s.pubkey);
    return redirect(c, res.ok ? '?m=invite-ok' : `?m=invite-${res.reason}`);
  });

  app.post('/portal/files/delete', async (c) => {
    const r = await formPost(c);
    if ('error' in r) return r.error;
    const sha = String(r.form.get('sha256') ?? '');
    if (!/^[0-9a-f]{64}$/.test(sha)) return redirect(c);
    await deleteFile(kernel, c.env.pw.relay.id, sha, r.s.pubkey);
    return redirect(c, '?m=deleted');
  });

  app.get('/portal/export', async (c) => {
    const pw = c.env.pw;
    const s = await session(c);
    if (!s) return redirect(c, '?m=session');
    const date = new Date(ports.clock.nowMs()).toISOString().slice(0, 10);
    return new Response(exportStream(kernel, pw.relay, s.pubkey, pw.publicUrl), {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${pw.relay.id}-${date}.ndjson"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.post('/portal/vanish', async (c) => {
    const r = await formPost(c);
    if ('error' in r) return r.error;
    const pw = c.env.pw;
    if (String(r.form.get('confirm') ?? '') !== 'DELETE') return redirect(c, '?m=vanish-bad');
    const ev = parseVanishRequest(String(r.form.get('event') ?? ''), {
      pubkey: r.s.pubkey,
      wsUrl: pw.wsUrl,
      now: ports.clock.now(),
    });
    if (!ev) return redirect(c, '?m=vanish-bad');
    const action = kernel.actions.get('portal.right-to-vanish');
    if (!action) return redirect(c, '?m=vanish-bad');
    const principal: Principal = { id: r.s.pubkey, pubkey: r.s.pubkey, roles: {}, via: 'nip07' };
    const input = action.input.parse({ pubkey: r.s.pubkey, until: ev.created_at });
    const res = await action.run(input, {
      principal,
      relayId: pw.relay.id,
      ports,
      reason: 'self-service right to vanish (NIP-62)',
    });
    const out = res.output as { events: number; files: number };
    await ports.docs.put(VANISH_LOG, `${pw.relay.id}:${r.s.pubkey}`, {
      at: ports.clock.now(),
      until: ev.created_at,
      events: out.events,
      files: out.files,
      request: ev,
    });
    return redirect(c, `?m=vanished&e=${out.events}&f=${out.files}`);
  });

  return app;
}

/** Validate a signed NIP-62 request (kind 62) for this relay from the signed-in user. */
export function parseVanishRequest(
  raw: string,
  opts: { pubkey: string; wsUrl: string; now: number },
): NostrEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const shape = validateEventShape(parsed);
  if (!shape.ok) return null;
  const ev = shape.event;
  if (ev.kind !== 62 || ev.pubkey !== opts.pubkey || !verifyEvent(ev)) return null;
  if (Math.abs(ev.created_at - opts.now) > MAX_SKEW_SECONDS * 5) return null;
  const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  const relays = ev.tags.filter((t) => t[0] === 'relay').map((t) => t[1] ?? '');
  if (!relays.some((u) => u === 'ALL_RELAYS' || norm(u) === norm(opts.wsUrl))) return null;
  return ev;
}
