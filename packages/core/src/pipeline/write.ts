import { Buffer } from "node:buffer";
import { type EventSource, type NostrEvent, type RejectCode, type UserRecord, type WriteContext, isEphemeral, nowSec } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { expirationOf } from "../nips/nip40";
import { GroupConflict, GroupDuplicate } from "../nips/nip29/groups";
import { validateEventShape } from "../protocol/messages";
import type { Connection } from "../protocol/connection";
import { codeOf, withPrefix } from "../util/reasons";
import { checkAccess, checkProtected } from "./access";
import { checkPow } from "./pow";
import { KIND_AUTH, KIND_VANISH, prepareSpecial } from "./special-kinds";

export interface WriteOptions {
  conn?: Connection;
  source: EventSource;
  /** serialized size if already known (websocket message) */
  bytes?: number;
}

export interface WriteResult {
  ok: boolean;
  message: string;
  status?: "saved" | "replaced" | "ephemeral" | "duplicate" | "stale" | "shadow";
}

/** IP buckets are looser than pubkey buckets (NAT, many users behind one IP). */
const IP_RATE_FACTOR = 4;

/**
 * The event write pipeline (see docs/ARCHITECTURE.md):
 * size limits → id/sig → created_at → expiration → PoW → bans/mute/vanish → access mode → NIP-70 →
 * already stored (duplicate) → rate limit → plugin hooks → content policy → special kinds (deletion/vanish
 * before storing) → store/ephemeral → vanish re-check → NIP-29 state changes → fan-out → bus.
 */
export async function processEvent(ctx: RelayContext, input: NostrEvent, opts: WriteOptions): Promise<WriteResult> {
  try {
    return await run(ctx, input, opts);
  } catch (err) {
    ctx.logger.error("write pipeline failed", { id: input.id, err: String(err) });
    ctx.bus.emit("event.rejected", { event: input, code: "error", reason: "error: internal error", connId: opts.conn?.id, ip: opts.conn?.ip, pubkey: input.pubkey, source: opts.source });
    return { ok: false, message: "error: internal error" };
  }
}

