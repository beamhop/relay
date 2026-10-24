import type { ConnectionInfo, Filter, NostrEvent, ReadContext } from "@beamhop/sdk";
import type { RelayContext } from "../context";
import { CONTROL_KINDS, GROUP_KIND } from "../nips/nip29/groups";

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

function narrow(vals: readonly (string | number)[] | undefined, allowed: readonly (string | number)[]): any[] | null {
  const out = vals ? allowed.filter((v) => vals.includes(v)) : [...allowed];
  return out.length ? out : null;
}

/**
 * Sub-filters of `f` covering every stored event that might be hidden from `authed`
 * (DMs / gift wraps, private group content, hidden group metadata and control events, group invite
 * codes). Used by COUNT and NEG-OPEN, which can't run per-event visibility checks over the full result set.
 */
export function restrictedSubFilters(ctx: RelayContext, f: Filter, authed: ReadonlySet<string>): Filter[] {
  const out: Filter[] = [];
  const gatedKinds = narrow(f.kinds, [...GATED_KINDS]);
  if (gatedKinds) out.push({ ...f, kinds: gatedKinds });
  const { privateIds, hiddenIds } = ctx.groups.unreadable(authed);
  const h = narrow(f["#h"], privateIds);
  if (h) out.push({ ...f, "#h": h });
  const metaKinds = narrow(f.kinds, [39000, 39001, 39002, 39003]);
  const metaAuthors = narrow(f.authors, [ctx.key.pubkey]);
  const d = narrow(f["#d"], hiddenIds);
  if (metaKinds && metaAuthors && d) out.push({ ...f, kinds: metaKinds, authors: metaAuthors, "#d": d });
  const controlKinds = narrow(f.kinds, CONTROL_KINDS);
  const hiddenH = narrow(f["#h"], hiddenIds);
  if (controlKinds && hiddenH) out.push({ ...f, kinds: controlKinds, "#h": hiddenH });
  // invite codes: visible to few readers, so every candidate is checked
  if (narrow(f.kinds, [GROUP_KIND.CREATE_INVITE])) out.push({ ...f, kinds: [GROUP_KIND.CREATE_INVITE] });
  return out;
}

/** Full read-visibility check for an event towards a connection (stored results and live fan-out). */
export function isVisibleTo(ctx: RelayContext, event: NostrEvent, conn: ConnectionInfo | undefined, rctx: ReadContext): boolean {
  const authed = conn?.authedPubkeys ?? EMPTY;
  if (!canSeeGated(event, authed)) return false;
  if (!ctx.groups.canRead(event, authed)) return false;
  return ctx.hooks.isVisible(event, rctx);
}
