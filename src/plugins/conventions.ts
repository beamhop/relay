/**
 * Convention NIPs that impose no bespoke relay behavior beyond what NIP-01
 * already provides — they define event *kinds* and *tags* that the relay stores,
 * replaces, and serves generically. This plugin advertises them in the NIP-11
 * `supported_nips` list so clients know the relay handles them correctly:
 *
 *   NIP-02  Follow list           kind 3 (replaceable)
 *   NIP-03  OpenTimestamps        kind 1040 (regular)
 *   NIP-04  Encrypted DM          kind 4 (regular; content is client-encrypted)
 *   NIP-12  Generic tag queries   #<single-letter> filters (see filter.ts)
 *   NIP-14  Subject tag           `subject` tag on kind 1
 *   NIP-15  End of stored events  EOSE (emitted by nip01 on REQ)
 *   NIP-16  Event treatment       replaceable (10000-19999) / ephemeral (20000-29999)
 *   NIP-20  Command results       OK messages (emitted by nip01 on EVENT)
 *   NIP-25  Reactions             kind 7 (regular)
 *   NIP-28  Public chat           kinds 40-44
 *   NIP-33  Param. replaceable     addressable (30000-39999)
 *   NIP-44  Encrypted payloads    versioned content scheme (client-side)
 *   NIP-65  Relay list metadata   kind 10002 (replaceable)
 *
 * Storage-class handling for every kind above is provided by `storageClass`
 * (src/store/store.ts); generic tag querying by `matchFilter` (src/filter.ts).
 */
import type { NostrPlugin } from "../plugin.ts";

/** NIP numbers whose relay behavior is fully covered by NIP-01 generics. */
export const CONVENTION_NIPS = [2, 3, 4, 12, 14, 15, 16, 20, 25, 28, 33, 44, 65];

export function conventions(): NostrPlugin {
  return {
    name: "conventions",
    supportedNips: CONVENTION_NIPS,
  };
}
