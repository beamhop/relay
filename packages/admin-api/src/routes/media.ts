import { z } from "zod";
import type { BlossomService, MediaStats } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, notFound } from "../errors";
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

  app.get("/media/stats", requirePermission("media.view"), async (c) => {
    const b = blossom();
    const [stats, pending] = await Promise.all([b.stats(), b.list({ status: "pending", limit: 1 })]);
    const out: MediaStats = { ...stats, pending: pending.total };
    return c.json(out);
  });

  // Admin preview: serves pending/blocked blobs too (public blossom routes hide them).
  app.get("/media/:sha256/raw", requirePermission("media.view"), async (c) => {
    const blob = await blossom().read(sha(c.req.param("sha256")), { thumbnail: c.req.query("thumb") === "1" });
    if (!blob) throw notFound("blob not found");
    return new Response(blob.body, {
      headers: {
        "content-type": blob.type,
        "content-length": String(blob.size),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
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
