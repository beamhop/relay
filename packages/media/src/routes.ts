// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `GET /<sha256>/variants` — derivative copies of a Blossom blob plus NIP-94 /
 * NIP-92 `imeta`-ready metadata. Lives next to Blossom's BUD-01 `/<sha256>[.ext]`
 * route without overlapping it (two path segments vs. one).
 */
import { type Kernel, type RelayConfig, resolveRelay } from '@beamhop/core';
import type { Context } from 'hono';
import {
  HASHES,
  type HashRecord,
  type MediaService,
  VARIANT_OWNER,
  type VariantInfo,
  type VariantRecord,
} from './service.ts';

// biome-ignore lint/suspicious/noExplicitAny: Hono env generic of the shared kernel app
type C = Context<any>;

const VARIANTS_PATH = '/:sha{[0-9a-f]{64}}/variants';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, *',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
};

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

export const extForType = (type: string) => EXT[type] ?? '';

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...extra },
  });
}

export interface VariantView {
  url: string;
  sha256: string;
  type: string;
  size: number;
  role: VariantInfo['role'];
  dim?: string;
}

export interface VariantsResponse {
  sha256: string;
  url: string;
  type: string;
  dim?: string;
  blurhash?: string;
  /** `ready` (variants made), `processing` (queued), `none` (nothing to make). */
  status: 'ready' | 'processing' | 'none';
  variants: VariantView[];
  /** NIP-92 `imeta` tag for the original, referencing thumbnail / preview / fallback. */
  imeta: string[];
  /** NIP-94 style tag lists, one per variant. */
  variantTags: string[][];
}

const dim = (w?: number, h?: number) => (w && h ? `${w}x${h}` : undefined);

/** Build the JSON view (exported for tests and other modules). */
export function variantsView(
  publicUrl: string,
  sha256: string,
  type: string,
  rec: VariantRecord | null,
  status: VariantsResponse['status'],
): VariantsResponse {
  const url = `${publicUrl}/${sha256}${extForType(type)}`;
  const variants: VariantView[] = (rec?.variants ?? []).map((v) => ({
    url: `${publicUrl}/${v.sha256}${extForType(v.type)}`,
    sha256: v.sha256,
    type: v.type,
    size: v.size,
    role: v.role,
    dim: dim(v.width, v.height),
  }));
  const imeta = ['imeta', `url ${url}`, `m ${type}`, `x ${sha256}`];
  const d = dim(rec?.width, rec?.height);
  if (d) imeta.push(`dim ${d}`);
  if (rec?.blurhash) imeta.push(`blurhash ${rec.blurhash}`);
  const thumb = variants.find((v) => v.role === 'thumbnail' || v.role === 'poster');
  if (thumb) imeta.push(`thumb ${thumb.url}`);
  const responsive = variants.filter((v) => v.role === 'responsive');
  const preview =
    responsive[responsive.length - 1] ?? (thumb?.role === 'poster' ? thumb : undefined);
  if (preview) imeta.push(`image ${preview.url}`);
  for (const v of variants) if (v.role === 'transcode') imeta.push(`fallback ${v.url}`);
  const variantTags = variants.map((v) => {
    const tags = [`url ${v.url}`, `m ${v.type}`, `x ${v.sha256}`, `size ${v.size}`];
    if (v.dim) tags.push(`dim ${v.dim}`);
    return tags;
  });
  return {
    sha256,
    url,
    type,
    dim: d,
    blurhash: rec?.blurhash,
    status,
    variants,
    imeta,
    variantTags,
  };
}

/**
 * Absolute public base URL of a relay's media server, from the blossom service
 * (learned `route.publicUrl`, else config), for URLs built outside a request.
 */
export function relayPublicUrl(kernel: Kernel, relayId: string): string | null {
  const blossom = kernel.use<{ publicUrlFor?(relayId: string): string | null }>('blossom');
  return blossom?.publicUrlFor?.(relayId) ?? null;
}

export function registerRoutes(kernel: Kernel, svc: MediaService): void {
  const app = kernel.http;

  const relayCtx = (c: C): { relay: RelayConfig; publicUrl: string } | null => {
    const url = new URL(c.req.url);
    const host = (c.req.header('host') ?? url.host).toLowerCase().replace(/:\d+$/, '');
    const route = c.get('route') as { relayId: string; publicUrl: string } | undefined;
    const relay = route ? kernel.relay(route.relayId) : resolveRelay(kernel.config(), url, host);
    if (!relay || !relay.blossom.enabled) return null;
    const publicUrl = (
      route?.publicUrl ??
      relayPublicUrl(kernel, relay.id) ??
      `${url.origin}${relay.pathPrefix ?? ''}`
    ).replace(/\/+$/, '');
    return { relay, publicUrl };
  };

  const notFound = () => json({ message: 'Not found' }, 404, { 'x-reason': 'Not found' });

  app.options(VARIANTS_PATH, () => new Response(null, { status: 204, headers: CORS }));

  app.get(VARIANTS_PATH, async (c) => {
    const ctx = relayCtx(c);
    if (!ctx) return notFound();
    const sha = c.req.param('sha') as string;
    try {
      const owners = await kernel.ports.blobIndex.owners(ctx.relay.id, sha);
      const original = owners.find((o) => o.pubkey !== VARIANT_OWNER) ?? owners[0];
      if (!original) return notFound();
      if (await svc.isQuarantined(sha)) {
        return json({ message: 'This file is unavailable' }, 403, {
          'x-reason': 'This file is unavailable',
        });
      }
      const rec = await svc.variants(sha);
      const status: VariantsResponse['status'] = svc.isProcessing(ctx.relay.id, sha)
        ? 'processing'
        : rec && rec.variants.length > 0
          ? 'ready'
          : 'none';
      const hashes = rec ? null : await kernel.ports.docs.get<HashRecord>(HASHES, sha);
      const view = variantsView(
        ctx.publicUrl,
        sha,
        original.type,
        rec ?? (hashes ? { ...hashes, sha256: sha, variants: [] } : null),
        status,
      );
      return json(view, 200, {
        'cache-control': status === 'ready' ? 'public, max-age=300' : 'no-store',
      });
    } catch (err) {
      kernel.ports.logger.log('warn', 'media variants route failed', { error: String(err) });
      return json({ message: 'Server error' }, 500);
    }
  });
}
