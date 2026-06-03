/**
 * NIP-42: Authentication of clients to relays.
 *
 * On connect, the relay sends `["AUTH", <challenge>]`. The client replies with
 * `["AUTH", <signed-event>]` — a kind-22242 event carrying:
 *   - a `relay` tag naming this relay's URL, and
 *   - a `challenge` tag echoing the challenge the relay issued.
 *
 * The relay verifies the signature, the challenge match, the relay-URL match,
 * and that `created_at` is recent, then records the authenticated pubkey on the
 * connection (`conn.authedPubkey`). Other plugins (NIP-17) use that to gate
 * access to private events.
 *
 * AUTH is advertised and offered to every client, but on its own it grants no
 * extra access here — it exists so privacy-gated reads (NIP-17 gift wraps) can
 * identify the requester. Publishing remains open to everyone.
 */
import { verifyEvent } from "../event.ts";
import type { NostrPlugin, PluginContext } from "../plugin.ts";
import type { Connection } from "../connection.ts";
import type { NostrEvent } from "../types.ts";

const KIND_AUTH = 22242;
/** Max age (seconds) of an AUTH event relative to the relay clock. */
const MAX_AUTH_AGE = 600;

/** First value of the named tag, or undefined. */
function tagValue(event: NostrEvent, name: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === name && tag[1] !== undefined) return tag[1];
  }
  return undefined;
}

/** Normalize a relay URL for comparison (lowercase, strip trailing slash). */
function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

/** Outcome of validating a client AUTH event against a connection's challenge. */
export interface AuthResult {
  ok: boolean;
  reason: string;
}

/**
 * Validate a NIP-42 AUTH event for `conn`. Pure (no side effects) so it is
 * easy to test; the handler applies the result.
 */
export function validateAuth(
  event: NostrEvent,
  conn: Connection,
  ctx: PluginContext,
): AuthResult {
  if (event.kind !== KIND_AUTH) {
    return { ok: false, reason: "invalid: AUTH event must be kind 22242" };
  }
  if (!verifyEvent(event)) {
    return { ok: false, reason: "invalid: bad AUTH event signature" };
  }
  if (tagValue(event, "challenge") !== conn.challenge) {
    return { ok: false, reason: "invalid: AUTH challenge does not match" };
  }

  // The relay tag must name this relay, when a URL is configured.
  const relayTag = tagValue(event, "relay");
  const selfUrl = ctx.config.url;
  if (selfUrl !== undefined) {
    if (relayTag === undefined || normalizeUrl(relayTag) !== normalizeUrl(selfUrl)) {
      return { ok: false, reason: "invalid: AUTH relay tag does not match this relay" };
    }
  }

  const now = ctx.config.now ? ctx.config.now() : Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > MAX_AUTH_AGE) {
    return { ok: false, reason: "invalid: AUTH event is too old" };
  }

  return { ok: true, reason: "" };
}

export function nip42(): NostrPlugin {
  return {
    name: "nip42",
    supportedNips: [42],

    onConnect(conn) {
      // Issue (and send) this connection's challenge.
      conn.send(["AUTH", conn.challenge]);
    },

    messageHandlers: {
      AUTH: (conn, msg, ctx) => {
        const event = msg[1] as NostrEvent;
        if (typeof event !== "object" || event === null || typeof event.id !== "string") {
          conn.send(["NOTICE", "invalid: AUTH must include an event object"]);
          return true;
        }
        const result = validateAuth(event, conn, ctx);
        if (result.ok) {
          conn.authedPubkey = event.pubkey;
          conn.send(["OK", event.id, true, ""]);
        } else {
          conn.send(["OK", event.id, false, result.reason]);
        }
        return true;
      },
    },
  };
}
