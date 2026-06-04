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
 * To protect message metadata (NIP-17 "Relays"), a kind-1059 gift wrap is gated
 * behind NIP-42 AUTH and only served when one of these holds:
 *
 *   1. The connection is AUTH'd as the pubkey named in the gift wrap's `p` tag
 *      (the classic NIP-17 case: `p` = the recipient's real identity).
 *
 *   2. The connection is AUTH'd (as any identity) AND has an active subscription
 *      whose `#p` filter explicitly names the gift wrap's `p` tag. This supports
 *      clients (e.g. iris.to's double-ratchet) that p-tag the wrap to a *random,
 *      one-time ephemeral* key rather than the recipient identity: the recipient
 *      cannot AUTH as that throwaway key, but knowing its exact (unguessable)
 *      value — only learned from the recipient's own published invite — is itself
 *      evidence of authorization. AUTH is still required so the NIP-59 anti-spam
 *      property holds, and delivery is scoped to the subscriber's own `#p`.
 *
 * Enforced as a visibility filter so it covers both REQ replies and live
 * broadcast. Writes stay open — anyone may publish a gift wrap.
 *
 * Kind 10050 (DM relay list) is a public replaceable event handled generically;
 * NIP-17 is advertised so senders know this relay accepts their gift wraps.
 */
import type { NostrPlugin } from "../plugin.ts";
import type { Connection } from "../connection.ts";
import type { Filter, NostrEvent } from "../types.ts";

const KIND_GIFT_WRAP = 1059;

/** The single recipient pubkey from a gift wrap's `p` tag, or undefined. */
export function giftWrapRecipient(event: NostrEvent): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === "p" && tag[1] !== undefined) return tag[1];
  }
  return undefined;
}

/** Whether any of `filters` has a `#p` constraint that includes `pubkey`. */
function subscribesToPTag(filters: Filter[], pubkey: string): boolean {
  for (const filter of filters) {
    const values = filter["#p"];
    if (Array.isArray(values) && (values as unknown[]).includes(pubkey)) return true;
  }
  return false;
}

/** Whether `conn` has an active subscription explicitly p-tagging `pubkey`. */
function hasPTagSubscription(conn: Connection, pubkey: string): boolean {
  for (const filters of conn.subscriptions.values()) {
    if (subscribesToPTag(filters, pubkey)) return true;
  }
  return false;
}

export function nip17(): NostrPlugin {
  return {
    name: "nip17",
    supportedNips: [17, 59],

    visibilityFilters: [
      (event, _ctx, conn) => {
        if (event.kind !== KIND_GIFT_WRAP) return true; // only gate gift wraps
        const recipient = giftWrapRecipient(event);
        if (recipient === undefined || conn?.authedPubkey === undefined) return false;
        // (1) AUTH'd as the p-tagged identity, or (2) AUTH'd and explicitly
        // subscribed to this (ephemeral) p-tag — see the module comment.
        return conn.authedPubkey === recipient || hasPTagSubscription(conn, recipient);
      },
    ],
  };
}
