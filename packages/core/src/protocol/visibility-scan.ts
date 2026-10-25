import type { Filter, ReadContext } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { isVisibleTo, restrictedSubFilters } from "../subscriptions/visibility";
import { yieldToLoop } from "./backpressure";
import type { Connection } from "./connection";
import { MAX_PRIVATE_SCAN, MAX_SEARCH_COUNT_SCAN, MAX_VISIBILITY_SCAN, VISIBILITY_BATCH, VISIBILITY_BATCH_BYTES } from "./limits";
import { isSearchFilter } from "./read-limits";
import type { ReadStore } from "./read-guard";

/**
 * Stored events matching `filters` that the connection may not see under the built-in privacy rules, which
 * only affect a known subset of events (restrictedSubFilters), as id → created_at. Returns null when too many
 * candidates exist to check cheaply (caller should refuse). Candidates are listed by id and checked in
 * small batches: anyone can store thousands of them (gift wraps, DMs) near maxEventBytes each.
 */
export async function hiddenIds(ctx: RelayContext, store: ReadStore, conn: Connection, filters: Filter[], rctx: ReadContext): Promise<Map<string, number> | null> {
  const subs = filters.flatMap((f) => restrictedSubFilters(ctx, f, conn.authedPubkeys));
  const hidden = new Map<string, number>();
  if (!subs.length) return hidden;
  const candidates = new Map<string, { id: string; created_at: number }>();
  for (const { limit: _x, ...f } of subs) {
    const items = await candidateIds(store, f, MAX_PRIVATE_SCAN);
    if (!items) return null;
    for (const it of items) candidates.set(it.id, it);
    if (candidates.size > MAX_PRIVATE_SCAN) return null;
  }
  const visible = await filterVisible(ctx, store, conn, [...candidates.values()], rctx);
  if (!visible) return null;
  const seen = new Set(visible.map((it) => it.id));
  for (const [id, it] of candidates) if (!seen.has(id)) hidden.set(id, it.created_at);
  return hidden;
}

/**
 * (id, created_at) of the events matching `f`, or null when more than `max` match. Search can't be listed
 * by id (the store applies it only when loading events), so search matches are counted first and loaded
 * only when at most MAX_SEARCH_COUNT_SCAN match (searches run one at a time relay-wide).
 */
export async function candidateIds(store: ReadStore, f: Filter, max: number): Promise<{ id: string; created_at: number }[] | null> {
  if (!isSearchFilter(f)) {
    const items = await store.queryIdsForSync({ ...f, limit: max + 1 });
    return items.length > max ? null : items;
  }
  const cap = Math.min(max, MAX_SEARCH_COUNT_SCAN);
  if ((await store.count([f])) > cap) return null;
  const evs = await store.query([{ ...f, limit: cap + 1 }], { maxLimit: cap + 1 });
  return evs.length > cap ? null : evs.map((ev) => ({ id: ev.id, created_at: ev.created_at }));
}

/**
 * Exact count of the events matching `filters` that the connection may see, when plugin visibility hooks
 * may hide anything: candidate ids are listed (cheap), then checked in batches like sync candidates.
 * Returns null when there are too many candidates to check.
 */
export async function countVisible(ctx: RelayContext, store: ReadStore, conn: Connection, filters: Filter[], rctx: ReadContext): Promise<number | null> {
  const candidates = new Map<string, { id: string; created_at: number }>();
  for (const f of filters) {
    const items = await candidateIds(store, f, MAX_VISIBILITY_SCAN);
    if (!items) return null;
    for (const it of items) candidates.set(it.id, it);
    if (candidates.size > MAX_VISIBILITY_SCAN) return null;
  }
  const visible = await filterVisible(ctx, store, conn, [...candidates.values()], rctx);
  return visible ? visible.length : null;
}

/** Events loaded at once for visibility checks: at most VISIBILITY_BATCH, and about VISIBILITY_BATCH_BYTES. */
function visibilityBatch(ctx: RelayContext): number {
  return Math.max(16, Math.min(VISIBILITY_BATCH, Math.floor(VISIBILITY_BATCH_BYTES / ctx.s().limits.maxEventBytes)));
}

/**
 * Keeps the sync candidates the connection may see, checking each event (built-in rules and plugin
 * hooks) in batches. Returns null when there are too many candidates to check.
 */
export async function filterVisible(
  ctx: RelayContext,
  store: ReadStore,
  conn: Connection,
  items: { id: string; created_at: number }[],
  rctx: ReadContext,
): Promise<{ id: string; created_at: number }[] | null> {
  if (items.length > MAX_VISIBILITY_SCAN) return null;
  const out: { id: string; created_at: number }[] = [];
  const size = visibilityBatch(ctx);
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const events = await store.query([{ ids: batch.map((it) => it.id) }], { maxLimit: batch.length });
    const byId = new Map(events.map((ev) => [ev.id, ev]));
    for (const it of batch) {
      const ev = byId.get(it.id);
      // gone since the id query: leave it out rather than disclose it unchecked
      if (ev && isVisibleTo(ctx, ev, conn, rctx)) out.push(it);
    }
    if (conn.closed) return out;
    await yieldToLoop(); // sqlite queries are synchronous: let other connections in between batches
  }
  return out;
}
