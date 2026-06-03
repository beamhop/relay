/**
 * NIP-09: Event deletion, and NIP-62: Request to vanish.
 *
 * NIP-09 (kind 5): the event lists targets to delete via `e` tags (event ids)
 * and `a` tags (addressable coordinates `kind:pubkey:d-tag`). A relay only
 * honors a deletion for events authored by the *same* pubkey as the deletion
 * request, and never deletes a more recent addressable replacement (only those
 * created at or before the deletion request). The kind-5 event itself is a
 * regular event and is stored and broadcast normally.
 *
 * NIP-62 (kind 62): "request to vanish" — the author asks the relay to erase
 * all of their events. The `relay` tags scope the request; this plugin honors
 * it when a tag names this relay's URL or the literal `ALL_RELAYS`. Events
 * created after the request are kept (the request only covers history up to its
 * own `created_at`).
 *
 * Deletion side effects run as an event validator so they apply to events that
 * arrive over EVENT *and* are persisted via any plugin; the validator never
 * rejects (returns ok) — it performs the deletions and lets storage proceed.
 */
import type { NostrPlugin, PluginContext } from "../plugin.ts";
import type { NostrEvent } from "../types.ts";
import { storageClass, dTag } from "../store/store.ts";

const KIND_DELETION = 5;
const KIND_VANISH = 62;

/** Parse an `a` tag value `kind:pubkey:dtag` into its parts. */
function parseAddr(value: string): { kind: number; pubkey: string; d: string } | undefined {
  const parts = value.split(":");
  if (parts.length < 2) return undefined;
  const kind = Number(parts[0]);
  if (!Number.isInteger(kind)) return undefined;
  const pubkey = parts[1]!;
  const d = parts.slice(2).join(":");
  return { kind, pubkey, d };
}

/** Apply a kind-5 deletion: remove same-author targets referenced by e/a tags. */
function applyDeletion(deletion: NostrEvent, ctx: PluginContext): void {
  for (const tag of deletion.tags) {
    const [name, value] = tag;
    if (value === undefined) continue;

    if (name === "e") {
      const target = ctx.store.getById(value);
      if (target && target.pubkey === deletion.pubkey) ctx.store.delete(value);
      continue;
    }

    if (name === "a") {
      const addr = parseAddr(value);
      // Only the author may delete their own coordinate.
      if (!addr || addr.pubkey !== deletion.pubkey) continue;
      // Find the current holder(s) of this coordinate and remove those at or
      // before the deletion's created_at (don't erase a newer replacement).
      const matches = ctx.store.query([
        { authors: [addr.pubkey], kinds: [addr.kind] },
      ]);
      for (const e of matches) {
        if (storageClass(e.kind) === "addressable" && dTag(e) !== addr.d) continue;
        if (e.created_at <= deletion.created_at) ctx.store.delete(e.id);
      }
    }
  }
}

/**
 * Whether a vanish request's `relay` tags target this relay. If there are no
 * `relay` tags at all, treat it as "all relays" (most permissive reading, so a
 * minimal client request still erases history).
 */
function vanishTargetsUs(vanish: NostrEvent, ctx: PluginContext): boolean {
  const relayTags = vanish.tags.filter((t) => t[0] === "relay" && t[1] !== undefined);
  if (relayTags.length === 0) return true;
  const self = ctx.config.url;
  return relayTags.some((t) => {
    const v = t[1]!;
    if (v === "ALL_RELAYS") return true;
    return self !== undefined && normalizeUrl(v) === normalizeUrl(self);
  });
}

/** Normalize a relay URL for comparison (lowercase, strip trailing slash). */
function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

export function nip09(): NostrPlugin {
  return {
    name: "nip09",
    supportedNips: [9, 62],

    eventValidators: [
      (event, ctx) => {
        if (event.kind === KIND_DELETION) {
          applyDeletion(event, ctx);
        } else if (event.kind === KIND_VANISH) {
          if (vanishTargetsUs(event, ctx)) {
            ctx.store.deleteByAuthor(event.pubkey, event.created_at);
          }
        }
        return { ok: true };
      },
    ],
  };
}

export { applyDeletion, vanishTargetsUs };
