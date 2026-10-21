// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Blossom HTTP routes on the shared kernel Hono app:
 * BUD-01 GET/HEAD /<sha256>[.ext] · BUD-02 PUT /upload, GET /list/<pubkey>, DELETE /<sha256>
 * BUD-04 PUT /mirror · BUD-05 PUT|HEAD /media · BUD-06 HEAD /upload
 */
import { type Kernel, type MediaOp, resolveRelay } from '@beamhop/core';
import type { Context } from 'hono';
import { type AuthResult, type AuthVerb, checkAuth } from './auth.ts';
import { ANONYMOUS, type BlossomService, type RelayCtx, toBlossomError } from './service.ts';
import {
  BlossomError,
  DEFAULT_TYPE,
  SHA256_RE,
  cleanType,
  hashMismatch,
  isPrivateHost,
  readLimited,
  sha256Hex,
  typeForExt,
  xTagMismatch,
} from './util.ts';

// biome-ignore lint/suspicious/noExplicitAny: Hono env generic of the shared kernel app
type C = Context<any>;

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, *',
  'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'X-Reason, Content-Length, Content-Range, Accept-Ranges',
  'access-control-max-age': '86400',
};

function respond(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(CORS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

function json(data: unknown, status = 200): Response {
  return respond(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fail(status: number, reason: string, head = false): Response {
  const safe = reason.replace(/[\r\n]+/g, ' ');
  return respond(head ? null : JSON.stringify({ message: safe }), {
    status,
    headers: { 'x-reason': safe, 'content-type': 'application/json' },
  });
}

function errorResponse(err: unknown, head = false): Response {
  const e = toBlossomError(err);
  return fail(e.status, e.reason, head);
}

const HASH_PATH = '/:file{[0-9a-f]{64}(\\.[A-Za-z0-9]{1,10})?}';
const LIST_PATH = '/list/:pubkey{[0-9a-f]{64}}';

export function registerRoutes(kernel: Kernel, svc: BlossomService): void {
  const app = kernel.http;

  /** Resolve the virtual relay; null → this host has no relay or media hosting is off. */
  const relayCtx = (c: C): RelayCtx | null => {
    const url = new URL(c.req.url);
    const host = (c.req.header('host') ?? url.host).toLowerCase().replace(/:\d+$/, '');
    const route = c.get('route') as { relayId: string; publicUrl: string } | undefined;
    const relay = route ? kernel.relay(route.relayId) : resolveRelay(kernel.config(), url, host);
    if (!relay || !relay.blossom.enabled) return null;
    const publicUrl = (route?.publicUrl ?? `${url.origin}${relay.pathPrefix ?? ''}`).replace(
      /\/+$/,
      '',
    );
    if (route?.publicUrl) svc.notePublicUrl(relay.id, publicUrl);
    return { relay, publicUrl, host };
  };

  const auth = (c: C, ctx: RelayCtx, verb: AuthVerb): AuthResult =>
    checkAuth(c.req.header('authorization'), verb, {
      now: kernel.ports.clock.now(),
      host: ctx.host,
      skewSeconds: svc.opts.authSkewSeconds,
    });

  /** Require auth unless the relay allows anonymous uploads and none was sent. */
  const uploader = (c: C, ctx: RelayCtx, verb: AuthVerb): AuthResult | { ok: true; anon: true } => {
    const a = auth(c, ctx, verb);
    if (!a.ok && a.missing && !ctx.relay.blossom.requireAuth) return { ok: true, anon: true };
    return a;
  };

  const notFound = (head = false) => fail(404, 'Not found', head);

  // CORS pre-flight for every Blossom endpoint.
  for (const p of ['/upload', '/mirror', '/media', LIST_PATH, HASH_PATH]) {
    app.options(p, () => respond(null, { status: 204 }));
  }

  // ─────────── BUD-01: GET / HEAD /<sha256>[.ext] ───────────
  const serve = async (c: C, head: boolean): Promise<Response> => {
    const ctx = relayCtx(c);
    if (!ctx) return notFound(head);
    const file = c.req.param('file') as string;
    const sha = file.slice(0, 64);
    const ext = file.length > 64 ? file.slice(65) : '';
    try {
      // Tenancy: a relay only serves blobs someone uploaded to it.
      if ((await kernel.ports.blobIndex.owners(ctx.relay.id, sha)).length === 0) {
        return notFound(head);
      }
      if (await svc.quarantined(sha)) return fail(403, 'This file is unavailable', head);
      const d = await kernel.policy.run('onBlobServe', [
        sha,
        { relayId: ctx.relay.id, now: kernel.ports.clock.now() },
      ]);
      if (d.action !== 'accept') {
        return fail(403, d.action === 'reject' ? d.message : 'This file is unavailable', head);
      }
      const meta = await kernel.ports.blobs.head(sha);
      if (!meta) return notFound(head);
      const type =
        meta.type && meta.type !== DEFAULT_TYPE
          ? meta.type
          : ((ext && typeForExt(ext)) ?? meta.type ?? DEFAULT_TYPE);
      const etag = `"${sha}"`;
      const base: Record<string, string> = {
        'content-type': type,
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
        etag,
      };
      if (c.req.header('if-none-match') === etag) {
        return respond(null, { status: 304, headers: base });
      }
      const rangeHeader = c.req.header('range');
      let range: { start: number; end: number } | undefined;
      if (rangeHeader) {
        range = parseRange(rangeHeader, meta.size) ?? undefined;
        if (!range) {
          return respond(null, {
            status: 416,
            headers: { ...base, 'content-range': `bytes */${meta.size}`, 'x-reason': 'Bad range' },
          });
        }
      }
      const status = range ? 206 : 200;
      const headers: Record<string, string> = {
        ...base,
        'content-length': String(range ? range.end - range.start + 1 : meta.size),
      };
      if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${meta.size}`;
      if (head) return respond(null, { status, headers });
      const body = await kernel.ports.blobs.get(sha, range);
      if (!body) return notFound();
      return respond(body.body, { status, headers });
    } catch (err) {
      return errorResponse(err, head);
    }
  };
  // Hono dispatches HEAD as GET (and drops the body); branch on the original method.
  app.get(HASH_PATH, (c) => serve(c, c.req.method === 'HEAD'));

  // ─────────── BUD-02: PUT /upload ───────────
  const upload = async (c: C, verb: 'upload' | 'media'): Promise<Response> => {
    const ctx = relayCtx(c);
    if (!ctx) return notFound();
    const a = uploader(c, ctx, verb);
    if (!a.ok) return fail(a.status, a.reason);
    const body = c.req.raw.body;
    if (!body) return fail(400, 'Missing request body');
    const hashes = 'anon' in a ? [] : a.hashes;
    const pubkey = 'anon' in a ? ANONYMOUS : a.pubkey;
    const headerSha = c.req.header('x-sha-256')?.toLowerCase();
    if (headerSha && !SHA256_RE.test(headerSha)) return fail(400, 'Invalid X-SHA-256 header');
    const declaredSha = headerSha ?? (hashes.length === 1 ? hashes[0] : undefined);
    const len = c.req.header('content-length');
    const declaredSize = len !== undefined && /^\d+$/.test(len) ? Number(len) : undefined;
    const type =
      cleanType(c.req.header('content-type')) ??
      cleanType(c.req.header('x-content-type')) ??
      DEFAULT_TYPE;
    try {
      if (verb === 'media') return await media(c, ctx, { pubkey, hashes, declaredSha, type, body });
      const r = await svc.ingest({
        ctx,
        pubkey,
        body,
        type,
        declaredSha,
        shaSource: headerSha ? 'header' : 'auth',
        declaredSize,
        allowedHashes: hashes,
      });
      return json(r.descriptor);
    } catch (err) {
      return errorResponse(err);
    }
  };
  app.put('/upload', (c) => upload(c, 'upload'));

  // ─────────── BUD-06: HEAD /upload (and BUD-05 HEAD /media) ───────────
  const preflight = async (c: C, verb: 'upload' | 'media'): Promise<Response> => {
    const ctx = relayCtx(c);
    if (!ctx) return notFound(true);
    const a = uploader(c, ctx, verb);
    if (!a.ok) return fail(a.status, a.reason, true);
    const pubkey = 'anon' in a ? ANONYMOUS : a.pubkey;
    const sha = c.req.header('x-sha-256')?.toLowerCase();
    if (sha && !SHA256_RE.test(sha)) return fail(400, 'Invalid X-SHA-256 header', true);
    if (sha && !('anon' in a) && a.hashes.length && !a.hashes.includes(sha)) {
      return fail(403, 'Auth does not cover this file (x tag mismatch)', true);
    }
    const lenHeader = c.req.header('x-content-length');
    if (lenHeader !== undefined && !/^\d+$/.test(lenHeader)) {
      return fail(400, 'Invalid X-Content-Length header', true);
    }
    const size = lenHeader !== undefined ? Number(lenHeader) : undefined;
    const type = cleanType(c.req.header('x-content-type'));
    try {
      const limits = await svc.limitsFor(ctx.relay, pubkey);
      const owned =
        !!sha &&
        (await kernel.ports.blobIndex.owners(ctx.relay.id, sha)).some((o) => o.pubkey === pubkey);
      svc.checkUpload(ctx.relay, limits, { size, type, alreadyOwned: owned });
      if (sha) {
        await svc.uploadPolicy(ctx.relay, limits.tier, {
          sha256: sha,
          size: size ?? 0,
          type: type ?? DEFAULT_TYPE,
          pubkey,
        });
      }
      return respond(null, { status: 200 });
    } catch (err) {
      return errorResponse(err, true);
    }
  };
  const headOnly = (verb: 'upload' | 'media') => (c: C) =>
    c.req.method === 'HEAD' ? preflight(c, verb) : fail(405, 'Use PUT to upload');
  app.get('/upload', headOnly('upload'));
  app.get('/media', headOnly('media'));

  // ─────────── BUD-02: GET /list/<pubkey> ───────────
  app.get(LIST_PATH, async (c) => {
    const ctx = relayCtx(c);
    if (!ctx) return notFound();
    if (ctx.relay.access.authRequired.read) {
      const a = auth(c, ctx, 'list');
      if (!a.ok) return fail(a.status, a.reason);
    }
    const pubkey = c.req.param('pubkey') as string;
    const num = (k: string) => {
      const v = c.req.query(k);
      return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
    };
    const limit = Math.min(num('limit') ?? 1000, 1000);
    const cursor = c.req.query('cursor');
    try {
      let rows = await kernel.ports.blobIndex.listByOwner(ctx.relay.id, pubkey, {
        since: num('since'),
        until: num('until'),
        limit: cursor ? undefined : limit,
      });
      if (cursor) {
        const i = rows.findIndex((r) => r.sha256 === cursor);
        rows = (i >= 0 ? rows.slice(i + 1) : rows).slice(0, limit);
      }
      return json(rows.map((r) => svc.descriptor(ctx.publicUrl, r)));
    } catch (err) {
      return errorResponse(err);
    }
  });

  // ─────────── BUD-02: DELETE /<sha256> ───────────
  app.delete(HASH_PATH, async (c) => {
    const ctx = relayCtx(c);
    if (!ctx) return notFound();
    const sha = (c.req.param('file') as string).slice(0, 64);
    const a = auth(c, ctx, 'delete');
    if (!a.ok) return fail(a.status, a.reason);
    if (!a.hashes.includes(sha)) return fail(403, 'Auth does not cover this file (x tag mismatch)');
    try {
      const r = await svc.removeOwnership(ctx.relay.id, sha, a.pubkey, 'owner');
      if (!r.removed) return notFound();
      return respond(null, { status: 204 });
    } catch (err) {
      return errorResponse(err);
    }
  });

  // ─────────── BUD-04: PUT /mirror ───────────
  app.put('/mirror', async (c) => {
    const ctx = relayCtx(c);
    if (!ctx) return notFound();
    if (!ctx.relay.blossom.mirror) return fail(403, 'Copying from other servers is turned off');
    const a = auth(c, ctx, 'upload');
    if (!a.ok) return fail(a.status, a.reason);
    let target: URL;
    try {
      const body = (await c.req.json()) as { url?: unknown };
      if (typeof body.url !== 'string') throw new Error();
      target = new URL(body.url);
    } catch {
      return fail(400, 'Body must be JSON: { "url": "https://…" }');
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return fail(400, 'Only http(s) URLs can be mirrored');
    }
    if (!svc.opts.allowPrivateMirrorHosts && isPrivateHost(target.hostname)) {
      return fail(403, 'Cannot mirror from a private address');
    }
    if (a.hashes.length === 0) return fail(400, 'Auth must name the file hash (x tag)');
    const inUrl = a.hashes.find((h) => target.pathname.includes(h));
    const declaredSha = inUrl ?? (a.hashes.length === 1 ? a.hashes[0] : undefined);
    const doFetch = svc.opts.fetch ?? ((r: Request) => fetch(r));
    let remote: Response;
    try {
      remote = await doFetch(
        new Request(target, {
          redirect: 'follow',
          signal: AbortSignal.timeout(svc.opts.mirrorTimeoutMs ?? 60_000),
        }),
      );
    } catch {
      return fail(502, 'Could not download the file from the other server');
    }
    if (!remote.ok || !remote.body) {
      await remote.body?.cancel().catch(() => {});
      return fail(502, `The other server answered ${remote.status}`);
    }
    const len = remote.headers.get('content-length');
    try {
      const r = await svc.ingest({
        ctx,
        pubkey: a.pubkey,
        body: remote.body,
        type:
          cleanType(remote.headers.get('content-type')) ??
          cleanType(c.req.header('x-content-type')) ??
          DEFAULT_TYPE,
        declaredSha,
        // The remote's bytes not matching the requested hash is a content mismatch.
        shaSource: 'header',
        declaredSize: len && /^\d+$/.test(len) ? Number(len) : undefined,
        allowedHashes: a.hashes,
      });
      return json(r.descriptor);
    } catch (err) {
      await remote.body.cancel().catch(() => {});
      return errorResponse(err);
    }
  });

  // ─────────── BUD-05: PUT /media ───────────
  const media = async (
    _c: C,
    ctx: RelayCtx,
    p: {
      pubkey: string;
      hashes: string[];
      declaredSha?: string;
      type: string;
      body: ReadableStream<Uint8Array>;
    },
  ): Promise<Response> => {
    const limits = await svc.limitsFor(ctx.relay, p.pubkey);
    svc.checkUpload(ctx.relay, limits, { type: p.type });
    const original = await readLimited(
      p.body,
      limits.maxBlobBytes,
      'File is too large for this server',
    );
    const sha = sha256Hex(original);
    // BUD-05: the auth `x` tag names the ORIGINAL file.
    if (p.hashes.length && !p.hashes.includes(sha)) throw xTagMismatch();
    if (p.declaredSha && p.declaredSha !== sha) throw hashMismatch();
    let out = original;
    let type = p.type;
    const proc = kernel.ports.media;
    const opt = ctx.relay.blossom.optimize;
    const ops: MediaOp[] = [];
    if (proc && opt.stripMetadata && proc.supports.includes('strip-metadata')) {
      if (type.startsWith('image/') || type.startsWith('video/'))
        ops.push({ op: 'strip-metadata' });
    }
    if (proc && ops.length) {
      try {
        const results = await proc.process(original, type, ops);
        const last = [...results].reverse().find((r) => r.data);
        if (last?.data) {
          out = last.data;
          type = last.type ?? type;
        }
      } catch (err) {
        // Graceful fallback: keep the original bytes if processing fails.
        kernel.ports.logger.log('warn', 'blossom media processing failed', {
          error: String(err),
        });
      }
    }
    const r = await svc.ingest({ ctx, pubkey: p.pubkey, body: out, type });
    return json(r.descriptor);
  };
  app.put('/media', (c) => upload(c, 'media'));
}

/** Single `bytes=` range → inclusive bounds, or null when unsatisfiable/malformed. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '') || size === 0) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}
