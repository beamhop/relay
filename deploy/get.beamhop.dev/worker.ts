// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * get.beamhop.dev — a tiny Cloudflare Worker in front of GitHub Releases.
 *
 *   /                          → scripts/install.sh (what `curl -fsSL https://get.beamhop.dev | sh` runs)
 *   /releases/latest.json      → manifest of the newest stable release (`beamhop update`)
 *   /releases/latest/<file>    → that file from the newest stable release (install.sh)
 *   /releases/v<x.y.z>/<file>  → that file from a pinned release
 *
 * Everything is a redirect to github.com except the install script, which is proxied so
 * `curl | sh` gets `text/plain` from one stable URL. Deploy: `wrangler deploy` in this folder.
 */

export const REPO = 'beamhop/beamhop';
const GH = `https://github.com/${REPO}/releases`;
const INSTALL_SH = `https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh`;
const FILE = /^[A-Za-z0-9._-]+$/;

export type Route = { redirect: string } | { proxy: string } | { status: number };

export function route(pathname: string): Route {
  if (pathname === '/' || pathname === '/install.sh') return { proxy: INSTALL_SH };
  if (pathname === '/releases/latest.json')
    return { redirect: `${GH}/latest/download/latest.json` };
  const latest = pathname.match(/^\/releases\/latest\/([^/]+)$/);
  if (latest?.[1] && FILE.test(latest[1]))
    return { redirect: `${GH}/latest/download/${latest[1]}` };
  const pinned = pathname.match(/^\/releases\/(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/([^/]+)$/);
  if (pinned?.[1] && pinned[2] && FILE.test(pinned[2]))
    return { redirect: `${GH}/download/${pinned[1]}/${pinned[2]}` };
  return { status: 404 };
}

export default {
  async fetch(req: Request): Promise<Response> {
    const r = route(new URL(req.url).pathname);
    if ('redirect' in r) return Response.redirect(r.redirect, 302);
    if ('proxy' in r) {
      const res = await fetch(r.proxy);
      if (!res.ok)
        return new Response('installer unavailable, try again shortly\n', { status: 502 });
      return new Response(res.body, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }
    return new Response('not found\n', { status: r.status });
  },
};
