/**
 * NIP-01: the core relay protocol.
 *
 * - Validates incoming events (structure + id + signature).
 * - EVENT: store + reply OK + broadcast.
 * - REQ: register subscription, send stored events then EOSE.
 * - CLOSE: drop a subscription.
 */
import type { Relay } from "../relay.ts";
import { verifyEvent } from "../event.ts";
import type { Connection } from "../connection.ts";
import type { NostrPlugin, PluginContext } from "../plugin.ts";
import { storageClass } from "../store/store.ts";
import type { ClientMessage, Filter, NostrEvent } from "../types.ts";

/**
 * @param relay the relay, used to run the full validator pipeline (so other
 *              plugins' validators also apply) when handling EVENT.
 */
export function nip01(relay: Relay): NostrPlugin {
  return {
    name: "nip01",
    supportedNips: [1],

    eventValidators: [
      (event) =>
        verifyEvent(event)
          ? { ok: true }
          : { ok: false, reason: "invalid: bad event id or signature" },
    ],

    messageHandlers: {
      EVENT: async (conn, msg, ctx) => {
        const event = msg[1] as NostrEvent;
        if (typeof event !== "object" || event === null || typeof event.id !== "string") {
          conn.send(["NOTICE", "invalid: EVENT must include an event object"]);
          return true;
        }

        if (ctx.store.getById(event.id)) {
          conn.send(["OK", event.id, true, "duplicate: already have this event"]);
          return true;
        }

        const verdict = await relay.validateEvent(event);
        if (!verdict.ok) {
          conn.send(["OK", event.id, false, verdict.reason ?? "invalid:"]);
          return true;
        }

        ctx.store.add(event);
        conn.send(["OK", event.id, true, ""]);
        // Broadcast stored and ephemeral events alike.
        ctx.broadcast(event);
        return true;
      },

      REQ: (conn, msg, ctx) => {
        const subId = msg[1];
        if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) {
          conn.send(["NOTICE", "invalid: REQ subscription id must be 1-64 chars"]);
          return true;
        }
        const filters = (msg as [string, string, ...Filter[]]).slice(2) as Filter[];

        const maxSubs = ctx.config.limitation?.max_subscriptions;
        const isNew = !conn.subscriptions.has(subId);
        if (maxSubs !== undefined && isNew && conn.subCount >= maxSubs) {
          conn.send(["CLOSED", subId, "rate-limited: too many subscriptions"]);
          return true;
        }

        conn.addSub(subId, filters);
        const stored = ctx.store.query(filters, ctx.config.limitation?.max_limit);
        for (const event of stored) {
          if (ctx.isVisible(event, conn)) conn.send(["EVENT", subId, event]);
        }
        conn.send(["EOSE", subId]);
        return true;
      },

      CLOSE: (conn, msg) => {
        const subId = msg[1];
        if (typeof subId === "string") conn.removeSub(subId);
        return true;
      },
    },
  };
}

// Re-export for convenience/testing.
export { storageClass };
export type { Connection, ClientMessage, PluginContext };
