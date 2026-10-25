import type { Filter, ReadContext } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { withPrefix } from "../util/reasons";
import type { Connection } from "./connection";
import { admitQuery, admitSearch, authReadDenied, meteredStore, READ_RATE_ERROR, readRate, refundSearch, runSearch, type SearchCharge, withQuerySlot } from "./read-guard";
import { isSearchFilter } from "./read-limits";
import { countVisible, hiddenIds } from "./visibility-scan";

// ------------------------------------------------------------------ COUNT (NIP-45)

function countDenied(ctx: RelayContext, conn: Connection, filters: Filter[]): string | undefined {
  const authed = conn.authedPubkeys;
  const within = (vals: string[] | undefined) => !!vals && vals.length > 0 && vals.every((v) => authed.has(v));
  for (const f of filters) {
    if (f.kinds?.includes(1059) && !within(f["#p"])) {
      return authed.size ? "restricted: gift wraps can only be counted for your own pubkey (#p)" : "auth-required: authentication is required to count direct messages";
    }
    if (f.kinds?.includes(4) && !within(f["#p"]) && !within(f.authors)) {
      return authed.size ? "restricted: direct messages can only be counted for your own pubkey" : "auth-required: authentication is required to count direct messages";
    }
    for (const h of f["#h"] ?? []) {
      if (!ctx.groups.isPrivateGroup(h)) continue;
      let member = false;
      for (const pk of authed) if (ctx.groups.isMember(h, pk)) member = true;
      if (!member) return authed.size ? "restricted: not a member of this group" : "auth-required: this group is private";
    }
  }
  return undefined;
}

export async function handleCount(ctx: RelayContext, conn: Connection, subId: string, input: Filter[]): Promise<void> {
  const denied = authReadDenied(ctx, conn) ?? countDenied(ctx, conn, input);
  if (denied) return conn.closedSub(subId, denied);
  const rate = await readRate(ctx, conn);
  if (rate === "limited") return conn.closedSub(subId, "rate-limited: too many requests");
  if (rate === "error") return conn.closedSub(subId, READ_RATE_ERROR);
  const started = performance.now();
  let hq: { filters: Filter[] } | { reject: string };
  try {
    hq = await ctx.hooks.runQuery(input, { conn, subId, source: "count" });
  } catch {
    return conn.closedSub(subId, "error: query policy failed");
  }
  if ("reject" in hq) return conn.closedSub(subId, withPrefix(hq.reject, "blocked"));
  let search: SearchCharge | null = null;
  if (hq.filters.some(isSearchFilter)) {
    const admitted = admitSearch(ctx, conn, rate === "staff");
    if ("reason" in admitted) return conn.closedSub(subId, admitted.reason);
    search = admitted;
  } else {
    const refused = admitQuery(ctx, conn, rate === "staff");
    if (refused) return conn.closedSub(subId, refused);
  }
  // bounded per connection like REQ, so one connection's burst of COUNTs can't take every relay-wide slot
  await conn.queries.acquire();
  if (conn.closed) {
    conn.queries.release();
    if (search) refundSearch(ctx, conn, search);
    return;
  }
  try {
    const filters = hq.filters.map(({ limit: _l, ...f }) => f);
    const rctx: ReadContext = { conn, subId, source: "count" };
    const pluginHooks = ctx.hooks.counts.visibility > 0;
    // a search's queries are timed (and budgeted) by runSearch as a whole
    const store = search ? ctx.stores.events : meteredStore(ctx, conn, rate === "staff");
    // Plugin hooks may hide any event: candidates are checked one by one (in batches). Otherwise only the
    // built-in private subsets are checked. Counted first: everything counted already exists when the
    // hidden set is computed, so a private event stored in between can only lower the count.
    const work = async (): Promise<number | null> => {
      if (pluginHooks) return countVisible(ctx, store, conn, filters, rctx);
      const total = await store.count(filters);
      const hidden = await hiddenIds(ctx, store, conn, filters, rctx);
      return hidden ? Math.max(0, total - hidden.size) : null;
    };
    const r = search
      ? await runSearch(ctx, conn, search, undefined, (timed) => withQuerySlot(ctx, undefined, () => timed(work)))
      : await withQuerySlot(ctx, undefined, work);
    if ("aborted" in r) return;
    if ("reason" in r) return conn.closedSub(subId, r.reason);
    const count = r.value;
    if (count === null) {
      // an "approximate" count that includes hidden events would let clients compute the hidden ones
      return conn.closedSub(
        subId,
        pluginHooks
          ? "restricted: filter matches too many events to count under this relay's visibility rules; narrow it"
          : "restricted: filter matches too many private events to count; narrow it with kinds",
      );
    }
    conn.send(["COUNT", subId, { count }]);
    ctx.bus.emit("req.executed", { connId: conn.id, subId, filters: hq.filters, results: count, durationMs: performance.now() - started, ip: conn.ip });
  } catch (err) {
    ctx.logger.error("COUNT failed", { err: String(err) });
    conn.closedSub(subId, "error: count failed");
  } finally {
    conn.queries.release();
  }
}
