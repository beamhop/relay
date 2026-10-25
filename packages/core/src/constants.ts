export const SOFTWARE = "https://github.com/beamhop/beamhop";
export const VERSION = "0.1.0";

/**
 * NIPs advertised in NIP-11 `supported_nips` (5, 29 and 86 only while NIP-05, groups and the admin API are enabled).
 * Per NIP-11, client-side NIPs (2, 10, 22, 28, 44, 51, 65 — which only need generic NIP-01 storage) are not advertised.
 */
export const SUPPORTED_NIPS: readonly number[] = [
  1, // basic protocol
  4, // encrypted DMs (auth-gated delivery)
  5, // DNS identifiers (/.well-known/nostr.json)
  9, // event deletion
  11, // relay information document
  13, // proof of work
  17, // private direct messages (gift-wrap gating)
  29, // relay-based groups
  40, // expiration
  42, // authentication
  45, // COUNT
  50, // search
  56, // reporting
  59, // gift wrap
  62, // request to vanish
  70, // protected events
  77, // negentropy sync
  86, // relay management API (served by admin-api)
];

/** OK / CLOSED / NOTICE reason for what arrives (or is still unanswered) while the relay shuts down */
export const SHUTTING_DOWN = "error: relay is shutting down";
