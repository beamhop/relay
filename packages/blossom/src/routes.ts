import { Hono, type Context } from "hono";
import { AuthError, authenticate, type AuthVerb, type BlossomAuth } from "./auth";
import { SHA256_RE } from "./driver";
import { BlossomError, clientIp, CORS_HEADERS, errorResponse, jsonResponse, parseRange, readLimited, withCors } from "./http";
import { normalizeMime, isMimeAllowed } from "./mime";
import { fetchRemote } from "./mirror";
import type { BlossomCore } from "./service";

/** `<sha256>`, `<sha256>.<ext>` or `<sha256>.thumb.webp` — strict so it never swallows other root paths. */
const BLOB_PATH = "/:name{[0-9a-f]{64}(?:\\.[a-z0-9]{1,16}){0,2}}";
const LIST_PATH = "/list/:pubkey{[0-9a-f]{64}}";
const THUMB_SUFFIX = ".thumb.webp";

type Handler = (c: Context) => Promise<Response>;

/**
 * Blossom HTTP routes (BUD-01/02/04/06). No app-wide middleware is registered so mounting this app at "/"
 * doesn't affect other routes; every handler adds CORS headers itself.
 *
 * Thumbnails: `GET /<sha256>.thumb.webp` (or `GET /<sha256>?thumb=1`), only when `hasThumbnail`.
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

  const requireAuth = (c: Context, verb: AuthVerb, sha256?: string, requireX = false): BlossomAuth => {
    const a = auth(c, verb, sha256, requireX);
    if (!a) throw new BlossomError(401, "authorization required");
    return a;
  };

  const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });
  for (const p of ["/upload", "/mirror", LIST_PATH, BLOB_PATH]) app.options(p, preflight);

  // ---------------------------------------------------------------- GET|HEAD /<sha256>[.ext]
  // Hono dispatches HEAD to GET handlers (and drops the body); we branch on the method to avoid opening streams.
  app.get(
    BLOB_PATH,
    wrap(async (c) => {
      const name = c.req.param("name")!;
      const sha256 = name.slice(0, 64);
      const thumb = name.endsWith(THUMB_SUFFIX) || c.req.query("thumb") === "1";
      const head = c.req.method === "HEAD";
      const row = await core.repo.get(sha256);
      if (!row) throw new BlossomError(404, "blob not found");

      let isPublic = row.status === "approved";
      if (!isPublic) {
        // only owners (pending) and staff (pending/blocked) may fetch unapproved blobs
        const a = auth(c, "get", sha256);
        const allowed =
          !!a && ((await core.isStaff(a.pubkey)) || (row.status === "pending" && (await core.repo.isOwner(sha256, a.pubkey))));
        if (!allowed) throw new BlossomError(404, "blob not found");
      }

      const etag = `"${thumb ? `${sha256}.thumb` : sha256}"`;
      const headers = new Headers({
        "Content-Type": thumb ? "image/webp" : row.type,
        ETag: etag,
        "Cache-Control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      });
      if (c.req.header("if-none-match")?.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
        return new Response(null, { status: 304, headers });
      }

      if (thumb) {
        if (!row.hasThumbnail) throw new BlossomError(404, "thumbnail not found");
        const obj = await core.driver.getThumbnail(sha256);
        if (!obj) throw new BlossomError(404, "thumbnail not found");
        headers.set("Content-Length", String(obj.size));
        if (head) {
          await obj.body.cancel();
          return new Response(null, { status: 200, headers });
        }
        core.deps.bus.emit("blob.served", { sha256, size: obj.size, ip: clientIp(c.req.raw, trustProxy, c.env) });
        return new Response(obj.body, { status: 200, headers });
      }

      headers.set("Accept-Ranges", "bytes");
      const redirect = isPublic ? core.driver.publicUrl?.(sha256, "") : undefined;
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
        headers.set("Content-Length", String(row.size));
        return new Response(null, { status: 200, headers });
      }
      const obj = await core.driver.get(sha256, range);
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
      const name = c.req.param("name")!;
      if (name.endsWith(THUMB_SUFFIX)) throw new BlossomError(400, "cannot delete a thumbnail");
      const sha256 = name.slice(0, 64);
      const a = requireAuth(c, "delete", sha256, true);
      if (!(await core.repo.get(sha256))) throw new BlossomError(404, "blob not found");
      if (!(await core.releaseOwnership(sha256, a.pubkey, a.pubkey))) throw new BlossomError(403, "you do not own this blob");
      return new Response(null, { status: 200 });
    }),
  );

  // ---------------------------------------------------------------- HEAD /upload (BUD-06)
  app.get(
    "/upload",
    wrap(async (c) => {
      if (c.req.method !== "HEAD") throw new BlossomError(405, "use PUT /upload");
      const settings = core.settings;
      const shaHeader = c.req.header("x-sha-256")?.toLowerCase();
      if (shaHeader !== undefined && !SHA256_RE.test(shaHeader)) throw new BlossomError(400, "invalid X-SHA-256 header");
      const lenHeader = c.req.header("x-content-length");
      if (lenHeader === undefined) throw new BlossomError(411, "missing X-Content-Length header");
      if (!/^\d+$/.test(lenHeader)) throw new BlossomError(400, "invalid X-Content-Length header");
      const size = Number(lenHeader);
      const a = requireAuth(c, "upload", shaHeader);
      const user = await core.assertCanUpload(a.pubkey);
      if (size > settings.maxUploadBytes) throw new BlossomError(413, `blob too large (max ${settings.maxUploadBytes} bytes)`);
      const type = normalizeMime(c.req.header("x-content-type"));
      if (type && !isMimeAllowed(type, settings.allowedMimeTypes)) throw new BlossomError(415, `type ${type} is not allowed`);
      if (shaHeader) {
        await core.assertNotBlocked(shaHeader);
        if (await core.repo.isOwner(shaHeader, a.pubkey)) return new Response(null, { status: 200 });
      }
      await core.assertQuota(a.pubkey, size, user);
      return new Response(null, { status: 200 });
    }),
  );

  // ---------------------------------------------------------------- PUT /upload (BUD-02)
  app.put(
    "/upload",
    wrap(async (c) => {
      const max = core.settings.maxUploadBytes;
      const shaHeader = c.req.header("x-sha-256")?.toLowerCase();
      if (shaHeader !== undefined && !SHA256_RE.test(shaHeader)) throw new BlossomError(400, "invalid X-SHA-256 header");
      const a = requireAuth(c, "upload", shaHeader);
      const user = await core.assertCanUpload(a.pubkey);
      const len = c.req.header("content-length");
      if (len && Number(len) > max) throw new BlossomError(413, `blob too large (max ${max} bytes)`);
      if (shaHeader) await core.assertNotBlocked(shaHeader);

      const { data, sha256 } = await readLimited(c.req.raw.body, max);
      if (data.byteLength === 0) throw new BlossomError(400, "empty body");
      if (shaHeader && shaHeader !== sha256) throw new BlossomError(409, "X-SHA-256 does not match body");
      if (a.hashes.length > 0 && !a.hashes.includes(sha256)) throw new BlossomError(401, "auth x tag does not match blob");

      const { descriptor } = await core.ingest(
        { data, sha256, pubkey: a.pubkey, declaredType: c.req.header("content-type"), ip: clientIp(c.req.raw, trustProxy, c.env), strip: true },
        user,
      );
      return jsonResponse(descriptor);
    }),
  );

  // ---------------------------------------------------------------- PUT /mirror (BUD-04)
  app.put(
    "/mirror",
    wrap(async (c) => {
      const max = core.settings.maxUploadBytes;
      const a = requireAuth(c, "upload");
      if (a.hashes.length === 0) throw new BlossomError(401, "auth missing x tag");
      const user = await core.assertCanUpload(a.pubkey);
      for (const h of a.hashes) await core.assertNotBlocked(h);
      let body: { url?: unknown };
      try {
        body = (await c.req.json()) as { url?: unknown };
      } catch {
        throw new BlossomError(400, "invalid JSON body");
      }
      if (typeof body?.url !== "string") throw new BlossomError(400, "missing url");

      const res = await fetchRemote(body.url, {
        fetch: core.options.fetch ?? fetch,
        allowPrivate: !!core.options.allowPrivateMirror,
        timeoutMs: core.options.mirrorTimeoutMs ?? 30_000,
      });
      const len = res.headers.get("content-length");
      if (len && Number(len) > max) {
        await res.body?.cancel();
        throw new BlossomError(413, `blob too large (max ${max} bytes)`);
      }
      let read: { data: Uint8Array; sha256: string };
      try {
        read = await readLimited(res.body, max);
      } catch (err) {
        if (err instanceof BlossomError) throw err;
        throw new BlossomError(502, "mirror download failed");
      }
      if (!a.hashes.includes(read.sha256)) throw new BlossomError(409, "mirrored blob hash does not match auth x tag");
      // Mirrors are stored byte-identical (no EXIF stripping) so the hash matches the source server.
      const { descriptor } = await core.ingest(
        { data: read.data, sha256: read.sha256, pubkey: a.pubkey, declaredType: res.headers.get("content-type"), ip: clientIp(c.req.raw, trustProxy, c.env), strip: false },
        user,
      );
      return jsonResponse(descriptor);
    }),
  );

  // ---------------------------------------------------------------- GET /list/<pubkey>
  app.get(
    LIST_PATH,
    wrap(async (c) => {
      const pubkey = c.req.param("pubkey")!;
      const a = auth(c, "list");
      const includeUnapproved = !!a && (a.pubkey === pubkey || (await core.isStaff(a.pubkey)));
      const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);
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
