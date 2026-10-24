import { z } from "zod";
import type { SeriesResponse, TimeRange } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { badRequest } from "../errors";
import { requirePermission } from "../middleware/auth";
import { readQuery } from "../util/request";

const MAX_RANGE_SEC = 400 * 86400;
const RangeQuery = z.object({
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  step: z.coerce.number().int().min(1).max(86400 * 31).optional(),
});

function defaultStep(rangeSec: number): number {
  if (rangeSec <= 2 * 3600) return 60;
  if (rangeSec <= 24 * 3600) return 300;
  if (rangeSec <= 7 * 86400) return 3600;
  if (rangeSec <= 60 * 86400) return 4 * 3600;
  return 86400;
}

export function registerMetricsRoutes(app: AdminApp, ctx: ApiContext) {
  const { metrics } = ctx.deps;

  const range = (q: z.infer<typeof RangeQuery>): TimeRange => {
    const to = q.to ?? ctx.nowSec();
    const from = q.from ?? to - 86400;
    if (from >= to) throw badRequest("from must be before to");
    if (to - from > MAX_RANGE_SEC) throw badRequest("range too large");
    const stepSec = q.step ?? defaultStep(to - from);
    if ((to - from) / stepSec > 5000) throw badRequest("too many points; increase step");
    return { from, to, stepSec };
  };

  app.get("/dashboard/snapshot", requirePermission("dashboard.view"), (c) => c.json(metrics.snapshot()));

  app.get("/metrics/series", requirePermission("dashboard.view"), async (c) => {
    const q = readQuery(c, RangeQuery.extend({ name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/) }));
    const body: SeriesResponse = { name: q.name, points: await metrics.series(q.name, range(q)) };
    return c.json(body);
  });

  app.get("/metrics/kinds", requirePermission("dashboard.view"), async (c) => {
    return c.json({ items: await metrics.kinds(range(readQuery(c, RangeQuery))) });
  });

  app.get("/metrics/top-pubkeys", requirePermission("dashboard.view"), async (c) => {
    const q = readQuery(c, RangeQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(10) }));
    const items = await metrics.topPubkeys(range(q), q.limit);
    const profiles = await ctx.profiles.getMany(items.map((i) => i.pubkey));
    return c.json({ items: items.map((i) => ({ ...i, profile: profiles.get(i.pubkey) })) });
  });

  app.get("/metrics/rejections", requirePermission("dashboard.view"), async (c) => {
    return c.json({ items: await metrics.rejections(range(readQuery(c, RangeQuery))) });
  });

  app.get("/metrics/geo", requirePermission("dashboard.view"), async (c) => {
    return c.json({ items: await metrics.geo(range(readQuery(c, RangeQuery))) });
  });
}
