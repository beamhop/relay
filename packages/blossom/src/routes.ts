import { Hono, type Context } from "hono";
import { AuthError, authenticate, type AuthVerb, type BlossomAuth } from "./auth";
import { SHA256_RE } from "./driver";
import { BlossomError, clientIp, CORS_HEADERS, errorResponse, jsonResponse, parseRange, readLimited, withCors } from "./http";
import { blobCsp, extFromMime, normalizeMime, isMimeAllowed, isInlineSafe } from "./mime";
import { fetchRemote } from "./mirror";
import type { BlossomCore } from "./service";

/**
 * `<sha256>` or `<sha256>.<ext>` (any extension, case-insensitive; e.g. `.PNG`, `.tar.gz`). Strict so it never swallows
 * other root paths. The extension is ignored: the blob itself is always served (BUD-01).
 */
const BLOB_PATH = "/:name{[0-9a-f]{64}(?:\\.[A-Za-z0-9]{1,16}){0,2}}";
const THUMB_PATH = "/thumb/:name{[0-9a-f]{64}\\.webp}";
const LIST_PATH = "/list/:pubkey{[0-9a-f]{64}}";
/** PUT /mirror JSON body (`{"url": …}`) */
const MAX_MIRROR_BODY = 16 * 1024;

const contentLength = (v: string | null | undefined): number | undefined => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

type Handler = (c: Context) => Promise<Response>;

/**
 * Blossom HTTP routes (BUD-01/02/04/06/08/11/12). No app-wide middleware is registered so mounting this app at "/"
 * doesn't affect other routes; every handler adds CORS headers itself.
 *
 * Thumbnails: `GET /thumb/<sha256>.webp`, only when `hasThumbnail`. They live outside the `/<sha256>` namespace
 * because a hash URL must always return the exact blob bytes.
 */
