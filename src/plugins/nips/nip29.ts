import { HEX_32_RE } from "../../crypto";
import type { NostrEvent, NostrFilter, ValidationResult } from "../../types";
import type { PluginContext, RelayPlugin } from "../types";

export const nip29: RelayPlugin = {
  nip: "29",
  name: "Relay-based Groups",
  relay: true,
  advertise: true,
  eventKinds: [9000, 9001, 9002, 9005, 9007, 9008, 9009, 9021, 9022, 39000, 39001, 39002, 39003, 39004],
  validateEvent: (event, context) => validateGroupEvent(event, context),
  authorizeFilters: (filters, context) => authorizeGroupFilters(filters, context),
};

function validateGroupEvent(event: NostrEvent, context: PluginContext): ValidationResult {
  const groupTag = event.tags.find((tag) => tag[0] === "h")?.[1];
  const metadataGroup = event.tags.find((tag) => tag[0] === "d")?.[1];
  if ([39000, 39001, 39002, 39003, 39004].includes(event.kind)) {
    if (!metadataGroup) return { ok: false, prefix: "invalid", message: "group metadata events require d tag" };
    if (context.config.relay.self && event.pubkey !== context.config.relay.self) {
      return { ok: false, prefix: "restricted", message: "group metadata must be signed by relay self pubkey" };
    }
    return { ok: true };
  }
  if ((event.kind >= 9000 && event.kind <= 9022) && !groupTag) {
    return { ok: false, prefix: "invalid", message: "group events require h tag" };
  }
  if ([9000, 9001].includes(event.kind)) {
    const p = event.tags.find((tag) => tag[0] === "p")?.[1];
    if (!p || !HEX_32_RE.test(p)) return { ok: false, prefix: "invalid", message: "group moderation event requires p pubkey tag" };
  }
  return { ok: true };
}

function authorizeGroupFilters(filters: NostrFilter[], context: PluginContext): ValidationResult {
  if (!context.config.requireAuthForRead) return { ok: true };
  const requestsPrivateGroupMetadata = filters.some((filter) => filter.kinds?.some((kind) => [39001, 39002, 39004].includes(kind)));
  if (!requestsPrivateGroupMetadata) return { ok: true };
  if (context.connection && context.connection.authenticatedPubkeys.size > 0) return { ok: true };
  return { ok: false, prefix: "auth-required", message: "private group metadata requires authentication" };
}
