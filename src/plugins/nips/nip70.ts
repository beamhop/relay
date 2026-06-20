import { hasMarkerTag } from "../../kinds";
import type { NostrEvent, ValidationResult } from "../../types";
import type { RelayPlugin } from "../types";

export const nip70: RelayPlugin = {
  nip: "70",
  name: "Protected Events",
  relay: true,
  advertise: true,
  eventKinds: [],
  validateEventWhenDisabled: (event) => {
    if (!hasMarkerTag(event, "-")) return undefined;
    return { ok: false, prefix: "unsupported", message: "NIP-70 plugin is disabled" };
  },
  validateEvent: (event, context) => {
    if (!hasMarkerTag(event, "-")) return validateProtectedRepost(event);
    if (!context.config.acceptProtectedEvents) {
      return { ok: false, prefix: "blocked", message: "protected events are disabled by relay policy" };
    }
    const connection = context.connection;
    if (!connection || !connection.authenticatedPubkeys.has(event.pubkey)) {
      return { ok: false, prefix: "auth-required", message: "protected event may only be published by its authenticated author" };
    }
    return validateProtectedRepost(event);
  },
};

function validateProtectedRepost(event: NostrEvent): ValidationResult {
  if (event.kind !== 6 && event.kind !== 16) return { ok: true };
  if (!event.content.trim().startsWith("{")) return { ok: true };
  try {
    const embedded = JSON.parse(event.content) as Partial<NostrEvent>;
    if (Array.isArray(embedded.tags) && embedded.tags.some((tag) => Array.isArray(tag) && tag.length === 1 && tag[0] === "-")) {
      return { ok: false, prefix: "blocked", message: "reposts must not embed protected events" };
    }
  } catch {
    return { ok: true };
  }
  return { ok: true };
}
