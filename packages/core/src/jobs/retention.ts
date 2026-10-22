import { type Filter, type RetentionRule, nowSec } from "@beamhop/sdk";
import type { RelayContext } from "../context";

const BATCH = 1000;
/** upper bound of events examined per rule per run, keeps the job from monopolizing the DB */
const MAX_SCAN = 200_000;
const GROUP_META = [39000, 39001, 39002, 39003];

/** Applies settings.retention rules. Returns number of deleted events. */
export async function runRetention(ctx: RelayContext): Promise<number> {
  let total = 0;
  for (const rule of ctx.s().retention.rules) {
    if (!rule.enabled) continue;
    const exempt = new Set(rule.exemptPubkeys);
    // never let retention eat relay-signed NIP-29 state
    if (!rule.kinds?.length || rule.kinds.some((k) => GROUP_META.includes(k))) exempt.add(ctx.key.pubkey);
    try {
      if (rule.maxAgeDays && rule.maxAgeDays > 0) total += await purgeOlderThan(ctx, rule, exempt);
      if (rule.maxPerPubkey && rule.maxPerPubkey > 0) total += await capPerPubkey(ctx, rule, exempt);
    } catch (err) {
      ctx.logger.error("retention rule failed", { rule: rule.id, err: String(err) });
    }
  }
  if (total > 0) {
    ctx.logger.info("retention removed events", { count: total });
    ctx.bus.emit("event.deleted", { ids: [], actor: "system:retention", reason: `retention removed ${total} events` });
  }
  return total;
}

async function purgeOlderThan(ctx: RelayContext, rule: RetentionRule, exempt: Set<string>): Promise<number> {
  const base: Filter = { until: nowSec() - Math.floor(rule.maxAgeDays! * 86400) };
  if (rule.kinds?.length) base.kinds = rule.kinds;
  if (exempt.size === 0) return ctx.stores.events.deleteByFilter([base]);

  let deleted = 0;
  let scanned = 0;
  let until = base.until!;
  while (scanned < MAX_SCAN) {
    const batch = await ctx.stores.events.query([{ ...base, until, limit: BATCH }], { maxLimit: BATCH });
    scanned += batch.length;
    const ids = batch.filter((e) => !exempt.has(e.pubkey)).map((e) => e.id);
    if (ids.length) deleted += await ctx.stores.events.deleteByIds(ids);
    if (batch.length < BATCH) break;
    const oldest = batch[batch.length - 1].created_at;
    until = ids.length === 0 && oldest === until ? oldest - 1 : oldest;
  }
  return deleted;
}

async function capPerPubkey(ctx: RelayContext, rule: RetentionRule, exempt: Set<string>): Promise<number> {
  const max = rule.maxPerPubkey!;
  let deleted = 0;
  // candidate authors: users with more events than the cap (eventCount is an upper bound across kinds)
  for (let offset = 0; offset < 100_000; offset += 200) {
    const { items } = await ctx.stores.users.list({ sort: "eventCount", limit: 200, offset });
    if (!items.length) break;
    let anyOver = false;
    for (const u of items) {
      if (u.eventCount <= max) continue;
      anyOver = true;
      if (exempt.has(u.pubkey)) continue;
      const f: Filter = { authors: [u.pubkey], limit: max + 5000 };
      if (rule.kinds?.length) f.kinds = rule.kinds;
      const evs = await ctx.stores.events.query([f], { maxLimit: max + 5000 });
      if (evs.length > max) deleted += await ctx.stores.events.deleteByIds(evs.slice(max).map((e) => e.id));
    }
    if (!anyOver) break;
  }
  return deleted;
}
