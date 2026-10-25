import { nowSec } from "@beamhop/sdk";
import type { RelayContext } from "../../context";
import { FLAG_TAGS, GROUP_KIND, METADATA_KINDS } from "./kinds";
import type { GroupState } from "./repo";

/**
 * Applies a full NIP-29 metadata set (9007 / 9002): every field is taken from the tags, absent ones are
 * cleared (name falls back to the group id) and absent flags are off. The legacy non-standard
 * `public`/`open`/`unrestricted`/`visible` tags are still accepted — they just mean "off".
 */
export function applyMetadata(g: GroupState, tags: string[][]) {
  const tag = (name: string) => tags.find((t) => t[0] === name);
  const has = (name: string) => tags.some((t) => t[0] === name);
  g.name = tag("name")?.[1] || g.id;
  g.about = tag("about")?.[1] ?? "";
  g.picture = tag("picture")?.[1] ?? "";
  g.banner = tag("banner")?.[1] ?? "";
  for (const f of FLAG_TAGS) g[f] = has(f);
  const kinds = tag("supported_kinds");
  g.supportedKinds = kinds ? [...new Set(kinds.slice(1).map(Number).filter((n) => Number.isInteger(n) && n >= 0))] : undefined;
}

// ------------------------------------------------------------ relay-signed events

export async function relayPublish(ctx: RelayContext, template: { kind: number; created_at: number; content: string; tags: string[][] }) {
  const event = ctx.key.sign(template);
  const res = await ctx.stores.events.save(event);
  if (res.status === "saved" || res.status === "replaced") {
    ctx.broadcast(event);
    ctx.bus.emit("event.accepted", { event, status: res.status, source: "relay" });
  }
  return event;
}

/** (Re)generates relay-signed metadata events 39000-39003 for a group. */
export async function publishMetadata(ctx: RelayContext, g: GroupState, kinds: readonly number[]): Promise<void> {
  if (g.lastMetaAt === 0) {
    // after a restart: continue strictly after the stored 39000-39003 so replacements never tie
    const stored = await ctx.stores.events.query([{ kinds: METADATA_KINDS, authors: [ctx.key.pubkey], "#d": [g.id], limit: METADATA_KINDS.length }]);
    for (const ev of stored) g.lastMetaAt = Math.max(g.lastMetaAt, ev.created_at);
  }
  const created_at = Math.max(nowSec(), g.lastMetaAt + 1);
  g.lastMetaAt = created_at;
  for (const kind of kinds) {
    const tags: string[][] = [["d", g.id]];
    let content = "";
    if (kind === GROUP_KIND.METADATA) {
      tags.push(["name", g.name]);
      if (g.about) tags.push(["about", g.about]);
      if (g.picture) tags.push(["picture", g.picture]);
      if (g.banner) tags.push(["banner", g.banner]);
      for (const f of FLAG_TAGS) if (g[f]) tags.push([f]);
      if (g.supportedKinds) tags.push(["supported_kinds", ...g.supportedKinds.map(String)]);
    } else if (kind === GROUP_KIND.ADMINS) {
      content = `admins of ${g.id}`;
      for (const [pk, roles] of g.members) if (roles.length) tags.push(["p", pk, ...roles]);
    } else if (kind === GROUP_KIND.MEMBERS) {
      content = `members of ${g.id}`;
      for (const pk of g.members.keys()) tags.push(["p", pk]);
    } else if (kind === GROUP_KIND.ROLES) {
      content = `roles of ${g.id}`;
      for (const [name, desc] of g.roles) tags.push(["role", name, desc]);
    }
    await relayPublish(ctx, { kind, created_at, content, tags });
  }
}
