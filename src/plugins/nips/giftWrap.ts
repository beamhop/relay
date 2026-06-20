import { tagValues } from "../../kinds";
import type { NostrFilter } from "../../types";
import type { RelayPlugin } from "../types";

export function giftWrapAccessHooks(): Pick<RelayPlugin, "authorizeFilters" | "filterOutgoingEvents"> {
  return {
    authorizeFilters: (filters, context) => {
      if (!filtersNeedGiftWrapAuth(filters, context.operation, 1059)) return { ok: true };
      if (context.connection && context.connection.authenticatedPubkeys.size > 0) return { ok: true };
      return { ok: false, prefix: "auth-required", message: "gift wraps require recipient authentication" };
    },
    filterOutgoingEvents: (events, context) => {
      const connection = context.connection;
      if (!connection || connection.authenticatedPubkeys.size === 0) return events.filter((event) => event.kind !== 1059);
      return events.filter((event) => {
        if (event.kind !== 1059) return true;
        const recipients = tagValues(event, "p");
        return recipients.some((pubkey) => connection.authenticatedPubkeys.has(pubkey));
      });
    },
  };
}

function filtersNeedGiftWrapAuth(filters: NostrFilter[], operation: "REQ" | "COUNT" | undefined, kind: number): boolean {
  return filters.some((filter) => {
    if (filter.kinds) return filter.kinds.includes(kind);
    return operation !== "REQ" || typeof filter.search !== "string" || !filter.search.trim();
  });
}
