// SPDX-License-Identifier: AGPL-3.0-or-later
/** NIP-11 relay information document. */
import type { EffectiveLimits, EventStoreCapabilities, RelayConfig } from '@beamhop/core';
import type { RelayModuleConfig } from './config.ts';

/**
 * Always-on NIPs: 01, 02 (follow lists stored), 09, 11, 13, 17 + 59 (gift wraps
 * only served to their AUTHed recipient), 40, 42, 45, 56 (reports surface in
 * moderation), 62, 65 (relay lists stored as replaceable), 70.
 */
export const BASE_NIPS = [1, 2, 9, 11, 13, 17, 40, 42, 45, 56, 59, 62, 65, 70] as const;

export function supportedNips(caps: EventStoreCapabilities, cfg: RelayModuleConfig): number[] {
  const out: number[] = [...BASE_NIPS];
  if (cfg.groups.enabled) out.push(29);
  if (caps.search) out.push(50);
  if (cfg.negentropy.enabled) out.push(77);
  return out.sort((a, b) => a - b);
}

export interface RelayInfoDocument {
  name: string;
  description: string;
  pubkey?: string;
  /** The relay's own pubkey (signs NIP-29 group state). */
  self?: string;
  contact?: string;
  icon?: string;
  banner?: string;
  supported_nips: number[];
  software: string;
  version: string;
  posting_policy?: string;
  limitation: {
    max_message_length: number;
    max_subscriptions: number;
    max_filters: number;
    max_limit: number;
    default_limit: number;
    max_content_length: number;
    min_pow_difficulty: number;
    auth_required: boolean;
    payment_required: boolean;
    restricted_writes: boolean;
    created_at_lower_limit?: number;
    created_at_upper_limit: number;
  };
}

export function relayInfo(
  relay: RelayConfig,
  limits: EffectiveLimits,
  caps: EventStoreCapabilities,
  cfg: RelayModuleConfig,
  self?: string,
): RelayInfoDocument {
  const info = relay.info;
  const doc: RelayInfoDocument = {
    name: info.name,
    description: info.description,
    supported_nips: supportedNips(caps, cfg),
    software: cfg.software,
    version: cfg.version,
    limitation: {
      max_message_length: cfg.maxMessageBytes,
      max_subscriptions: limits.maxSubscriptions,
      max_filters: limits.maxFilters,
      max_limit: limits.maxLimit,
      default_limit: limits.maxLimit,
      max_content_length: limits.maxEventBytes,
      min_pow_difficulty: limits.minPowDifficulty,
      auth_required: relay.access.authRequired.read || relay.access.authRequired.write,
      payment_required: false,
      restricted_writes: relay.access.mode !== 'open' || relay.access.authRequired.write,
      created_at_upper_limit: limits.maxCreatedAtFutureSeconds,
    },
  };
  if (limits.maxCreatedAtPastSeconds > 0)
    doc.limitation.created_at_lower_limit = limits.maxCreatedAtPastSeconds;
  if (info.pubkey) doc.pubkey = info.pubkey;
  if (self) doc.self = self;
  if (info.contact) doc.contact = info.contact;
  if (info.icon) doc.icon = info.icon;
  if (info.banner) doc.banner = info.banner;
  if (info.rules && /^https?:\/\//.test(info.rules)) doc.posting_policy = info.rules;
  return doc;
}

export const NIP11_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
