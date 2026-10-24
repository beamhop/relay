import type { RelayContext } from "../context";
import { SOFTWARE, SUPPORTED_NIPS, VERSION } from "../constants";
import { MAX_SUB_ID_LENGTH } from "../protocol/messages";

/** NIP-11 relay information document built from runtime settings. */
export function buildNip11(ctx: RelayContext): Record<string, unknown> {
  const s = ctx.s();
  const { info, limits, access } = s;
  const doc: Record<string, unknown> = {
    name: info.name,
    description: info.description,
    supported_nips: [...SUPPORTED_NIPS],
    software: SOFTWARE,
    version: VERSION,
    self: ctx.key.pubkey,
    limitation: {
      max_message_length: limits.maxMessageBytes,
      max_subscriptions: limits.maxSubscriptions,
      max_filters: limits.maxFilters,
      max_limit: limits.maxLimit,
      default_limit: limits.defaultLimit,
      max_subid_length: MAX_SUB_ID_LENGTH,
      max_event_tags: limits.maxEventTags,
      max_content_length: limits.maxContentLength,
      min_pow_difficulty: limits.minPowDifficulty,
      // NIP-11: auth is required before *any* action, i.e. for both reading and writing
      auth_required: access.mode === "auth-required" || (access.authForRead && access.authForWrite),
      payment_required: false,
      restricted_writes: access.mode !== "public" || access.authForWrite,
      created_at_upper_limit: limits.createdAtUpperSec,
    },
  };
  // 0 disables the lower bound; advertising 0 would tell clients nothing in the past is accepted
  if (limits.createdAtLowerSec > 0) (doc.limitation as Record<string, unknown>).created_at_lower_limit = limits.createdAtLowerSec;
  if (info.pubkey) doc.pubkey = info.pubkey;
  if (info.contact) doc.contact = info.contact;
  if (info.icon) doc.icon = info.icon;
  if (info.banner) doc.banner = info.banner;
  if (info.postingPolicy) doc.posting_policy = info.postingPolicy;
  if (info.termsOfService) doc.terms_of_service = info.termsOfService;
  return doc;
}
