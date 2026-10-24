import type { NostrEvent, UserRecord } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import type { Connection } from "../protocol/connection";
import { GIFT_WRAP_KINDS } from "../subscriptions/visibility";

const MAX_P_TAGS_CHECKED = 20;

/** Access mode check (public / whitelist / invite / auth-required) for events received over websocket. */
export async function checkAccess(ctx: RelayContext, event: NostrEvent, user: UserRecord | undefined, conn: Connection): Promise<string | undefined> {
  const { access } = ctx.s();
  const authed = conn.authedPubkeys;
  if (access.authForWrite && authed.size === 0) return "auth-required: authentication is required to publish to this relay";

  switch (access.mode) {
    case "public":
      return undefined;
    case "auth-required":
      if (authed.size === 0) return "auth-required: authentication is required to publish to this relay";
      if (authed.has(event.pubkey)) return undefined;
      if (GIFT_WRAP_KINDS.has(event.kind)) return undefined; // gift wraps are signed by throwaway keys
      return "restricted: event author must match the authenticated pubkey";
    case "whitelist":
    case "invite": {
      if (ctx.users.isMember(event.pubkey, user)) return undefined;
      if (access.allowInboundToMembers && (await pTagsAMember(ctx, event))) return undefined;
      return access.mode === "invite"
        ? "restricted: this relay is invite-only; redeem an invite code first"
        : "restricted: you are not a member of this relay";
    }
  }
}

async function pTagsAMember(ctx: RelayContext, event: NostrEvent): Promise<boolean> {
  const seen = new Set<string>();
  for (const t of event.tags) {
    if (t[0] !== "p" || !t[1] || seen.has(t[1])) continue;
    seen.add(t[1]);
    if (seen.size > MAX_P_TAGS_CHECKED) break;
    const rec = await ctx.users.get(t[1]);
    if (ctx.users.isMember(t[1], rec) && rec?.status !== "banned") return true;
  }
  return false;
}

/** NIP-70: protected events (`["-"]` tag) may only be published by their authenticated author. */
export function checkProtected(event: NostrEvent, conn: Connection): string | undefined {
  if (embedsProtected(event)) return "blocked: reposts may not embed a protected event";
  if (!event.tags.some((t) => t[0] === "-")) return undefined;
  if (conn.authedPubkeys.has(event.pubkey)) return undefined;
  if (conn.authedPubkeys.size === 0) return "auth-required: this event may only be published by its author";
  return "restricted: this event may only be published by its author";
}

/** NIP-70: "If a repost of a protected event embeds the event anyway, relays SHOULD summarily reject it." */
function embedsProtected(event: NostrEvent): boolean {
  if ((event.kind !== 6 && event.kind !== 16) || !event.content.startsWith("{")) return false;
  try {
    const inner = JSON.parse(event.content) as { tags?: unknown };
    return Array.isArray(inner.tags) && inner.tags.some((t) => Array.isArray(t) && t[0] === "-");
  } catch {
    return false;
  }
}
