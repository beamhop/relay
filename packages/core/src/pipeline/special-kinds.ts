import type { EventSource, NostrEvent, UserRecord } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { isVisibleTo } from "../subscriptions/visibility";
import { isHex64 } from "../util/hex";
import { sameRelayUrl } from "../util/url";

export const KIND_DELETION = 5;
export const KIND_VANISH = 62;
const KIND_REPORT = 1984;
export const KIND_AUTH = 22242;
export const VANISH_KV_NAMESPACE = "core-vanish";
/**
 * Pubkeys with a lasting vanish marker (memory and kv). Beyond this, requests still delete but leave no marker.
 * Requests are rate-limited per address and only known pubkeys get one, so this is a backstop.
 */
export const MAX_VANISH_MARKERS = 100_000;
/** A request to vanish is only kept (and relayed) with at most this much content and this many tags. */
const VANISH_MAX_CONTENT = 1024;
const VANISH_MAX_TAGS = 64;

/** Returned by `before` when the effect was applied but the event itself must not be stored or relayed. */
export const NOT_STORED = "not-stored";

/**
 * - `before` runs before the event is stored (deletion, vanish: idempotent effects that must happen
 *   first); the pipeline skips it when the event is already stored. When it returns NOT_STORED the event
 *   is answered OK but neither stored nor relayed.
 * - `commit` runs only after the event was stored as new (NIP-29 state changes), so replaying a stored
 *   or deleted event changes nothing.
 * - `after` runs after commit (derived relay-signed events, notifications).
 */
export type SpecialDecision =
  | { reject: string }
  | { duplicate: string }
  | { before?: () => Promise<typeof NOT_STORED | void>; commit?: () => Promise<void>; after?: () => Promise<void> };

export interface SpecialOptions {
  source: EventSource;
  /** rate-limit key of the client address (events from a connection) */
  ipKey?: string;
  /** banned, deny-listed or muted author: deletions and vanish requests take effect, but aren't stored or relayed */
  quiet?: boolean;
}

/** Special-kind handling between content policies and storage. */
export async function prepareSpecial(ctx: RelayContext, event: NostrEvent, user: UserRecord | undefined, opts: SpecialOptions): Promise<SpecialDecision> {
  const group = await ctx.groups.handleWrite(event, {
    pubkey: event.pubkey,
    isRelayMember: ctx.users.isMember(event.pubkey, user),
    isStaff: ctx.users.isStaff(event.pubkey, user),
    source: opts.source,
    ipKey: opts.ipKey,
  });
  if (group && ("reject" in group || "duplicate" in group)) return group;

  let own: { before?: () => Promise<typeof NOT_STORED | void>; after?: () => Promise<void> } = {};
  switch (event.kind) {
    case KIND_DELETION:
      own = {
        before: async () => {
          await applyDeletion(ctx, event);
          return opts.quiet ? NOT_STORED : undefined;
        },
      };
      break;
    case KIND_VANISH: {
      if (!vanishTargetsUs(ctx, event)) return { reject: "invalid: request to vanish is not addressed to this relay" };
      own = {
        before: async () => {
          const r = await applyVanish(ctx, event);
          // the request itself is kept only when it took effect and carries no oversized or filtered payload:
          // it bypasses the access mode and content policies, so it mustn't become a way to publish anything
          return !opts.quiet && (r.deleted > 0 || r.marked) && storableVanish(ctx, event) ? undefined : NOT_STORED;
        },
      };
      break;
    }
    case KIND_REPORT:
      own = {
        after: async () => {
          ctx.bus.emit("report.created", { event });
          scheduleAutoBan(ctx, event); // off the OK path
        },
      };
      break;
  }
  const afters = [group?.after, own.after].filter((f): f is () => Promise<void> => !!f);
  return {
    // `before` is only set when there are side effects, so the pipeline can skip its replay check otherwise
    before: own.before,
    commit: group?.commit,
    after: afters.length ? async () => { for (const f of afters) await f(); } : undefined,
  };
}

async function applyDeletion(ctx: RelayContext, event: NostrEvent) {
  const n = await ctx.stores.events.applyDeletion(event);
  if (n > 0) {
    const ids = event.tags.filter((t) => (t[0] === "e" || t[0] === "a") && t[1]).map((t) => t[1]);
    ctx.bus.emit("event.deleted", { ids, actor: event.pubkey, reason: event.content || "NIP-09 deletion request" });
  }
}

