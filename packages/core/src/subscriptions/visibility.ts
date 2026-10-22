import type { ConnectionInfo, Filter, NostrEvent, ReadContext } from "@beamhop/sdk";
import type { RelayContext } from "../context";

/** Kinds only delivered to authenticated recipients (NIP-04 DMs, NIP-59 gift wraps). */
export const GATED_KINDS: ReadonlySet<number> = new Set([4, 1059]);

const EMPTY: ReadonlySet<string> = new Set();

/** NIP-04/17/59 privacy: gift wraps only to authed `p` recipients; kind 4 to author or recipients. */
export function canSeeGated(event: NostrEvent, authed: ReadonlySet<string>): boolean {
  if (!GATED_KINDS.has(event.kind)) return true;
  if (authed.size === 0) return false;
  if (event.kind === 4 && authed.has(event.pubkey)) return true;
  for (const t of event.tags) if (t[0] === "p" && t[1] !== undefined && authed.has(t[1])) return true;
  return false;
}

/** Filter can only ever match gated kinds. */
export function onlyGatedKinds(f: Filter): boolean {
  return !!f.kinds && f.kinds.length > 0 && f.kinds.every((k) => GATED_KINDS.has(k));
}

/** Filter may match gated kinds. */
export function mayMatchGated(f: Filter): boolean {
  return !f.kinds || f.kinds.some((k) => GATED_KINDS.has(k));
}

/** Full read-visibility check for an event towards a connection (stored results and live fan-out). */
export function isVisibleTo(ctx: RelayContext, event: NostrEvent, conn: ConnectionInfo | undefined, rctx: ReadContext): boolean {
  const authed = conn?.authedPubkeys ?? EMPTY;
  if (!canSeeGated(event, authed)) return false;
  if (!ctx.groups.canRead(event, authed)) return false;
  return ctx.hooks.isVisible(event, rctx);
}
