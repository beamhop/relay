import { isIP } from "node:net";
import { z } from "zod";
import type { IpRuleInput } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import type { SameFields } from "../util/contract";
import { canonicalCidr, ipv6Groups } from "../util/ip";
import { readBody } from "../util/request";

/**
 * Widest prefixes an allow rule may have without `confirmBroad`. An allow rule exempts every matching address from the
 * per-IP connection and message limits and overrides every block rule, so a wide one (say 0.0.0.0/0, added to "let
 * everyone in", which a public relay already does) makes the relay trivially floodable.
 */
export const BROAD_ALLOW_PREFIX = { 4: 16, 6: 48 } as const;

/** `::ffff:a.b.c.d` (in any spelling): the relay matches such rules as IPv4. */
function isV4Mapped(ip: string): boolean {
  const g = ipv6Groups(ip);
  return !!g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
}

/**
 * Family and prefix length a rule is matched with, as the relay does it (core util/cidr): an IPv4-mapped IPv6 rule
 * applies to IPv4 with 96 bits less (and is ignored below /96, so null). Null for anything that isn't an IP / CIDR.
 */
export function ruleScope(cidr: string): { v: 4 | 6; bits: number } | null {
  const [ip, prefix, ...rest] = cidr.split("/");
  const v = isIP(ip);
  if (!v || rest.length || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) return null;
  const width = v === 4 ? 32 : 128;
  const bits = prefix === undefined ? width : Number(prefix);
  if (bits > width) return null;
  if (v === 6 && isV4Mapped(ip)) return bits >= 96 ? { v: 4, bits: bits - 96 } : null;
  return { v: v as 4 | 6, bits };
}

/** Validates a single IP or CIDR (v4/v6) the relay can match. */
export const isValidCidr = (s: string): boolean => ruleScope(s) !== null;

const IpRuleSchema = z.object({
  cidr: z.string().trim().max(64).refine(isValidCidr, "invalid IP or CIDR").transform(canonicalCidr),
  action: z.enum(["block", "allow"]),
  reason: z.string().max(1000).default(""),
  /** acknowledges an allow rule wider than an IPv4 /16 or an IPv6 /48 */
  confirmBroad: z.boolean().optional(),
});
true satisfies SameFields<z.output<typeof IpRuleSchema>, IpRuleInput>;

const addressCount = (hostBits: number) => (hostBits <= 32 ? (2 ** hostBits).toLocaleString("en-US") : `2^${hostBits}`);

export function registerIpRoutes(app: AdminApp, ctx: ApiContext) {
  const { ipRules } = ctx.deps.stores;

  app.get("/ip-rules", requirePermission("ip.manage"), async (c) => c.json({ items: await ipRules.list() }));

  app.post("/ip-rules", requirePermission("ip.manage"), async (c) => {
    const { confirmBroad, ...rule } = await readBody(c, IpRuleSchema);
    const scope = rule.action === "allow" ? ruleScope(rule.cidr) : null;
    const broad = !!scope && scope.bits < BROAD_ALLOW_PREFIX[scope.v];
    if (broad && !confirmBroad) {
      const hostBits = (scope.v === 4 ? 32 : 128) - scope.bits;
      throw badRequest(
        `allow rule ${rule.cidr} covers ${addressCount(hostBits)} addresses: an allow rule exempts them from the per-IP connection and ` +
          "message limits and overrides every block rule (a public relay already lets everyone connect). Resend with confirmBroad: true to add it anyway",
        "broad_allow_rule",
      );
    }
    const { disconnected, replaced } = await ctx.moderation.addIpRule(rule, principalOf(c).pubkey);
    await ctx.audit(c, "ip.add", rule.cidr, {
      action: rule.action,
      reason: rule.reason,
      disconnected,
      ...(broad ? { confirmedBroad: true } : {}),
      ...(replaced ? { replaced: { cidr: replaced.cidr, action: replaced.action, reason: replaced.reason } } : {}),
    });
    const saved = (await ipRules.list()).find((r) => r.cidr === rule.cidr);
    return c.json(saved ?? { ...rule, createdAt: ctx.nowSec() }, 201);
  });

  app.delete("/ip-rules/:cidr", requirePermission("ip.manage"), async (c) => {
    const cidr = decodeURIComponent(c.req.param("cidr"));
    if (!(await ctx.moderation.removeIpRule(cidr, principalOf(c).pubkey))) throw notFound("ip rule not found");
    await ctx.audit(c, "ip.remove", cidr);
    return c.json({ ok: true });
  });
}
