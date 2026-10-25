import { z } from "zod";
import type { Invite, InviteCreateRequest, InviteView } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import type { SameFields } from "../util/contract";
import { readBody } from "../util/request";

const CreateSchema = z.object({
  maxUses: z.number().int().min(0).max(1_000_000).optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  note: z.string().max(1000).optional(),
  count: z.number().int().min(1).max(100).default(1),
});
true satisfies SameFields<z.output<typeof CreateSchema>, InviteCreateRequest>;

export function registerInviteRoutes(app: AdminApp, ctx: ApiContext) {
  const { invites } = ctx.deps.stores;
  const view = (i: Invite): InviteView => ({ ...i, url: `${ctx.publicUrl}/invite/${encodeURIComponent(i.code)}` });

  app.get("/invites", requirePermission("invites.manage"), async (c) => {
    return c.json({ items: (await invites.list()).map(view) });
  });

  app.post("/invites", requirePermission("invites.manage"), async (c) => {
    const body = await readBody(c, CreateSchema);
    const createdBy = principalOf(c).pubkey;
    const items: InviteView[] = [];
    for (let i = 0; i < body.count; i++) {
      items.push(view(await invites.create({ createdBy, maxUses: body.maxUses, expiresAt: body.expiresAt ?? null, note: body.note })));
    }
    await ctx.audit(c, "invite.create", null, { count: body.count, codes: items.map((i) => i.code), maxUses: body.maxUses, expiresAt: body.expiresAt });
    return c.json({ items }, 201);
  });

  app.delete("/invites/:code", requirePermission("invites.manage"), async (c) => {
    const code = c.req.param("code");
    if (!(await invites.list()).some((i) => i.code === code)) throw notFound("invite not found");
    await invites.revoke(code);
    await ctx.audit(c, "invite.revoke", code);
    return c.json({ ok: true });
  });
}
