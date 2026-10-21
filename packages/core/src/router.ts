// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BeamhopConfig, RelayConfig } from './config.ts';
import type { RouteContext } from './connection.ts';
import type { HttpRoute, Kernel } from './modules.ts';

/** Resolve the virtual relay for a request by Host header (+ optional path prefix). */
export function resolveRelay(
  config: BeamhopConfig,
  url: URL,
  hostHeader?: string | null,
): RelayConfig | undefined {
  const host = (hostHeader ?? url.host).toLowerCase().replace(/:\d+$/, '');
  const candidates = config.relays.filter((r) =>
    r.hosts.some((h) => h.toLowerCase() === host || h === '*'),
  );
  // Longest matching path prefix wins; exact host beats wildcard.
  let best: RelayConfig | undefined;
  let bestScore = -1;
  for (const r of candidates) {
    const prefix = r.pathPrefix ?? '';
    if (prefix && !url.pathname.startsWith(prefix)) continue;
    const score = prefix.length * 2 + (r.hosts.includes('*') ? 0 : 1);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best ?? (config.relays.length === 1 ? config.relays[0] : undefined);
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    if (seg === '*') return params;
    const val = s[i];
    if (val === undefined) return null;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return p.length === s.length ? params : null;
}

export const routeParams = new WeakMap<Request, Record<string, string>>();

/** Dispatch a request through the kernel's registered HTTP routes. */
export async function dispatchHttp(
  kernel: Kernel,
  req: Request,
  ctx: RouteContext,
): Promise<Response> {
  const url = new URL(req.url);
  const prefix = kernel.relay(ctx.relayId)?.pathPrefix ?? '';
  const pathname =
    prefix && url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length) || '/'
      : url.pathname;
  for (const r of kernel.http as HttpRoute[]) {
    if (r.method !== '*' && r.method !== req.method) continue;
    const params = matchPath(r.path, pathname);
    if (!params) continue;
    routeParams.set(req, params);
    const res = await r.handler(req, ctx);
    if (res) return res;
  }
  return new Response('Not found', { status: 404 });
}
