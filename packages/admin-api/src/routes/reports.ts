import { z } from "zod";
import type { BulkResult } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import { parseEventId, tryParsePubkey } from "../util/pubkey";
import { readBody, readQuery } from "../util/request";

const ACTIONS = ["dismiss", "delete-event", "ban-user", "delete-and-ban", "delete-media"] as const;
const ListQuery = z.object({
  status: z.enum(["open", "resolved", "dismissed"]).optional(),
  type: z.string().max(50).optional(),
  target: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});
const ResolveSchema = z.object({ action: z.enum(ACTIONS), note: z.string().max(2000).optional() });
const BulkSchema = z.object({ ids: z.array(z.string()).min(1).max(500), action: z.enum(ACTIONS), note: z.string().max(2000).optional() });

export function registerReportRoutes(app: AdminApp, ctx: ApiContext) {
  // ?target: a pubkey (hex / npub) lists the reports whose targetPubkey it is (see ReportService.list), or an event id / blob hash
  app.get("/reports", requirePermission("reports.view"), async (c) => {
    const q = readQuery(c, ListQuery);
    const target = q.target ? (tryParsePubkey(q.target) ?? q.target.toLowerCase()) : undefined;
    return c.json(await ctx.reports.list({ ...q, type: q.type?.toLowerCase(), target }));
  });

  app.get("/reports/:id", requirePermission("reports.view"), async (c) => {
    const view = await ctx.reports.get(parseEventId(c.req.param("id")));
    if (!view) throw notFound("report not found");
    return c.json(view);
  });

  app.post("/reports/:id/resolve", requirePermission("reports.resolve"), async (c) => {
    const id = parseEventId(c.req.param("id"));
    const body = await readBody(c, ResolveSchema);
    const { report, effects } = await ctx.reports.resolve(id, body, principalOf(c));
    await ctx.audit(c, "report.resolve", id, { action: body.action, note: body.note, target: report.targetEventId ?? report.targetBlob ?? report.targetPubkey, ...effects });
    return c.json(report);
  });

  app.post("/reports/bulk-resolve", requirePermission("reports.resolve"), async (c) => {
    const body = await readBody(c, BulkSchema);
    const result: BulkResult & { failed: { id: string; pubkey: string; error: string }[] } = { ok: 0, failed: [] };
    for (const raw of body.ids) {
      try {
        await ctx.reports.resolve(parseEventId(raw), body, principalOf(c));
        result.ok++;
      } catch (err) {
        result.failed.push({ id: raw, pubkey: raw, error: (err as Error).message });
      }
    }
    await ctx.audit(c, "report.bulk-resolve", null, { ids: body.ids.slice(0, 100), action: body.action, note: body.note, ok: result.ok, failed: result.failed.length });
    return c.json(result);
  });
}
