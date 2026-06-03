/**
 * NIP-45: Event Counts.
 *
 * Handles the `COUNT` verb: `["COUNT", <subId>, ...filters]` -> the relay
 * replies `["COUNT", <subId>, { count: <n> }]` with the number of stored events
 * matching the filters. Counts honor visibility filters (e.g. NIP-40 expired
 * events are not counted) but ignore per-filter `limit`.
 */
import type { NostrPlugin } from "../plugin.ts";
import type { Filter } from "../types.ts";

export function nip45(): NostrPlugin {
  return {
    name: "nip45",
    supportedNips: [45],

    messageHandlers: {
      COUNT: (conn, msg, ctx) => {
        const subId = msg[1];
        if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) {
          conn.send(["NOTICE", "invalid: COUNT subscription id must be 1-64 chars"]);
          return true;
        }
        const filters = (msg as [string, string, ...Filter[]]).slice(2) as Filter[];

        // Strip per-filter `limit`: a count is the true number of matches, not a
        // page of them (NIP-45). query() dedupes across filters; the visibility
        // filter hides events that are present but not servable (e.g. NIP-40).
        const unlimited = filters.map(({ limit: _omit, ...rest }) => rest);
        let count = 0;
        for (const event of ctx.store.query(unlimited)) {
          if (ctx.isVisible(event)) count++;
        }
        conn.send(["COUNT", subId, { count }]);
        return true;
      },
    },
  };
}
