/**
 * NIP-17: Private Direct Messages (with NIP-59 gift wrap, NIP-44 encryption).
 *
 * The relay's role is narrow — the client does all encryption and wrapping:
 *   - It receives and stores only the **kind-1059 gift wrap** (a regular event,
 *     handled by NIP-01 storage generics). The inner seal (kind 13) and chat
 *     rumor (kinds 14/15) are encrypted inside it and never seen in plaintext.
 *   - Gift wraps are signed by random throwaway keys and tagged with a single
 *     `p` tag = the recipient pubkey, queried via {"kinds":[1059],"#p":[…]}.
 *
 * To protect message metadata (NIP-17 "Relays"), a gift wrap is only *served*
 * to a connection that has authenticated (NIP-42) as the pubkey it is p-tagged
 * to. This is enforced as a visibility filter, so it covers both REQ replies
 * and live broadcast. Writes stay open — anyone may publish a gift wrap.
 *
 * Kind 10050 (DM relay list) is a public replaceable event handled generically;
 * NIP-17 is advertised so senders know this relay accepts their gift wraps.
 */
import type { NostrPlugin } from "../plugin.ts";
import type { NostrEvent } from "../types.ts";

const KIND_GIFT_WRAP = 1059;

/** The single recipient pubkey from a gift wrap's `p` tag, or undefined. */
export function giftWrapRecipient(event: NostrEvent): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === "p" && tag[1] !== undefined) return tag[1];
  }
  return undefined;
}

export function nip17(): NostrPlugin {
  return {
    name: "nip17",
    supportedNips: [17, 59],

    visibilityFilters: [
      (event, _ctx, conn) => {
        if (event.kind !== KIND_GIFT_WRAP) return true; // only gate gift wraps
        // Serve only to the AUTH'd recipient named in the `p` tag.
        const recipient = giftWrapRecipient(event);
        return recipient !== undefined && conn?.authedPubkey === recipient;
      },
    ],
  };
}
