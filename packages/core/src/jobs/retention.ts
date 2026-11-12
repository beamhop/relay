import { type EventStore, type Filter, type RetentionRule, nowSec, yieldToEventLoop } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { hexPubkey } from "../util/pubkey";
import { isDbSwitchingError } from "../util/db-switching";

/** candidate authors fetched per page (keyset by pubkey) */
const PAGE = 200;
const GROUP_META = [39000, 39001, 39002, 39003];

/**
 * Per-pubkey cap state that outlives a run: for each author checked, the stored count found and the author's
 * eventCount at that moment. eventCount only grows (lifetime accepted events), so `stored + (eventCount now -
 * eventCount then)` bounds what is stored now: an author still within the cap by that bound is not counted again.
 * Kept per event store (one relay) and rule settings; lost on restart (the next run re-counts once).
 */
type CapMemo = Map<string, { stored: number; eventCount: number }>;
const memos = new WeakMap<EventStore, Map<string, CapMemo>>();

/** Drops the per-pubkey cap memos of `store` (its database was switched: the next run re-counts). */
export function forgetRetentionMemos(store: EventStore): void {
  memos.delete(store);
}

/** Applies settings.retention rules. Returns number of deleted events. `signal` (shutdown) stops it between rules. */
export async function runRetention(ctx: RelayContext, signal?: AbortSignal): Promise<number> {
  let total = 0;
  let switching: unknown;
  for (const rule of ctx.s().retention.rules) {
    if (signal?.aborted) break;
    if (!rule.enabled) continue;
    // authors are matched as hex: an exempt pubkey stored as an npub must still exempt them
    const exempt = new Set(rule.exemptPubkeys.map((pk) => hexPubkey(pk) ?? pk));
    // never let retention eat relay-signed NIP-29 state
    if (!rule.kinds?.length || rule.kinds.some((k) => GROUP_META.includes(k))) exempt.add(ctx.key.pubkey);
    try {
      if (rule.maxAgeDays && rule.maxAgeDays > 0) total += await purgeOlderThan(ctx, rule, exempt);
      if (rule.maxPerPubkey && rule.maxPerPubkey > 0) total += await capPerPubkey(ctx, rule, exempt, signal);
    } catch (err) {
      // writes paused by a database switch: stop this run (what it removed is still announced), the caller retries soon
      if (isDbSwitchingError(err)) {
        switching = err;
        break;
      }
      ctx.logger.error("retention rule failed", { rule: rule.id, err: String(err) });
    }
  }
  if (total > 0) {
    ctx.logger.info("retention removed events", { count: total });
    ctx.bus.emit("event.deleted", { ids: [], actor: "system:retention", reason: `retention removed ${total} events` });
  }
  if (switching) throw switching;
  return total;
}

/** One SQL-side delete (batched by the store), exempt authors excluded there: no events are loaded. */
async function purgeOlderThan(ctx: RelayContext, rule: RetentionRule, exempt: Set<string>): Promise<number> {
  const base: Filter = { until: nowSec() - Math.floor(rule.maxAgeDays! * 86400) };
  if (rule.kinds?.length) base.kinds = rule.kinds;
  return ctx.stores.events.deleteByFilter([base], { exceptAuthors: [...exempt] });
}

/**
 * Candidates are users whose eventCount (lifetime accepted events, an upper bound of what they have stored) is
 * over the cap, paged by pubkey (stable while counts change). The store counts what each one really has stored and
 * trims it in SQL; authors found within the cap are skipped on later runs until they could have crossed it.
 */
async function capPerPubkey(ctx: RelayContext, rule: RetentionRule, exempt: Set<string>, signal?: AbortSignal): Promise<number> {
  const max = rule.maxPerPubkey!;
  const kinds = rule.kinds?.length ? [...rule.kinds] : undefined;
  const memo = capMemo(ctx.stores.events, `${rule.id}\u0000${max}\u0000${kinds?.join(",") ?? ""}`);
  let deleted = 0;
  let after: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    if (signal?.aborted) return deleted;
    const { items } = await ctx.stores.users.list({ sort: "pubkey", minEventCount: max, afterPubkey: after, limit: PAGE });
    if (!items.length) break;
    after = items[items.length - 1].pubkey;
    for (const u of items) {
      if (signal?.aborted) return deleted;
      seen.add(u.pubkey);
      if (exempt.has(u.pubkey)) continue;
      const known = memo.get(u.pubkey);
      if (known && known.stored + Math.max(0, u.eventCount - known.eventCount) <= max) continue;
      const r = await ctx.stores.events.trimPubkey(u.pubkey, max, { kinds });
      deleted += r.deleted;
      memo.set(u.pubkey, { stored: r.remaining, eventCount: u.eventCount });
    }
    if (items.length < PAGE) break;
    await yieldToEventLoop();
  }
  // users gone below the threshold (deleted) don't need their entry any more
  for (const pk of memo.keys()) if (!seen.has(pk)) memo.delete(pk);
  return deleted;
}

function capMemo(store: EventStore, key: string): CapMemo {
  let byRule = memos.get(store);
  if (!byRule) memos.set(store, (byRule = new Map()));
  let memo = byRule.get(key);
  if (!memo) byRule.set(key, (memo = new Map()));
  return memo;
}