/** NIP-62: relay tag must name this relay or ALL_RELAYS. */
export function vanishTargetsUs(ctx: RelayContext, event: NostrEvent): boolean {
  return event.tags.some((t) => t[0] === "relay" && t[1] !== undefined && (t[1] === "ALL_RELAYS" || sameRelayUrl(t[1], ctx.relayUrl)));
}

function storableVanish(ctx: RelayContext, event: NostrEvent): boolean {
  if (event.content.length > VANISH_MAX_CONTENT || event.tags.length > VANISH_MAX_TAGS) return false;
  const verdict = ctx.policy.evaluate(event);
  return verdict.action === "pass" || verdict.action === "report";
}

/**
 * NIP-62: deletes the pubkey's events (and gift wraps addressed to it) up to the request's created_at. Returns how
 * many events went and whether the pubkey's marker now covers the request (`marked`: set or raised by it).
 */
async function applyVanish(ctx: RelayContext, event: NostrEvent): Promise<{ deleted: number; marked: boolean }> {
  const pk = event.pubkey;
  const until = event.created_at;
  let marked = false;
  // Throwaway keys could otherwise grow the vanish list without bound: only pubkeys the relay knows
  // (a user record or stored events) get a lasting marker, up to MAX_VANISH_MARKERS of them.
  const known = !!(await ctx.users.get(pk)) || (await ctx.stores.events.query([{ authors: [pk], limit: 2 }])).some((e) => e.id !== event.id);
  if (known) {
    // marker first: a copy of an old event re-sent while the deletion runs is refused, or removed
    // again right after it is stored (see the post-save check in the write pipeline)
    const prev = ctx.vanished.get(pk);
    if (prev === undefined && ctx.vanished.size >= MAX_VANISH_MARKERS) {
      ctx.logger.warn("vanish marker limit reached: request honoured without a lasting marker", { pubkey: pk });
    } else if (until > (prev ?? 0)) {
      ctx.vanished.set(pk, until);
      await ctx.stores.kv.set(VANISH_KV_NAMESPACE, pk, until);
      marked = true;
    }
  }
  // everything from the pubkey up to the request, plus gift wraps addressed to it. The wraps are tombstoned
  // (they're signed by throwaway keys, so the author-based vanish check can't stop a re-broadcast).
  let n = await ctx.stores.events.deleteByPubkey(pk, until);
  for (;;) {
    const wraps = await ctx.stores.events.query([{ kinds: [1059], "#p": [pk], limit: 1000 }], { maxLimit: 1000 });
    if (!wraps.length) break;
    const removed = await ctx.stores.events.deleteByIds(wraps.map((w) => w.id), { tombstone: event.id });
    n += removed;
    if (removed === 0) break;
  }
  ctx.bus.emit("event.deleted", { ids: [], actor: pk, reason: `NIP-62 request to vanish (${n} events)` });
  ctx.logger.info("request to vanish processed", { pubkey: pk, deleted: n });
  return { deleted: n, marked };
}

/** kv namespace: reported pubkey → relay members whose reports against it were seen */
export const REPORTERS_KV_NAMESPACE = "core-reporters";
/** Recent reports against a pubkey scanned once, the first time a member reports it (older reports predate tracking). */
const SEED_SCAN = 2_000;
/** Member reporters remembered per reported pubkey. */
const MAX_TRACKED_REPORTERS = 1_000;

/** Auto-ban checks per relay, chained per reported pubkey so concurrent reports don't race. */
const autoBanChains = new WeakMap<RelayContext, Map<string, Promise<void>>>();

function scheduleAutoBan(ctx: RelayContext, report: NostrEvent): void {
  const target = report.tags.find((t) => t[0] === "p" && t[1])?.[1];
  if (!target || !isHex64(target) || !(ctx.s().moderation.autoBanReportThreshold > 0)) return;
  let chains = autoBanChains.get(ctx);
  if (!chains) autoBanChains.set(ctx, (chains = new Map()));
  const run = (chains.get(target) ?? Promise.resolve())
    .then(() => maybeAutoBan(ctx, report, target))
    .catch((err) => ctx.logger.error("auto-ban check failed", { err: String(err) }));
  chains.set(target, run);
  void run.then(() => {
    if (chains.get(target) === run) chains.delete(target);
  });
}

