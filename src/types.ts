/**
 * Core NOSTR protocol types (NIP-01).
 */

/** A signed NOSTR event. All hex fields are lowercase. */
export interface NostrEvent {
  /** 32-byte (64 hex char) sha256 of the serialized event. */
  id: string;
  /** 32-byte (64 hex char) schnorr public key of the author. */
  pubkey: string;
  /** Unix timestamp in seconds. */
  created_at: number;
  /** Event kind (0-65535). */
  kind: number;
  /** Array of tags; each tag is an array of strings, tag[0] is the tag name. */
  tags: string[][];
  /** Arbitrary content string. */
  content: string;
  /** 64-byte (128 hex char) schnorr signature over `id`. */
  sig: string;
}

/** An event before `id` and `sig` have been computed. */
export type UnsignedEvent = Omit<NostrEvent, "id" | "sig">;

/**
 * A subscription filter. Conditions within a filter are ANDed; multiple
 * filters in a REQ are ORed. Tag filters use the `#<single-letter>` form.
 */
export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tagFilter: `#${string}`]: string[] | number[] | string | number | undefined;
}

/** Client -> relay messages. */
export type ClientMessage =
  | ["EVENT", NostrEvent]
  | ["REQ", string, ...Filter[]]
  | ["COUNT", string, ...Filter[]]
  | ["CLOSE", string];

/** Relay -> client messages. */
export type RelayMessage =
  | ["EVENT", string, NostrEvent]
  | ["OK", string, boolean, string]
  | ["EOSE", string]
  | ["COUNT", string, { count: number }]
  | ["CLOSED", string, string]
  | ["NOTICE", string];

/** Storage behavior class derived from an event's kind (NIP-01). */
export type StorageClass = "regular" | "replaceable" | "ephemeral" | "addressable";
