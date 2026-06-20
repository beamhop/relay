import type { RelayPlugin } from "../types";

export const nip50: RelayPlugin = {
  nip: "50",
  name: "Search Capability",
  relay: true,
  advertise: true,
  eventKinds: [],
  authorizeFilters: (filters) => {
    for (const filter of filters) {
      if (typeof filter.search === "string" && filter.search.length > 512) {
        return { ok: false, prefix: "invalid", message: "search query is too long" };
      }
    }
    return { ok: true };
  },
};
