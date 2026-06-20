import { hasMarkerTag } from "../../kinds";
import type { RelayPlugin } from "../types";

export const nip43: RelayPlugin = {
  nip: "43",
  name: "Relay Access Metadata and Requests",
  relay: true,
  advertise: true,
  eventKinds: [8000, 8001, 13534, 28934, 28935, 28936],
  validateEvent: (event, context) => {
    if (![8000, 8001, 13534, 28934, 28935, 28936].includes(event.kind)) return { ok: true };
    if (![28934, 28936].includes(event.kind) && context.config.relay.self && event.pubkey !== context.config.relay.self) {
      return { ok: false, prefix: "restricted", message: "relay access metadata must be signed by relay self pubkey" };
    }
    if (!hasMarkerTag(event, "-")) {
      return { ok: false, prefix: "invalid", message: "relay access events require protected tag" };
    }
    return { ok: true };
  },
};
