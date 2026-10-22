import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { notFound } from "../errors";
import { requirePermission } from "../middleware/auth";

export function registerGroupRoutes(app: AdminApp, ctx: ApiContext) {
  const { groups } = ctx.deps.relay;

  app.get("/groups", requirePermission("groups.view"), async (c) => c.json({ items: await groups.list() }));

  app.get("/groups/:id", requirePermission("groups.view"), async (c) => {
    const g = await groups.get(c.req.param("id"));
    if (!g) throw notFound("group not found");
    return c.json(g);
  });

  app.delete("/groups/:id", requirePermission("groups.manage"), async (c) => {
    const id = c.req.param("id");
    const g = await groups.get(id);
    if (!g) throw notFound("group not found");
    await groups.delete(id, principalOf(c).pubkey);
    await ctx.audit(c, "group.delete", id, { name: g.name });
    return c.json({ ok: true });
  });
}
