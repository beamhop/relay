import { type NostrEvent, getTag, nowSec } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import type { Connection } from "../protocol/connection";
import { sameRelayUrl } from "../util/url";

export const AUTH_KIND = 22242;
/** NIP-42: created_at must be within ~10 minutes */
export const AUTH_WINDOW_SEC = 600;

/** Returns a rejection reason or undefined when the AUTH event is valid for this connection. */
export async function verifyAuthEvent(ctx: RelayContext, conn: Connection, event: NostrEvent): Promise<string | undefined> {
  if (event.kind !== AUTH_KIND) return `invalid: AUTH event must be kind ${AUTH_KIND}`;
  if (Math.abs(nowSec() - event.created_at) > AUTH_WINDOW_SEC) return "invalid: AUTH event created_at is too far from the current time";
  if (getTag(event, "challenge") !== conn.challenge) return "invalid: challenge does not match";
  const relay = getTag(event, "relay");
  if (!relay || !sameRelayUrl(relay, ctx.relayUrl)) return "invalid: relay tag does not match this relay";
  if (!ctx.verifier.verify(event)) return "invalid: bad event id or signature";
  const user = await ctx.users.get(event.pubkey);
  if (user?.status === "banned" || user?.denied) return "blocked: pubkey is banned";
  return undefined;
}
