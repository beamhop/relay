import { isIP } from "node:net";
import { z } from "zod";
import type { AdminApp, ApiContext } from "../context";
import { notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import { readBody } from "../util/request";

/** Validates a single IP or CIDR (v4/v6). */
export function isValidCidr(s: string): boolean {
  const [ip, prefix, ...rest] = s.split("/");
  if (rest.length) return false;
  const v = isIP(ip);
  if (!v) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (v === 4 ? 32 : 128);
}

export const IpRuleSchema = z.object({
  cidr: z.string().trim().max(64).refine(isValidCidr, "invalid IP or CIDR"),
  action: z.enum(["block", "allow"]),
  reason: z.string().max(1000).default(""),
});

export function registerIpRoutes(app: AdminApp, ctx: ApiContext) {
  const { ipRules } = ctx.deps.stores;

  app.get("/ip-rules", requirePermission("ip.manage"), async (c) => c.json({ items: await ipRules.list() }));

  app.post("/ip-rules", requirePermission("ip.manage"), async (c) => {
    const rule = await readBody(c, IpRuleSchema);
    await ipRules.add(rule);
    ctx.deps.bus.emit("ip.rules.changed", { actor: "admin-api" });
    let disconnected = 0;
    if (rule.action === "block" && !rule.cidr.includes("/")) disconnected = ctx.deps.relay.disconnect({ ip: rule.cidr });
    await ctx.audit(c, "ip.add", rule.cidr, { action: rule.action, reason: rule.reason, disconnected });
    const saved = (await ipRules.list()).find((r) => r.cidr === rule.cidr);
    return c.json(saved ?? { ...rule, createdAt: ctx.nowSec() }, 201);
  });

  app.delete("/ip-rules/:cidr", requirePermission("ip.manage"), async (c) => {
    const cidr = decodeURIComponent(c.req.param("cidr"));
    if (!(await ipRules.list()).some((r) => r.cidr === cidr)) throw notFound("ip rule not found");
    await ipRules.remove(cidr);
    ctx.deps.bus.emit("ip.rules.changed", { actor: "admin-api" });
    await ctx.audit(c, "ip.remove", cidr);
    return c.json({ ok: true });
  });
}
