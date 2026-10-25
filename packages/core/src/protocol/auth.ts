import type { NostrEvent, UserRecord } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { verifyAuthEvent } from "../nips/nip42";
import type { Connection } from "./connection";
import { AUTH_PER_MINUTE, connBucket, MAX_AUTHED_PUBKEYS, MAX_INFLIGHT_EVENTS_TRUSTED, MESSAGES_PER_MINUTE } from "./limits";

// ------------------------------------------------------------------ AUTH (NIP-42)

export async function handleAuth(ctx: RelayContext, conn: Connection, event: NostrEvent): Promise<void> {
  if (!ctx.rate.take(connBucket("auth", conn.id), AUTH_PER_MINUTE)) return conn.ok(event.id, false, "rate-limited: too many AUTH messages");
  // every authed pubkey is consulted on each REQ (rate overrides, staff) and each delivery
  const full = () => !conn.authedPubkeys.has(event.pubkey) && conn.authedPubkeys.size >= MAX_AUTHED_PUBKEYS;
  const tooMany = `restricted: too many authenticated pubkeys on this connection (max ${MAX_AUTHED_PUBKEYS})`;
  if (full()) return conn.ok(event.id, false, tooMany);
  let reason: string | undefined;
  try {
    reason = await verifyAuthEvent(ctx, conn, event);
  } catch (err) {
    ctx.logger.warn("AUTH verification failed", { err: String(err) });
    return conn.ok(event.id, false, "error: could not verify authentication, try again");
  }
  if (reason) return conn.ok(event.id, false, reason);
  if (full()) return conn.ok(event.id, false, tooMany); // concurrent AUTHs
  const isNew = !conn.authedPubkeys.has(event.pubkey);
  conn.authedPubkeys.add(event.pubkey);
  conn.ok(event.id, true, "");
  if (isNew) ctx.bus.emit("connection.auth", { connId: conn.id, pubkey: event.pubkey, ip: conn.ip });
  // after the OK: a failing user lookup must not leave the client without an answer
  try {
    applyUserLimits(ctx, conn, event.pubkey, await ctx.users.get(event.pubkey));
  } catch (err) {
    ctx.logger.warn("user lookup after AUTH failed", { err: String(err) });
  }
}

/**
 * Inbound limits of a connection follow its most privileged authenticated user: staff are exempt from
 * the message limit, users with a rate-limit override get a matching per-connection limit (and no
 * per-address bucket), and both may have more EVENTs awaiting OK.
 */
function applyUserLimits(ctx: RelayContext, conn: Connection, pubkey: string, user: UserRecord | undefined): void {
  if (ctx.users.isStaff(pubkey, user)) {
    conn.trusted = true;
    conn.ownMessageLimit = true;
    conn.maxInflightEvents = Math.max(conn.maxInflightEvents, MAX_INFLIGHT_EVENTS_TRUSTED);
    return;
  }
  const o = user?.rateLimit;
  if (!o || (o.eventsPerMinute === undefined && o.reqPerMinute === undefined)) return;
  if (o.eventsPerMinute === 0 || o.reqPerMinute === 0) {
    // an override of 0 means "unlimited" in the rate limiter (bridges, importers): no message cap either
    conn.trusted = true;
    conn.ownMessageLimit = true;
    conn.maxInflightEvents = Math.max(conn.maxInflightEvents, MAX_INFLIGHT_EVENTS_TRUSTED);
    return;
  }
  const limit = MESSAGES_PER_MINUTE + (o.eventsPerMinute ?? 0) + (o.reqPerMinute ?? 0);
  if (limit > conn.messagesPerMinute) {
    conn.messagesPerMinute = limit;
    ctx.rate.delete(connBucket("msg", conn.id)); // restarts full at the new capacity
  }
  conn.ownMessageLimit = true;
  conn.maxInflightEvents = Math.max(conn.maxInflightEvents, MAX_INFLIGHT_EVENTS_TRUSTED);
}
