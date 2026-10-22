export const SOFTWARE = "https://github.com/beamhop/beamhop";
export const VERSION = "0.1.0";

/** NIPs advertised in NIP-11 `supported_nips`. */
export const SUPPORTED_NIPS: readonly number[] = [
  1, // basic protocol
  2, // follow lists (replaceable kind 3)
  4, // encrypted DMs (auth-gated delivery)
  5, // DNS identifiers (/.well-known/nostr.json)
  9, // event deletion
  10, // text notes & threads (tags passthrough)
  11, // relay information document
  13, // proof of work
  17, // private direct messages (gift-wrap gating)
  22, // comments
  28, // public chat
  29, // relay-based groups
  40, // expiration
  42, // authentication
  44, // encrypted payloads (opaque to relay)
  45, // COUNT
  50, // search
  51, // lists
  56, // reporting
  59, // gift wrap
  62, // request to vanish
  65, // relay list metadata
  70, // protected events
  77, // negentropy sync
  86, // relay management API (served by admin-api)
];
