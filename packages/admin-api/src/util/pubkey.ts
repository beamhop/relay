import { nip19 } from "nostr-tools";
import { badRequest } from "../errors";

const HEX64 = /^[0-9a-f]{64}$/i;

/** Accepts hex, npub or nprofile; returns lowercase hex or undefined. */
export function tryParsePubkey(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  const s = input.trim();
  if (HEX64.test(s)) return s.toLowerCase();
  if (s.startsWith("npub1") || s.startsWith("nprofile1")) {
    try {
      const d = nip19.decode(s);
      if (d.type === "npub") return d.data;
      if (d.type === "nprofile") return d.data.pubkey;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parsePubkey(input: string | undefined | null): string {
  const pk = tryParsePubkey(input);
  if (!pk) throw badRequest("invalid pubkey (expected hex or npub)", "invalid_pubkey");
  return pk;
}

export function parseEventId(input: string | undefined | null): string {
  const s = (input ?? "").trim();
  if (HEX64.test(s)) return s.toLowerCase();
  if (s.startsWith("note1") || s.startsWith("nevent1")) {
    try {
      const d = nip19.decode(s);
      if (d.type === "note") return d.data;
      if (d.type === "nevent") return d.data.id;
    } catch {
      /* fallthrough */
    }
  }
  throw badRequest("invalid event id", "invalid_id");
}
