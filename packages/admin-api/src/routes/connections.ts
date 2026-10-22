import { z } from "zod";
import type { ConnectionView } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { badRequest, notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import { tryParsePubkey } from "../util/pubkey";
import { readBody } from "../util/request";

const DisconnectSchema = z.object({ pubkey: z.string().optional(), ip: z.string().max(64).optional() });

export function registerConnectionRoutes(app: AdminApp, ctx: ApiContext) {
  const { relay, metrics } = ctx.deps;

  app.get("/connections", requirePermission("connections.manage"), (c) => {
    const items: ConnectionView[] = relay.connections().map((conn) => {
      const g = metrics.lookupIp(conn.ip);
      return g ? { ...conn, geo: { country: g.country, ...(g.city ? { city: g.city } : {}) } } : conn;
    });
    return c.json({ items, total: items.length });
  });

  app.delete("/connections/:id", requirePermission("connections.manage"), async (c) => {
    const id = c.req.param("id");
    const closed = relay.disconnect({ id });
    if (!closed) throw notFound("connection not found");
    await ctx.audit(c, "connection.disconnect", id, { closed });
    return c.json({ ok: true, closed });
  });

  app.post("/connections/disconnect", requirePermission("connections.manage"), async (c) => {
    const body = await readBody(c, DisconnectSchema);
    const pubkey = body.pubkey ? tryParsePubkey(body.pubkey) : undefined;
    if (body.pubkey && !pubkey) throw badRequest("invalid pubkey");
    if (!pubkey && !body.ip) throw badRequest("pubkey or ip required");
    const closed = relay.disconnect(pubkey ? { pubkey } : { ip: body.ip });
    await ctx.audit(c, "connection.disconnect", pubkey ?? body.ip ?? null, { closed });
    return c.json({ ok: true, closed });
  });
}
