import { z } from "zod";
import type { BlossomService, MediaBulkResult, MediaStats, MediaStatusRequest } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, forbidden, HttpError, notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import { auditLists } from "../util/audit";
import type { Same } from "../util/contract";
import { tryParsePubkey } from "../util/pubkey";
import { readBody, readQuery } from "../util/request";

const SHA = z.string().regex(/^[0-9a-f]{64}$/i).transform((s) => s.toLowerCase());
const STATUS = z.enum(["approved", "pending", "blocked"]);
const ListQuery = z.object({
  pubkey: z.string().max(200).optional(),
  status: STATUS.optional(),
  type: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const BulkSchema = z.object({ sha256s: z.array(SHA).min(1).max(1000), action: z.enum(["approve", "block", "delete"]) });
const StatusSchema = z.object({ status: STATUS });
true satisfies Same<z.output<typeof StatusSchema>, MediaStatusRequest>;

/**
 * JavaScript MIME types (WHATWG MIME Sniffing "JavaScript MIME type essence match"). The admin origin allows
 * `script-src 'self'`, so a blob served from it under one of these could run as the panel's own code: they are served
 * as text/plain, which browsers refuse to execute (with nosniff).
 */
const JS_MIME =
  /^(?:application\/(?:x-)?(?:ecma|java)script|text\/(?:x-)?(?:ecma|java)script|text\/javascript1\.[0-5]|text\/jscript|text\/livescript)$/;
/** Sec-Fetch-Dest values of requests that would execute (or transform with) the response: never answered with a blob */
const SCRIPT_DESTINATIONS = new Set(["script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet", "xslt"]);

/**
 * Same rule as blossom's isInlineSafe (admin-api can't import @beamhop/blossom): passive media, plain text and PDF
 * may render inline on the admin origin; anything else — SVG, HTML, any XML type, unknown — downloads.
 */
function isInlineSafe(mime: string): boolean {
  if (mime.includes("xml")) return false;
  const top = mime.split("/")[0];
  return top === "image" || top === "video" || top === "audio" || mime === "text/plain" || mime === "application/pdf";
}

export function registerMediaRoutes(app: AdminApp, ctx: ApiContext) {
  const blossom = (): BlossomService => {
    const b = ctx.deps.blossom;
    if (!b) throw notFound("blossom disabled", "blossom_disabled");
    return b;
  };
  const sha = (raw: string) => {
    const r = SHA.safeParse(raw.split(".")[0]);
    if (!r.success) throw badRequest("invalid sha256");
    return r.data;
  };

  app.get("/media", requirePermission("media.view"), async (c) => {
    const q = readQuery(c, ListQuery);
    const pubkey = q.pubkey ? tryParsePubkey(q.pubkey) : undefined;
    if (q.pubkey && !pubkey) throw badRequest("invalid pubkey");
    return c.json(await blossom().list({ ...q, pubkey }));
  });

  // Blocklist (hashes refused on upload). Optional in the BlossomService contract → 501 when missing.
  const unsupported = () => new HttpError(501, "blocklist not supported", "unsupported");

  // registered before /media/:sha256 so "blocklist" isn't parsed as a hash
  app.get("/media/blocklist", requirePermission("media.view"), async (c) => {
    const items = await blossom().blocklist?.();
    if (!items) throw unsupported();
    return c.json({ items });
  });

  app.delete("/media/blocklist/:sha256", requirePermission("media.moderate"), async (c) => {
    const s = sha(c.req.param("sha256"));
    // lifting a block needs the rank of whoever placed it
    const entry = (await blossom().blocklist?.())?.find((e) => e.sha256 === s);
    if (entry) await ctx.users.assertCanOverride(principalOf(c), entry.blockedBy, "unblock this hash");
    // blossom records the "blob.unblock" audit entry
    const ok = await blossom().unblock?.(s, principalOf(c).pubkey);
    if (ok === undefined) throw unsupported();
    if (!ok) throw notFound("hash is not blocked");
    return c.json({ ok: true });
  });

  app.get("/media/stats", requirePermission("media.view"), async (c) => {
    const b = blossom();
    const [stats, pending] = await Promise.all([b.stats(), b.list({ status: "pending", limit: 1 })]);
    const out: MediaStats = { ...stats, pending: pending.total };
    return c.json(out);
  });

  // Admin preview: serves pending/blocked blobs too (public blossom routes hide them).
  app.get("/media/:sha256/raw", requirePermission("media.view"), async (c) => {
    if (SCRIPT_DESTINATIONS.has((c.req.header("sec-fetch-dest") ?? "").toLowerCase())) {
      throw forbidden("blobs can't be loaded as scripts, workers or XSLT", "forbidden_destination");
    }
    const s = sha(c.req.param("sha256"));
    const blob = await blossom().read(s, { thumbnail: c.req.query("thumb") === "1" });
    if (!blob) throw notFound("blob not found");
    const mime = blob.type.split(";")[0].trim().toLowerCase();
    const inline = isInlineSafe(mime);
    const headers: Record<string, string> = {
      "content-type": JS_MIME.test(mime) ? "text/plain; charset=utf-8" : blob.type,
      "content-length": String(blob.size),
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      // Chromium won't play a directly-opened media document under `sandbox`; default-src 'none' still blocks scripts.
      // XML "media" (`video/x+xml`, `audio/xml`) renders as a document, so it stays sandboxed like everything else.
      "content-security-policy": /^(audio|video)\//.test(mime) && inline ? "default-src 'none'; media-src 'self'" : "default-src 'none'; sandbox",
    };
    if (!inline) headers["content-disposition"] = `attachment; filename="${s}"`;
    return new Response(blob.body, { headers });
  });

  app.get("/media/:sha256", requirePermission("media.view"), async (c) => {
    const rec = await blossom().get(sha(c.req.param("sha256")));
    if (!rec) throw notFound("blob not found");
    return c.json(rec);
  });

  // Deleting, blocking or hiding (pending / blocked) a stored blob follows the moderation ranks against its uploaders
  // (UserService.assertCanModerateBlob). Approving takes nothing away from them, but undoes whoever hid the blob, so it
  // needs at least their rank (assertCanOverride on `moderatedBy`). A hash with no stored blob has no uploader to
  // protect, so it can be blocked ahead of an upload.
  app.post("/media/bulk", requirePermission("media.moderate"), async (c) => {
    const b = blossom();
    const body = await readBody(c, BulkSchema);
    const actor = principalOf(c);
    const ip = c.get("ip");
    const prot = body.action === "approve" || actor.role === "owner" ? undefined : await ctx.users.protectedAuthors(actor);
    const result: MediaBulkResult = { ok: 0, failed: [] };
    for (const s of body.sha256s) {
      try {
        if (actor.role !== "owner") {
          const rec = await b.get(s);
          if (rec && body.action === "approve") {
            if (rec.status !== "approved") await ctx.users.assertCanOverride(actor, rec.moderatedBy, "approve this blob");
          } else if (rec && prot) await ctx.users.assertCanModerateBlob(actor, rec, prot);
        }
        if (body.action === "delete") await b.delete(s, actor.pubkey, { ip });
        else await b.setStatus(s, body.action === "approve" ? "approved" : "blocked", actor.pubkey, { ip });
        result.ok++;
      } catch (err) {
        result.failed.push({ sha256: s, error: (err as Error).message });
      }
    }
    // blossom records an entry per blob as well; this one names the whole request
    await ctx.audit(c, `media.bulk.${body.action}`, null, { ...auditLists({ sha256s: body.sha256s, failed: result.failed }), ok: result.ok });
    return c.json(result);
  });

  app.post("/media/:sha256/status", requirePermission("media.moderate"), async (c) => {
    const b = blossom();
    const s = sha(c.req.param("sha256"));
    const { status } = await readBody(c, StatusSchema);
    const rec = await b.get(s);
    if (!rec) throw notFound("blob not found");
    if (status !== "approved") await ctx.users.assertCanModerateBlob(principalOf(c), rec);
    else if (rec.status !== "approved") await ctx.users.assertCanOverride(principalOf(c), rec.moderatedBy, "approve this blob");
    await b.setStatus(s, status, principalOf(c).pubkey, { ip: c.get("ip") }); // blossom records the audit entry
    return c.json((await b.get(s)) ?? { ok: true });
  });

  app.delete("/media/:sha256", requirePermission("media.moderate"), async (c) => {
    const b = blossom();
    const s = sha(c.req.param("sha256"));
    const block = c.req.query("block") === "true" || c.req.query("block") === "1";
    const rec = await b.get(s);
    if (rec) await ctx.users.assertCanModerateBlob(principalOf(c), rec);
    await b.delete(s, principalOf(c).pubkey, { block, ip: c.get("ip") }); // blossom records the audit entry
    return c.json({ ok: true });
  });
}
