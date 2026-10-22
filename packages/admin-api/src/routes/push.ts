import { z } from "zod";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { notFound } from "../errors";
import { requireAdmin } from "../middleware/auth";
import { PUSH_TOPICS } from "../services/push";
import { readBody } from "../util/request";

const SubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "endpoint must be https"),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
  }),
  topics: z.array(z.enum(PUSH_TOPICS as unknown as ["reports", "alerts", "users"])).max(10).optional(),
});
const UnsubscribeSchema = z.object({ endpoint: z.string().max(2048) });

export function registerPushRoutes(app: AdminApp, ctx: ApiContext) {
  app.get("/push/vapid", requireAdmin(), (c) => c.json({ publicKey: ctx.push.publicKey }));

  app.post("/push/subscribe", requireAdmin(), async (c) => {
    if (!ctx.push.enabled) throw notFound("push disabled", "push_disabled");
    const body = await readBody(c, SubscribeSchema);
    const topics = body.topics ?? [...PUSH_TOPICS];
    await ctx.push.subscribe(principalOf(c).pubkey, body.subscription, topics);
    await ctx.audit(c, "push.subscribe", null, { topics });
    return c.json({ ok: true, topics });
  });

  app.post("/push/unsubscribe", requireAdmin(), async (c) => {
    const { endpoint } = await readBody(c, UnsubscribeSchema);
    const removed = await ctx.push.unsubscribe(principalOf(c).pubkey, endpoint);
    if (removed) await ctx.audit(c, "push.unsubscribe", null, {});
    return c.json({ ok: true, removed });
  });
}
