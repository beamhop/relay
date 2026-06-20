export type NipId = string;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  search?: string;
  [key: string]: unknown;
}

export type ClientMessage =
  | ["EVENT", NostrEvent]
  | ["REQ", string, ...NostrFilter[]]
  | ["CLOSE", string]
  | ["COUNT", string, ...NostrFilter[]]
  | ["AUTH", NostrEvent]
  | ["NEG-OPEN", string, NostrFilter, string]
  | ["NEG-MSG", string, string]
  | ["NEG-CLOSE", string];

export type RelayMessage =
  | ["EVENT", string, NostrEvent]
  | ["OK", string, boolean, string]
  | ["EOSE", string]
  | ["EOSE", string, string[]]
  | ["CLOSED", string, string]
  | ["NOTICE", string]
  | ["COUNT", string, CountResult]
  | ["AUTH", string]
  | ["NEG-ERR", string, string]
  | ["NEG-ERR", string, string, number]
  | ["NEG-MSG", string, string];

export interface CountResult {
  count: number;
  approximate?: boolean;
  hll?: string;
}

export interface RelayLimits {
  maxMessageLength: number;
  maxSubscriptions: number;
  maxSubIdLength: number;
  maxLimit: number;
  defaultLimit: number;
  maxEventTags: number;
  maxContentLength: number;
  authEventMaxAgeSeconds: number;
  createdAtLowerLimit?: number;
  createdAtUpperLimit?: number;
}

export interface RelayMetadata {
  name: string;
  description: string;
  pubkey?: string;
  self?: string;
  contact?: string;
  banner?: string;
  icon?: string;
  software: string;
  version: string;
  terms_of_service?: string;
}

export interface RelayConfig {
  host: string;
  port: number;
  relayUrl?: string;
  persistence?: string;
  admin: RelayAdminConfig;
  disabledNips: Set<NipId>;
  relay: RelayMetadata;
  limits: RelayLimits;
  requireAuthForRead: boolean;
  requireAuthForWrite: boolean;
  acceptProtectedEvents: boolean;
  managementAdminPubkeys: Set<string>;
}

export interface RelayAdminConfig {
  web: boolean;
  password?: string;
}

export interface ConnectionState {
  id: string;
  challenge: string;
  authenticatedPubkeys: Set<string>;
  subscriptions: Map<string, SubscriptionState>;
  negentropySubscriptions: Map<string, NostrFilter>;
  remoteAddress?: string;
}

export interface SubscriptionState {
  id: string;
  filters: NostrFilter[];
}

export type ValidationResult =
  | { ok: true; message?: string }
  | { ok: false; prefix: string; message: string };

export interface QueryResult {
  events: NostrEvent[];
  complete: boolean;
}

export interface StoreResult {
  stored: boolean;
  duplicate: boolean;
  replacedIds: string[];
  deletedIds: string[];
  message: string;
}

export interface VanishRecord {
  pubkey: string;
  until: number;
}

export interface DeletedAddressRecord {
  address: string;
  pubkey: string;
  until: number;
}

export interface DeletedEventRecord {
  id: string;
  pubkey: string;
  deletedAt: number;
}