/**
 * NIP-56: auto-ban a reported pubkey after N reports from distinct relay members. Non-member reports
 * return right away. The members who reported a pubkey are tracked in kv (seeded once from its recent
 * reports), so each check costs one limit-1 query per tracked reporter (stopping at the threshold) instead of a scan of all
 * members or of all reports (which throwaway keys could flood).
 */
async function maybeAutoBan(ctx: RelayContext, report: NostrEvent, target: string) {
  const threshold = ctx.s().moderation.autoBanReportThreshold;
  // the relay's own reports (word-filter flags) are for the moderators, never votes towards a ban
  if (!(threshold > 0) || target === ctx.key.pubkey || report.pubkey === ctx.key.pubkey) return;
  const isMember = async (pk: string) => ctx.users.isMember(pk, await ctx.users.get(pk));
  if (!(await isMember(report.pubkey))) return; // non-member reports never count
  const rec = await ctx.users.get(target);
  if (rec?.status === "banned" || ctx.users.isStaff(target, rec)) {
    await ctx.stores.kv.delete(REPORTERS_KV_NAMESPACE, target);
    return;
  }

  const stored = await ctx.stores.kv.get<string[]>(REPORTERS_KV_NAMESPACE, target);
  const candidates = new Set<string>(Array.isArray(stored) ? stored : []);
  if (!Array.isArray(stored)) {
    for (const r of await ctx.stores.events.query([{ kinds: [KIND_REPORT], "#p": [target], limit: SEED_SCAN }], { maxLimit: SEED_SCAN })) {
      candidates.add(r.pubkey);
    }
  }
  candidates.delete(report.pubkey);
  candidates.delete(ctx.key.pubkey);

  // Each candidate is checked on its own (limit 1), so one member filing many reports can't push the
  // others out of a shared result window. Candidates left unchecked once the threshold is met stay tracked.
  const reporters = new Set<string>();
  const kept: string[] = [];
  for (const pk of [report.pubkey, ...candidates]) {
    if (reporters.size >= threshold) {
      kept.push(pk);
      continue;
    }
    if (!(await isMember(pk))) continue;
    const hit = await ctx.stores.events.query([{ kinds: [KIND_REPORT], "#p": [target], authors: [pk], limit: 1 }]);
    if (hit.length === 0) continue; // their reports were deleted
    reporters.add(pk);
    kept.push(pk);
  }
  if (reporters.size < threshold) {
    await ctx.stores.kv.set(REPORTERS_KV_NAMESPACE, target, kept.slice(0, MAX_TRACKED_REPORTERS));
    return;
  }
  await ctx.stores.kv.delete(REPORTERS_KV_NAMESPACE, target);
  const user = await ctx.stores.users.upsert(target, { status: "banned", banReason: `auto-banned after ${reporters.size} reports` });
  ctx.users.invalidate(target);
  ctx.bus.emit("user.updated", { pubkey: target, user, actor: "system:auto-ban" });
  // like a ban from the admin panel: authenticated sessions don't keep the pubkey's read access
  ctx.disconnect({ pubkey: target }, "blocked: pubkey is banned");
  ctx.bus.emit("alert", { level: "warning", title: "User auto-banned", message: `${target} was banned after ${reporters.size} reports` });
}

/**
 * Files a word-filter match ("report" action) in the moderators' report queue: a kind 1984 report signed by the relay
 * key, stored without being relayed (it never counts towards a NIP-56 auto-ban, see maybeAutoBan). Reports are
 * readable by anyone, so none is filed for an event not everyone may see (DMs, gift wraps, private or hidden group
 * content, anything a visibility hook hides): its id, author and kind would leak. A group event's report carries
 * its `h` tag and so follows the group's visibility if that changes later.
 */
export async function fileRelayReport(ctx: RelayContext, event: NostrEvent, reason: string): Promise<void> {
  if (ctx.groups.inRestrictedGroup(event) || !isVisibleTo(ctx, event, undefined, { source: "ws" })) return;
  const report = ctx.key.sign({
    kind: KIND_REPORT,
    created_at: Math.floor(Date.now() / 1000),
    content: `${reason} matched this event (kind ${event.kind})`,
    tags: [
      ["e", event.id, "other"],
      ["p", event.pubkey, "other"],
      ...event.tags.filter((t) => t[0] === "h" && t[1]).map((t) => ["h", t[1]]),
    ],
  });
  const res = await ctx.stores.events.save(report);
  if (res.status === "saved") ctx.bus.emit("report.created", { event: report });
}