export function createRoutes(core: BlossomCore): Hono {
  const app = new Hono();
  const trustProxy = core.deps.config.server.trustProxy;

  const wrap =
    (fn: Handler): Handler =>
    async (c) => {
      try {
        return withCors(await fn(c));
      } catch (err) {
        if (err instanceof BlossomError) return errorResponse(err.status, err.reason);
        if (err instanceof AuthError) return errorResponse(err.status, err.message);
        core.log.error("blossom request failed", { path: c.req.path, error: String((err as Error)?.stack ?? err) });
        return errorResponse(500, "internal error");
      }
    };

  const auth = (c: Context, verb: AuthVerb, sha256?: string, requireX = false): BlossomAuth | undefined =>
    authenticate(c.req.header("authorization"), { verb, domains: core.domains, sha256, requireX });

  /** For endpoints where auth only *widens* access: a bad/expired token is treated like no token. */
  const optionalAuth = (c: Context, verb: AuthVerb, sha256?: string): BlossomAuth | undefined => {
    try {
      return auth(c, verb, sha256);
    } catch (err) {
      if (err instanceof AuthError) return undefined;
      throw err;
    }
  };

  const requireAuth = (c: Context, verb: AuthVerb, sha256?: string, requireX = false): BlossomAuth => {
    const a = auth(c, verb, sha256, requireX);
    if (!a) throw new BlossomError(401, "authorization required");
    return a;
  };

  const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });
  for (const p of ["/upload", "/mirror", LIST_PATH, THUMB_PATH, BLOB_PATH]) app.options(p, preflight);

  /** Loads a blob row the requester may see: approved for everyone, pending for owners/staff, blocked for staff. */
  const loadVisible = async (c: Context, sha256: string) => {
    // A sent token is verified and its rights resolved before the blob lookup, so a missing blob and a hidden
    // (pending/blocked) one cost the same and response timing doesn't reveal that the latter exists.
    let viewer: { staff: boolean; owner: boolean } | undefined;
    if (c.req.header("authorization")) {
      const a = optionalAuth(c, "get", sha256);
      if (a) viewer = { staff: await core.isStaff(a.pubkey), owner: await core.repo.isOwner(sha256, a.pubkey) };
    }
    const row = await core.repo.get(sha256);
    if (!row) throw new BlossomError(404, "blob not found");
    const isPublic = row.status === "approved";
    if (!isPublic) {
      // only owners (pending) and staff (pending/blocked) may fetch unapproved blobs; anyone else gets the
      // same 404 as for a missing blob (also with a malformed/expired token) so existence isn't revealed
      const allowed = !!viewer && (viewer.staff || (row.status === "pending" && viewer.owner));
      if (!allowed) throw new BlossomError(404, "blob not found");
    }
    return { row, isPublic };
  };

  /**
   * Headers for serving user content from the relay (and admin panel) origin: never sniff, never run scripts
   * (SVG/HTML), and make active types download instead of rendering.
   */
  const blobHeaders = (type: string, etag: string, isPublic: boolean, filename: string) => {
    const headers = new Headers({
      "Content-Type": type,
      ETag: etag,
      "Cache-Control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": blobCsp(type),
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (!isInlineSafe(type)) headers.set("Content-Disposition", `attachment; filename="${filename}.${extFromMime(type)}"`);
    return headers;
  };

  const notModified = (c: Context, etag: string) =>
    !!c.req.header("if-none-match")?.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);

  // ---------------------------------------------------------------- GET|HEAD /thumb/<sha256>.webp
  app.get(
    THUMB_PATH,
    wrap(async (c) => {
      const sha256 = c.req.param("name")!.slice(0, 64);
      const head = c.req.method === "HEAD";
      const { row, isPublic } = await loadVisible(c, sha256);
      if (!row.hasThumbnail) throw new BlossomError(404, "thumbnail not found");
      const etag = `"${sha256}.thumb"`;
      const headers = blobHeaders("image/webp", etag, isPublic, `${sha256}.thumb`);
      if (notModified(c, etag)) return new Response(null, { status: 304, headers });
      const obj = await core.driver.getThumbnail(sha256, { hidden: !isPublic });
      if (!obj) throw new BlossomError(404, "thumbnail not found");
      headers.set("Content-Length", String(obj.size));
      if (head) {
        await obj.body.cancel();
        return new Response(null, { status: 200, headers });
      }
      core.deps.bus.emit("blob.served", { sha256, size: obj.size, ip: clientIp(c.req.raw, trustProxy, c.env) });
      return new Response(obj.body, { status: 200, headers });
    }),
  );

  // ---------------------------------------------------------------- GET|HEAD /<sha256>[.ext]
  // Hono dispatches HEAD to GET handlers (and drops the body); we branch on the method to avoid opening streams.
  app.get(
    BLOB_PATH,
    wrap(async (c) => {
      const sha256 = c.req.param("name")!.slice(0, 64);
      const head = c.req.method === "HEAD";
      const { row, isPublic } = await loadVisible(c, sha256);

      const etag = `"${sha256}"`;
      const inline = isInlineSafe(row.type);
      const headers = blobHeaders(row.type, etag, isPublic, sha256);
      if (notModified(c, etag)) return new Response(null, { status: 304, headers });

      headers.set("Accept-Ranges", "bytes");
      // only redirect to the CDN for types that are safe to render there (the CDN doesn't send our headers)
      const redirect = isPublic && inline ? core.driver.publicUrl?.(sha256) : undefined;
      if (redirect) {
        headers.set("Location", redirect);
        return new Response(null, { status: 307, headers });
      }

      const range = parseRange(c.req.header("range"), row.size);
      if (range === "unsatisfiable") {
        const res = errorResponse(416, "range not satisfiable");
        res.headers.set("Content-Range", `bytes */${row.size}`);
        return res;
      }
      if (head) {
        // mirror what GET would answer, without opening the object
        if (range) {
          headers.set("Content-Range", `bytes ${range.start}-${range.end}/${row.size}`);
          headers.set("Content-Length", String(range.end - range.start + 1));
          return new Response(null, { status: 206, headers });
        }
        headers.set("Content-Length", String(row.size));
        return new Response(null, { status: 200, headers });
      }
      const obj = await core.driver.get(sha256, range, { hidden: !isPublic });
      if (!obj) throw new BlossomError(404, "blob data missing");
      let status = 200;
      let length = obj.size;
      if (obj.range) {
        status = 206;
        length = obj.range.end - obj.range.start + 1;
        headers.set("Content-Range", `bytes ${obj.range.start}-${obj.range.end}/${obj.size}`);
      }
      headers.set("Content-Length", String(length));
      core.deps.bus.emit("blob.served", { sha256, size: length, ip: clientIp(c.req.raw, trustProxy, c.env) });
      return new Response(obj.body, { status, headers });
    }),
  );

  // ---------------------------------------------------------------- DELETE /<sha256>
  app.delete(
    BLOB_PATH,
    wrap(async (c) => {
      const sha256 = c.req.param("name")!.slice(0, 64);
      const a = requireAuth(c, "delete", sha256, true);
      // A missing blob is a 404 even for a used token (a client retrying a DELETE whose response was lost).
      if (!(await core.repo.get(sha256))) throw new BlossomError(404, "blob not found");
      // single-use per blob: replaying a captured delete token after the signer re-uploads the blob would delete
      // it again. Keyed by token *and* blob so one token listing several `x` tags still deletes each of them once.
      const tokenKey = `${a.event.id}:${sha256}`;
      if (await core.isDeleteTokenUsed(tokenKey)) throw new BlossomError(401, "auth token already used");
      if (!(await core.releaseOwnership(sha256, a.pubkey, a.pubkey))) throw new BlossomError(403, "you do not own this blob");
      await core.markDeleteTokenUsed(tokenKey, a.expiration * 1000);
      return new Response(null, { status: 200 });
    }),
  );

  // ---------------------------------------------------------------- HEAD /upload (BUD-06)
  app.get(
    "/upload",
    wrap(async (c) => {
      if (c.req.method !== "HEAD") throw new BlossomError(405, "use PUT /upload");
      const settings = core.settings;
      // BUD-06: the hash comes from X-SHA-256; BUD-11: it is the implied hash and a matching `x` tag is required.
      const shaHeader = c.req.header("x-sha-256")?.toLowerCase();
      if (shaHeader === undefined) throw new BlossomError(400, "missing X-SHA-256 header");
      if (!SHA256_RE.test(shaHeader)) throw new BlossomError(400, "invalid X-SHA-256 header");
      const lenHeader = c.req.header("x-content-length");
      if (lenHeader === undefined) throw new BlossomError(411, "missing X-Content-Length header");
      if (!/^\d+$/.test(lenHeader)) throw new BlossomError(400, "invalid X-Content-Length header");
      const size = Number(lenHeader);
      const a = requireAuth(c, "upload", shaHeader, true);
      const user = await core.assertCanUpload(a.pubkey);
      if (size > settings.maxUploadBytes) throw new BlossomError(413, `blob too large (max ${settings.maxUploadBytes} bytes)`);
      const type = normalizeMime(c.req.header("x-content-type"));
      if (type && !isMimeAllowed(type, settings.allowedMimeTypes)) throw new BlossomError(415, `type ${type} is not allowed`);
      await core.assertNotBlocked(shaHeader);
      if (await core.repo.isOwner(shaHeader, a.pubkey)) return new Response(null, { status: 200 });
      await core.assertQuota(a.pubkey, size, user);
      return new Response(null, { status: 200 });
    }),
  );

  // ---------------------------------------------------------------- PUT /upload (BUD-02)
  app.put(
    "/upload",
    wrap(async (c) => {
      const max = core.settings.maxUploadBytes;
      const ip = clientIp(c.req.raw, trustProxy, c.env);
      core.assertIpRate(ip);
      const shaHeader = c.req.header("x-sha-256")?.toLowerCase();
      if (shaHeader !== undefined && !SHA256_RE.test(shaHeader)) throw new BlossomError(400, "invalid X-SHA-256 header");
      // BUD-11: an `x` tag matching the blob is required (checked against X-SHA-256 now and the body hash below).
      const a = requireAuth(c, "upload", shaHeader, true);
      if (a.hashes.length === 0) throw new BlossomError(401, "auth missing x tag");
      core.assertPubkeyRate(a.pubkey);
      const user = await core.assertCanUpload(a.pubkey);
      const len = contentLength(c.req.header("content-length"));
      if (len !== undefined && len > max) throw new BlossomError(413, `blob too large (max ${max} bytes)`);
      if (shaHeader) await core.assertNotBlocked(shaHeader);

      const { descriptor, created } = await core.withUploadBody(ip, async (limits) => {
        const { data, sha256 } = await readLimited(c.req.raw.body, max, len, limits);
        if (data.byteLength === 0) throw new BlossomError(400, "empty body");
        if (shaHeader && shaHeader !== sha256) throw new BlossomError(409, "X-SHA-256 does not match body");
        if (!a.hashes.includes(sha256)) throw new BlossomError(401, "auth x tag does not match blob");
        // `strip` only takes effect when the operator opts in via `settings.blossom.stripExif` (deviates from BUD-02).
        return core.withUploadSlot(() => core.ingest({ data, sha256, pubkey: a.pubkey, declaredType: c.req.header("content-type"), ip, strip: true }, user));
      });
      return jsonResponse(descriptor, created ? 201 : 200);
    }),
  );

  // ---------------------------------------------------------------- PUT /mirror (BUD-04)
  app.put(
    "/mirror",
    wrap(async (c) => {
      const max = core.settings.maxUploadBytes;
      const ip = clientIp(c.req.raw, trustProxy, c.env);
      core.assertIpRate(ip);
      const a = requireAuth(c, "upload");
      if (a.hashes.length === 0) throw new BlossomError(401, "auth missing x tag");
      core.assertPubkeyRate(a.pubkey);
      const user = await core.assertCanUpload(a.pubkey);
      for (const h of a.hashes) await core.assertNotBlocked(h);
      let body: { url?: unknown };
      try {
        const raw = await readLimited(c.req.raw.body, MAX_MIRROR_BODY, undefined, { stallMs: core.options.uploadStallMs ?? 15_000 });
        body = JSON.parse(new TextDecoder().decode(raw.data)) as { url?: unknown };
      } catch (err) {
        if (err instanceof BlossomError) throw err;
        throw new BlossomError(400, "invalid JSON body");
      }
      if (typeof body?.url !== "string") throw new BlossomError(400, "missing url");
      const mirrorUrl = body.url;

      const { descriptor, created } = await core.withUploadBody(ip, async (limits) => {
        // one timeout for the whole transfer, so a body cut off by it is reported as a timeout (504)
        const signal = AbortSignal.timeout(core.options.mirrorTimeoutMs ?? 30_000);
        const res = await fetchRemote(mirrorUrl, {
          fetch: core.options.fetch,
          allowPrivate: !!core.options.allowPrivateMirror,
          timeoutMs: core.options.mirrorTimeoutMs ?? 30_000,
          allowedPorts: core.options.mirrorPorts,
          signal,
        });
        const len = contentLength(res.headers.get("content-length"));
        if (len !== undefined && len > max) {
          await res.body?.cancel();
          throw new BlossomError(413, `blob too large (max ${max} bytes)`);
        }
        // Don't download what the quota can't hold anyway: refused up front from Content-Length, otherwise cut off
        // once the body outgrows it. Only skipped when *every* hash the token allows is already the signer's (then
        // ingest charges nothing whichever one arrives); owning just one would let a token listing a cheap owned
        // hash next to a big new one pull the full size limit before ingest refuses it.
        let owned = true;
        for (const h of a.hashes) owned &&= await core.repo.isOwner(h, a.pubkey);
        const room = owned ? Infinity : await core.quotaRemaining(a.pubkey, user);
        const quotaError = () => new BlossomError(413, `storage quota exceeded (${room} bytes left)`);
        if (len !== undefined && len > room) {
          await res.body?.cancel();
          throw quotaError();
        }
        let read: { data: Uint8Array; sha256: string };
        try {
          read = await readLimited(res.body, Math.min(max, room), len, limits);
        } catch (err) {
          if (err instanceof BlossomError && err.status === 413 && room < max) throw quotaError();
          if (err instanceof BlossomError) throw err.status === 408 ? new BlossomError(504, "mirror source too slow") : err;
          if (signal.aborted) throw new BlossomError(504, "mirror fetch timed out");
          throw new BlossomError(502, "mirror download failed");
        }
        if (!a.hashes.includes(read.sha256)) throw new BlossomError(409, "mirrored blob hash does not match auth x tag");
        // Mirrors are stored byte-identical (no EXIF stripping) so the hash matches the source server.
        // BUD-04: prefer the origin's Content-Type, falling back to sniffing.
        return core.withUploadSlot(() =>
          core.ingest(
            { data: read.data, sha256: read.sha256, pubkey: a.pubkey, declaredType: res.headers.get("content-type"), preferDeclaredType: true, ip, strip: false },
            user,
          ),
        );
      });
      return jsonResponse(descriptor, created ? 201 : 200);
    }),
  );

  // ---------------------------------------------------------------- GET /list/<pubkey>
  app.get(
    LIST_PATH,
    wrap(async (c) => {
      const pubkey = c.req.param("pubkey")!;
      // a bad token still gets the public listing
      const a = optionalAuth(c, "list");
      const includeUnapproved = !!a && (a.pubkey === pubkey || (await core.isStaff(a.pubkey)));
      // clamped: digit strings past 2^53 overflow postgres bigint
      const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Math.min(Number(v), Number.MAX_SAFE_INTEGER) : undefined);
      const cursor = c.req.query("cursor")?.toLowerCase();
      const limit = int(c.req.query("limit"));
      const rows = await core.repo.listByOwner(pubkey, {
        since: int(c.req.query("since")),
        until: int(c.req.query("until")),
        cursor: cursor && SHA256_RE.test(cursor) ? cursor : undefined,
        limit: limit !== undefined ? Math.min(Math.max(limit, 1), 10_000) : 10_000,
        includeUnapproved,
      });
      return jsonResponse(rows.map((r) => core.descriptor(r, r.ownedAt)));
    }),
  );

  return app;
}
