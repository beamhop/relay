import type { NostrEvent, UserRecord } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { sameRelayUrl } from "../util/url";

export const KIND_DELETION = 5;
export const KIND_VANISH = 62;
export const KIND_REPORT = 1984;
export const KIND_AUTH = 22242;
export const VANISH_KV_NAMESPACE = "core-vanish";

export type SpecialDecision = { reject: string } | { before?: () => Promise<void>; after?: () => Promise<void> };

/** Special-kind handling between content policies and storage. */
export async function prepareSpecial(ctx: RelayContext, event: NostrEvent, user: UserRecord | undefined): Promise<SpecialDecision> {
  const group = await ctx.groups.handleWrite(event, {
    pubkey: event.pubkey,
    isRelayMember: ctx.users.isMember(event.pubkey, user),
    isStaff: ctx.users.isStaff(event.pubkey, user),
  });
  if (group && "reject" in group) return group;

  let own: SpecialDecision = {};
  switch (event.kind) {
    case KIND_DELETION:
      own = { before: () => applyDeletion(ctx, event) };
      break;
    case KIND_VANISH: {
      if (!vanishTargetsUs(ctx, event)) return { reject: "invalid: request to vanish is not addressed to this relay" };
      own = { before: () => applyVanish(ctx, event) };
      break;
    }
    case KIND_REPORT:
      own = {
        after: async () => {
          ctx.bus.emit("report.created", { event });
          await maybeAutoBan(ctx, event).catch((err) => ctx.logger.error("auto-ban check failed", { err: String(err) }));
        },
      };
      break;
  }
  if ("reject" in own) return own;
  return {
    before: async () => {
      await group?.before?.();
      await own.before?.();
    },
    after: async () => {
      await group?.after?.();
      await own.after?.();
    },
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

async function applyVanish(ctx: RelayContext, event: NostrEvent) {
  const pk = event.pubkey;
  const n = (await ctx.stores.events.deleteByPubkey(pk)) + (await ctx.stores.events.deleteByFilter([{ kinds: [1059], "#p": [pk] }]));
  const prev = ctx.vanished.get(pk) ?? 0;
  if (event.created_at > prev) {
    ctx.vanished.set(pk, event.created_at);
    await ctx.stores.kv.set(VANISH_KV_NAMESPACE, pk, event.created_at);
  }
  ctx.bus.emit("event.deleted", { ids: [], actor: pk, reason: `NIP-62 request to vanish (${n} events)` });
  ctx.logger.info("request to vanish processed", { pubkey: pk, deleted: n });
}

/** NIP-56: auto-ban a reported pubkey after N reports from distinct relay members. */
async function maybeAutoBan(ctx: RelayContext, report: NostrEvent) {
  const threshold = ctx.s().moderation.autoBanReportThreshold;
  if (!(threshold > 0)) return;
  const target = report.tags.find((t) => t[0] === "p" && t[1])?.[1];
  if (!target || target === ctx.key.pubkey) return;
  const rec = await ctx.users.get(target);
  if (rec?.status === "banned" || ctx.users.isStaff(target, rec)) return;
  const reports = await ctx.stores.events.query([{ kinds: [KIND_REPORT], "#p": [target], limit: 5000 }]);
  const reporters = new Set<string>();
  for (const r of reports) {
    if (reporters.has(r.pubkey)) continue;
    if (ctx.users.isMember(r.pubkey, await ctx.users.get(r.pubkey))) reporters.add(r.pubkey);
  }
  if (reporters.size < threshold) return;
  const user = await ctx.stores.users.upsert(target, { status: "banned", banReason: `auto-banned after ${reporters.size} reports` });
  ctx.users.invalidate(target);
  ctx.bus.emit("user.updated", { pubkey: target, user, actor: "system:auto-ban" });
  ctx.bus.emit("alert", { level: "warning", title: "User auto-banned", message: `${target} was banned after ${reporters.size} reports` });
}
