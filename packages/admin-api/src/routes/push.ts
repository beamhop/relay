import { z } from "zod";
import type { PushSubscribeRequest, PushUnsubscribeRequest } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { notFound } from "../errors";
import { requireAdmin } from "../middleware/auth";
import { isAllowedPushEndpoint, PUSH_TOPICS, type SentPushTopic } from "../services/push";
import type { Same } from "../util/contract";
import { readBody } from "../util/request";

const SubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048).refine(isAllowedPushEndpoint, "endpoint is not a known Web Push service"),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
  }),
  // legacy "users" is still accepted from older clients but dropped (it was never sent)
  topics: z
    .array(z.enum([...PUSH_TOPICS, "users"]))
    .max(10)
    .transform((t) => t.filter((x): x is SentPushTopic => x !== "users"))
    .optional(),
});
const UnsubscribeSchema = z.object({ endpoint: z.string().max(2048) });
true satisfies Same<z.output<typeof SubscribeSchema>, PushSubscribeRequest> & Same<z.output<typeof UnsubscribeSchema>, PushUnsubscribeRequest>;

export function registerPushRoutes(app: AdminApp, ctx: ApiContext) {
  app.get("/push/vapid", requireAdmin(), (c) => c.json({ publicKey: ctx.push.publicKey }));

  app.post("/push/subscribe", requireAdmin(), async (c) => {
    if (!ctx.push.enabled) throw notFound("push disabled", "push_disabled");
    const body = await readBody(c, SubscribeSchema);
    const topics = body.topics ?? [...PUSH_TOPICS];
    const p = principalOf(c);
    await ctx.push.subscribe(p.pubkey, body.subscription, topics, p.session?.id ?? null);
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
