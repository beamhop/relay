import { z } from "zod";
import type { BlossomService, MediaStats } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, HttpError, notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
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
    const s = sha(c.req.param("sha256"));
    const blob = await blossom().read(s, { thumbnail: c.req.query("thumb") === "1" });
    if (!blob) throw notFound("blob not found");
    const mime = blob.type.split(";")[0].trim().toLowerCase();
    const inline = isInlineSafe(mime);
    const headers: Record<string, string> = {
      "content-type": blob.type,
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

  app.post("/media/bulk", requirePermission("media.moderate"), async (c) => {
    const b = blossom();
    const body = await readBody(c, BulkSchema);
    const actor = principalOf(c).pubkey;
    const result = { ok: 0, failed: [] as { sha256: string; pubkey: string; error: string }[] };
    for (const s of body.sha256s) {
      try {
        if (body.action === "delete") await b.delete(s, actor);
        else await b.setStatus(s, body.action === "approve" ? "approved" : "blocked", actor);
        result.ok++;
      } catch (err) {
        result.failed.push({ sha256: s, pubkey: s, error: (err as Error).message });
      }
    }
    await ctx.audit(c, `media.bulk.${body.action}`, null, { sha256s: body.sha256s.slice(0, 100), ok: result.ok, failed: result.failed.length });
    return c.json(result);
  });

  app.post("/media/:sha256/status", requirePermission("media.moderate"), async (c) => {
    const b = blossom();
    const s = sha(c.req.param("sha256"));
    const { status } = await readBody(c, z.object({ status: STATUS }));
    if (!(await b.get(s))) throw notFound("blob not found");
    await b.setStatus(s, status, principalOf(c).pubkey); // blossom records the audit entry
    return c.json((await b.get(s)) ?? { ok: true });
  });

  app.delete("/media/:sha256", requirePermission("media.moderate"), async (c) => {
    const b = blossom();
    const s = sha(c.req.param("sha256"));
    const block = c.req.query("block") === "true" || c.req.query("block") === "1";
    await b.delete(s, principalOf(c).pubkey, { block }); // blossom records the audit entry
    return c.json({ ok: true });
  });
}
