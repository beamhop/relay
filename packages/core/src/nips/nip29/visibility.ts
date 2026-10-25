import { type NostrEvent, getDTag, getTag } from "@beamhop/sdk";
import { canInvite, GROUP_KIND } from "./kinds";
import type { GroupState } from "./repo";

// Read visibility of group events, over the in-memory group state (GroupsService keeps it and caches results).

export function anyMember(g: GroupState, authed: ReadonlySet<string>): boolean {
  for (const pk of authed) if (g.members.has(pk)) return true;
  return false;
}

/**
 * Read visibility: private group content, hidden group metadata and control events only for authed
 * members; invite codes (9009) only for the group's admins/moderators and the invite's author.
 */
export function canRead(groups: ReadonlyMap<string, GroupState>, relayPubkey: string, event: NostrEvent, authed: ReadonlySet<string>): boolean {
  if (event.kind === GROUP_KIND.CREATE_INVITE) return canReadInvite(groups, event, authed);
  if (groups.size === 0) return true;
  if (event.kind >= GROUP_KIND.METADATA && event.kind <= GROUP_KIND.ROLES && event.pubkey === relayPubkey) {
    const g = groups.get(getDTag(event));
    if (g && (g.deleting || (g.hidden && !anyMember(g, authed)))) return false;
  }
  const control = event.kind >= 9000 && event.kind <= 9022;
  for (const t of event.tags) {
    if (t[0] !== "h" || t[1] === undefined) continue;
    const g = groups.get(t[1]);
    if (!g) continue;
    if (g.deleting) return false;
    if ((g.private || (g.hidden && control)) && !anyMember(g, authed)) return false;
  }
  return true;
}

function canReadInvite(groups: ReadonlyMap<string, GroupState>, event: NostrEvent, authed: ReadonlySet<string>): boolean {
  if (authed.has(event.pubkey)) return true;
  const g = groups.get(getTag(event, "h") ?? "");
  if (!g || g.deleting) return false;
  for (const pk of authed) if (canInvite(g.members.get(pk))) return true;
  return false;
}

export function computeUnreadable(groups: ReadonlyMap<string, GroupState>, authed: ReadonlySet<string>): { privateIds: string[]; hiddenIds: string[] } {
  const privateIds: string[] = [];
  const hiddenIds: string[] = [];
  for (const g of groups.values()) {
    if (g.deleting) {
      privateIds.push(g.id);
      hiddenIds.push(g.id);
      continue;
    }
    if (!g.private && !g.hidden) continue;
    if (anyMember(g, authed)) continue;
    if (g.private) privateIds.push(g.id);
    if (g.hidden) hiddenIds.push(g.id);
  }
  return { privateIds, hiddenIds };
}

/** Whether the event belongs to a group whose existence or content isn't public (private, hidden, being deleted). */
export function inRestrictedGroup(groups: ReadonlyMap<string, GroupState>, event: NostrEvent): boolean {
  for (const t of event.tags) {
    if (t[0] !== "h" || t[1] === undefined) continue;
    const g = groups.get(t[1]);
    if (g && (g.private || g.hidden || g.deleting)) return true;
  }
  return false;
}