async function run(ctx: RelayContext, input: NostrEvent, opts: WriteOptions): Promise<WriteResult> {
  const { conn, source } = opts;
  const s = ctx.s();
  const L = s.limits;
  let event = input;

  const reject = (reason: string, code?: RejectCode): WriteResult => {
    ctx.bus.emit("event.rejected", { event, code: code ?? codeOf(reason), reason, connId: conn?.id, ip: conn?.ip, pubkey: event.pubkey, source });
    return { ok: false, message: reason };
  };
  const shadow = (why: string): WriteResult => {
    ctx.bus.emit("event.rejected", { event, code: "blocked", reason: `shadow: ${why}`, connId: conn?.id, ip: conn?.ip, pubkey: event.pubkey, source });
    return { ok: true, message: "", status: "shadow" };
  };

  if (event.kind === KIND_AUTH) return reject("invalid: AUTH events must be sent in an AUTH message");

  // ---- size limits
  const bytes = opts.bytes ?? Buffer.byteLength(JSON.stringify(event));
  if (bytes > L.maxEventBytes) return reject(`invalid: event is too large (max ${L.maxEventBytes} bytes)`, "too-large");
  if (event.tags.length > L.maxEventTags) return reject(`invalid: too many tags (max ${L.maxEventTags})`, "too-large");
  if (event.content.length > L.maxContentLength) return reject(`invalid: content is too long (max ${L.maxContentLength})`, "too-large");

  // ---- id / signature
  if (!ctx.verifier.verify(event)) return reject("invalid: bad event id or signature");

  // ---- timestamps
  const now = nowSec();
  if (event.created_at > now + L.createdAtUpperSec) return reject("invalid: created_at is too far in the future");
  const external = source === "ws";
  if (external && L.createdAtLowerSec > 0 && event.created_at < now - L.createdAtLowerSec) return reject("invalid: created_at is too far in the past");
  const exp = expirationOf(event);
  if (exp !== undefined && exp <= now) return reject("invalid: event has expired");

  // ---- NIP-13
  if (external) {
    const pow = checkPow(event, L.minPowDifficulty);
    if (pow) return reject(pow);
  }

  // ---- bans / deny list / vanish / mute
  const user = await ctx.users.get(event.pubkey);
  if (user?.denied) return reject("blocked: pubkey is not allowed on this relay");
  if (user?.status === "banned") return reject(`blocked: pubkey is banned${user.banReason ? ` (${user.banReason})` : ""}`);
  const vanishedAt = ctx.vanished.get(event.pubkey);
  if (vanishedAt !== undefined && event.kind !== KIND_VANISH && event.created_at <= vanishedAt) return reject("blocked: pubkey has requested to vanish from this relay");
  if (user?.status === "muted") return shadow("pubkey muted");

  if (external && conn) {
    // ---- access mode, NIP-70
    const denied = (await checkAccess(ctx, event, user, conn)) ?? checkProtected(event, conn);
    if (denied) return reject(denied);
    // ---- replays of stored events change nothing: answered before anyone's rate limit is charged
    if (!isEphemeral(event.kind) && (await ctx.stores.events.getById(event.id))) {
      return { ok: true, message: "duplicate: already have this event", status: "duplicate" };
    }
    // ---- rate limit
    if (!rateOk(ctx, event, user, conn)) return reject("rate-limited: slow down, too many events");
  }

  // ---- plugin write hooks
  const wctx: WriteContext = { conn, source };
  const hook = await ctx.hooks.runWrite(event, wctx);
  if (hook.event !== event) {
    const v = validateEventShape(hook.event);
    if ("reason" in v || !ctx.verifier.verify(v.event)) return reject("error: plugin replaced the event with an invalid one");
    event = v.event;
  }
  if (hook.result === "reject") return reject(withPrefix(hook.reason, "blocked"));
  if (hook.result === "shadow") return shadow("plugin policy");

  // ---- built-in content policies
  let report: string | undefined;
  if (hook.result !== "accept") {
    const verdict = ctx.policy.evaluate(event);
    if (verdict.action === "reject") return reject(verdict.reason, "policy");
    if (verdict.action === "shadow") return shadow(verdict.reason);
    if (verdict.action === "report") report = verdict.reason;
  }

  // ---- special kinds (deletion, vanish, reports, NIP-29)
  const special = await prepareSpecial(ctx, event, user, { source, ipKey: conn?.ipKey });
  if ("reject" in special) return reject(special.reject);
  if ("duplicate" in special) return { ok: true, message: special.duplicate, status: "duplicate" };
  // Deletion / vanish must not be re-applied by replaying an already-stored event.
  if (special.before && !isEphemeral(event.kind) && (await ctx.stores.events.getById(event.id))) {
    return { ok: true, message: "duplicate: already have this event", status: "duplicate" };
  }
  await special.before?.();

  // ---- store
  let status: "saved" | "replaced" | "ephemeral";
  if (isEphemeral(event.kind)) status = "ephemeral";
  else {
    const res = await ctx.stores.events.save(event);
    switch (res.status) {
      case "saved":
      case "replaced":
        status = res.status;
        break;
      case "duplicate":
        return { ok: true, message: "duplicate: already have this event", status: "duplicate" };
      case "stale":
        return { ok: true, message: "duplicate: a newer version of this event exists", status: "stale" };
      case "deleted":
        return reject(res.message ? withPrefix(res.message, "blocked") : "blocked: this event has been deleted");
      default:
        return reject(withPrefix(res.message || "event refused by storage", "blocked"));
    }
    // NIP-62: a vanish request processed while this event was in flight (its marker is set before deleting)
    const vanished = ctx.vanished.get(event.pubkey);
    if (vanished !== undefined && event.kind !== KIND_VANISH && event.created_at <= vanished) {
      await ctx.stores.events.deleteByIds([event.id]);
      return reject("blocked: pubkey has requested to vanish from this relay");
    }
    ctx.stores.users.touch(event.pubkey, now).catch((err) => ctx.logger.warn("users.touch failed", { err: String(err) }));
  }

  // ---- state changes (NIP-29): only for events stored as new, so replays change nothing
  if (special.commit) {
    try {
      await special.commit();
    } catch (err) {
      // the state change didn't happen, so the event must not stay stored either: otherwise a retry would
      // be a "duplicate" that never applies it (and a replay of one removed by 9005 would linger)
      if (status !== "ephemeral") await ctx.stores.events.deleteByIds([event.id]);
      if (err instanceof GroupDuplicate) return { ok: true, message: err.message, status: "duplicate" };
      if (err instanceof GroupConflict) return reject(err.message);
      throw err;
    }
  }

  await special.after?.();
  const recipients = ctx.broadcast(event);
  ctx.bus.emit("event.broadcast", { event, recipients });
  ctx.bus.emit("event.accepted", { event, status, connId: conn?.id, ip: conn?.ip, source });
  if (report) {
    ctx.bus.emit("alert", {
      level: "warning",
      title: "Content flagged by word filter",
      message: `${report} matched event ${event.id} (kind ${event.kind}) by ${event.pubkey}`,
    });
  }
  return { ok: true, message: "", status };
}

/**
 * Per-author and per-address write buckets. Anyone can re-send an author's signed events, so the author's
 * own bucket is only charged on connections authenticated (NIP-42) as the author: nobody else can drain
 * it to get the author's events refused. Other submissions are charged per author and address, so
 * replays from elsewhere don't touch it either; a key used without AUTH from many addresses is then
 * limited per address (relays wanting one cap per key across addresses can require AUTH for writes).
 */
function rateOk(ctx: RelayContext, event: NostrEvent, user: UserRecord | undefined, conn: Connection): boolean {
  if (ctx.users.isStaff(event.pubkey, user)) return true;
  const def = ctx.s().limits.eventsPerMinute;
  const override = user?.rateLimit?.eventsPerMinute;
  const key = conn.authedPubkeys.has(event.pubkey) ? `ev:pk:${event.pubkey}` : `ev:pk:${event.pubkey}:${conn.ipKey}`;
  if (!ctx.rate.take(key, override ?? def)) return false;
  if (override !== undefined) return true;
  return ctx.rate.take(`ev:ip:${conn.ipKey}`, def * IP_RATE_FACTOR);
}
