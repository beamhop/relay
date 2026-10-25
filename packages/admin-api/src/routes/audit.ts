import { z } from "zod";
import type { AuditListQuery } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { requirePermission } from "../middleware/auth";
import type { SameFields } from "../util/contract";
import { tryParsePubkey } from "../util/pubkey";
import { readQuery } from "../util/request";

const Query = z.object({
  actor: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  target: z.string().max(500).optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
true satisfies SameFields<z.output<typeof Query>, AuditListQuery>;

export function registerAuditRoutes(app: AdminApp, ctx: ApiContext) {
  app.get("/audit", requirePermission("audit.view"), async (c) => {
    const q = readQuery(c, Query);
    const actor = q.actor ? (tryParsePubkey(q.actor) ?? q.actor) : undefined;
    const target = q.target ? (tryParsePubkey(q.target) ?? q.target) : undefined;
    return c.json({ items: await ctx.deps.stores.audit.list({ ...q, actor, target }) });
  });
}
