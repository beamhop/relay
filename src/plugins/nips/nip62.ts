import { tagValues } from "../../kinds";
import type { RelayPlugin } from "../types";

export const nip62: RelayPlugin = {
  nip: "62",
  name: "Request to Vanish",
  relay: true,
  advertise: true,
  eventKinds: [62],
  validateEvent: (event) => {
    if (event.kind !== 62) return { ok: true };
    if (tagValues(event, "relay").length === 0) return { ok: false, prefix: "invalid", message: "vanish request requires relay tag" };
    return { ok: true };
  },
  afterEventAccepted: async (event, context) => {
    await context.store.applyVanishRequest(event, context.relayUrls);
  },
};
