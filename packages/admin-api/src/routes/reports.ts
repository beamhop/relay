import { z } from "zod";
import type { ReportBulkResult } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import { newResolveMemo } from "../services/reports";
import { audited, auditLists } from "../util/audit";
import { parseEventId, tryParsePubkey } from "../util/pubkey";
import { readBody, readQuery } from "../util/request";

const ACTIONS = ["dismiss", "delete-event", "ban-user", "delete-and-ban", "delete-media"] as const;
const ListQuery = z.object({
  status: z.enum(["open", "resolved", "dismissed"]).optional(),
  type: z.string().max(50).optional(),
  target: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
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
    // audited however it ends: a failure after the ban or delete still records what was done
    const effects: Record<string, unknown> = {};
    let target: string | undefined;
    const { report } = await audited(
      (details) => ctx.audit(c, "report.resolve", id, details),
      () => ({ action: body.action, note: body.note, ...(target ? { target } : {}), ...effects }),
      async () => {
        const r = await ctx.reports.resolve(id, body, principalOf(c), c.get("ip"), effects);
        target = r.report.targetEventId ?? r.report.targetBlob ?? r.report.targetPubkey;
        return r;
      },
      // refused (rank, missing target) before anything was done
      () => !Object.keys(effects).length,
    );
    return c.json(report);
  });

  app.post("/reports/bulk-resolve", requirePermission("reports.resolve"), async (c) => {
    const body = await readBody(c, BulkSchema);
    const result: ReportBulkResult = { ok: 0, failed: [] };
    const effects: Record<string, unknown>[] = [];
    // no views are built (the response only counts), and each subject is banned / each target deleted once
    const memo = newResolveMemo();
    try {
      for (const raw of body.ids) {
        const done: Record<string, unknown> = {};
        try {
          const id = parseEventId(raw);
          await ctx.reports.apply(id, body, principalOf(c), c.get("ip"), done, memo);
          result.ok++;
        } catch (err) {
          result.failed.push({ id: raw, error: (err as Error).message });
        }
        if (Object.keys(done).length) effects.push({ id: raw, ...done });
      }
    } finally {
      // the full target list and what each resolution did (bans, deletions), as the single-report route records
      await ctx.audit(c, "report.bulk-resolve", null, { ...auditLists({ ids: body.ids, failed: result.failed, effects }), action: body.action, note: body.note, ok: result.ok });
    }
    return c.json(result);
  });
}
