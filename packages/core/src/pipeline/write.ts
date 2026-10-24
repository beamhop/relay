import { Buffer } from "node:buffer";
import { type EventSource, type NostrEvent, type RejectCode, type UserRecord, type WriteContext, isEphemeral, nowSec } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { expirationOf } from "../nips/nip40";
import { GroupConflict } from "../nips/nip29/groups";
import { validateEventShape } from "../protocol/messages";
import type { Connection } from "../protocol/connection";
import { codeOf, withPrefix } from "../util/reasons";
import { checkAccess, checkProtected } from "./access";
import { checkPow } from "./pow";
import { KIND_AUTH, KIND_DELETION, KIND_VANISH, prepareSpecial, vanishTargetsUs } from "./special-kinds";

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
 * rate limit → plugin hooks → content policy → special kinds → store/ephemeral → fan-out → bus.
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
  // NIP-11 max_content_length counts unicode characters (code points), not UTF-16 units
  if (event.content.length > L.maxContentLength && codePoints(event.content) > L.maxContentLength) return reject(`invalid: content is too long (max ${L.maxContentLength})`, "too-large");

  // ---- id / signature
  if (!ctx.verifier.verify(event)) return reject("invalid: bad event id or signature");

  // ---- timestamps
  const now = nowSec();
  if (event.created_at > now + L.createdAtUpperSec) return reject("invalid: created_at is too far in the future");
  const external = source === "ws";
  if (external && L.createdAtLowerSec > 0 && event.created_at < now - L.createdAtLowerSec) return reject("invalid: created_at is too far in the past");
  const exp = expirationOf(event);
  if (exp !== undefined && exp <= now) return reject("invalid: event has expired");

  // NIP-62: a request to vanish addressed to us is honoured regardless of the user's status, access mode,
  // PoW or content policies ("MUST also follow the request to vanish regardless of the user's status").
  const vanish = event.kind === KIND_VANISH && vanishTargetsUs(ctx, event);
  // NIP-09: users can still delete their own events while banned or muted.
  const selfCleanup = vanish || event.kind === KIND_DELETION;

  // ---- NIP-13
  if (external && !vanish) {
    const pow = checkPow(event, L.minPowDifficulty);
    if (pow) return reject(pow);
  }

  // ---- bans / deny list / vanish / mute
  const user = await ctx.users.get(event.pubkey);
  if (user?.denied && !selfCleanup) return reject("blocked: pubkey is not allowed on this relay");
  if (user?.status === "banned" && !selfCleanup) return reject(`blocked: pubkey is banned${user.banReason ? ` (${user.banReason})` : ""}`);
  const vanishedAt = ctx.vanished.get(event.pubkey);
  if (vanishedAt !== undefined && event.kind !== KIND_VANISH && event.created_at <= vanishedAt) return reject("blocked: pubkey has requested to vanish from this relay");
  if (user?.status === "muted" && !selfCleanup) return shadow("pubkey muted");

  if (external && conn && !vanish) {
    // ---- access mode, NIP-70
    const denied = (await checkAccess(ctx, event, user, conn)) ?? checkProtected(event, conn);
    if (denied) return reject(denied);
    // ---- rate limit
    if (!rateOk(ctx, event, user, conn)) return reject("rate-limited: slow down, too many events");
  }

  // ---- plugin write hooks
  const wctx: WriteContext = { conn, source };
  const hook = vanish ? { event, result: "accept" as const, reason: undefined } : await ctx.hooks.runWrite(event, wctx);
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
  const special = await prepareSpecial(ctx, event, user);
  if ("reject" in special) return reject(special.reject);
  try {
    await special.before?.();
  } catch (err) {
    if (err instanceof GroupConflict) return reject(err.message);
    throw err;
  }

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
    ctx.stores.users.touch(event.pubkey, now).catch((err) => ctx.logger.warn("users.touch failed", { err: String(err) }));
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

function rateOk(ctx: RelayContext, event: NostrEvent, user: UserRecord | undefined, conn: Connection): boolean {
  if (ctx.users.isStaff(event.pubkey, user)) return true;
  const def = ctx.s().limits.eventsPerMinute;
  const override = user?.rateLimit?.eventsPerMinute;
  if (!ctx.rate.take(`ev:pk:${event.pubkey}`, override ?? def)) return false;
  if (override !== undefined) return true;
  return ctx.rate.take(`ev:ip:${conn.ip}`, def * IP_RATE_FACTOR);
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
