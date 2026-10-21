// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Static admin PWA assets. In compiled binaries the build script generates an entry
 * that embeds every file of `packages/pwa/build` and calls `registerAssets()`.
 * In development, `BEAMHOP_PWA_DIR` (or `packages/pwa/build` if present) is served from disk.
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

/** URL path (e.g. `/index.html`) → file path (embedded `$bunfs/...` or on disk). */
export type AssetManifest = Record<string, string>;

let embedded: AssetManifest = {};

export function registerAssets(manifest: AssetManifest): void {
  embedded = { ...embedded, ...manifest };
}

export function embeddedAssets(): AssetManifest {
  return embedded;
}

export interface AssetServer {
  /** Response for a GET/HEAD under the mount, or null to fall through. */
  serve(req: Request, pathname: string): Response | null;
  readonly source: 'embedded' | 'disk' | 'none';
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function createAssetServer(opts: { mount: string; dir?: string }): AssetServer {
  const mount = opts.mount.replace(/\/$/, '');
  const hasEmbedded = Object.keys(embedded).length > 0;
  const dir = !hasEmbedded && opts.dir && existsSync(opts.dir) ? resolve(opts.dir) : undefined;
  const source = hasEmbedded ? 'embedded' : dir ? 'disk' : 'none';

  const lookup = (rel: string): string | undefined => {
    if (hasEmbedded) return embedded[rel];
    if (!dir) return undefined;
    const p = normalize(join(dir, rel));
    if (!p.startsWith(dir)) return undefined;
    try {
      return statSync(p).isFile() ? p : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    source,
    serve(req, pathname) {
      if (source === 'none') return null;
      if (req.method !== 'GET' && req.method !== 'HEAD') return null;
      if (pathname !== mount && !pathname.startsWith(`${mount}/`)) return null;
      let rel = pathname.slice(mount.length) || '/';
      if (rel.endsWith('/')) rel += 'index.html';
      let file = lookup(rel) ?? lookup(`${rel}.html`);
      // SPA fallback for navigations.
      if (!file && (req.headers.get('accept') ?? '').includes('text/html')) {
        file = lookup('/index.html');
      }
      if (!file) return null;
      const f = Bun.file(file);
      const headers: Record<string, string> = { 'content-type': f.type };
      if (rel.includes('/_app/immutable/')) headers['cache-control'] = IMMUTABLE;
      else headers['cache-control'] = 'no-cache';
      return new Response(req.method === 'HEAD' ? null : f, { headers });
    },
  };
}
