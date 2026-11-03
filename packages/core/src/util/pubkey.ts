import * as nip19 from "nostr-tools/nip19";

/** Lowercase hex for an operator-entered pubkey (hex in any case, or npub); undefined if it is neither. */
export function hexPubkey(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  if (t.startsWith("npub1")) {
    try {
      const d = nip19.decode(t);
      if (d.type === "npub") return d.data;
    } catch {
      /* invalid */
    }
  }
  return undefined;
}
