import { nip19 } from "nostr-tools";

const HEX64 = /^[0-9a-f]{64}$/i;
export const isHex64 = (s: string) => HEX64.test(s);

export function toNpub(hex: string): string {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

/** Accepts hex, npub, nprofile → hex pubkey (or undefined). */
export function parsePubkey(input: string): string | undefined {
  const s = input.trim().replace(/^nostr:/, "");
  if (isHex64(s)) return s.toLowerCase();
  try {
    const d = nip19.decode(s);
    if (d.type === "npub") return d.data;
    if (d.type === "nprofile") return d.data.pubkey;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Accepts hex, note, nevent → hex event id. */
export function parseEventId(input: string): string | undefined {
  const s = input.trim().replace(/^nostr:/, "");
  if (isHex64(s)) return s.toLowerCase();
  try {
    const d = nip19.decode(s);
    if (d.type === "note") return d.data;
    if (d.type === "nevent") return d.data.id;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function shortNpub(hex: string, n = 8): string {
  const npub = toNpub(hex);
  return npub.length > 2 * n + 5 ? `${npub.slice(0, n + 5)}…${npub.slice(-n)}` : npub;
}
export const shortHex = (hex: string, n = 8) => (hex.length > 2 * n ? `${hex.slice(0, n)}…${hex.slice(-n)}` : hex);

export function displayName(pubkey: string, profile?: { name?: string; display_name?: string }): string {
  return profile?.display_name?.trim() || profile?.name?.trim() || shortNpub(pubkey, 6);
}

/** deterministic hue from pubkey */
export function pubkeyHue(pubkey: string): number {
  let h = 0;
  for (let i = 0; i < Math.min(pubkey.length, 16); i++) h = (h * 31 + pubkey.charCodeAt(i)) % 360;
  return h;
}

const KIND_NAMES: Record<number, string> = {
  0: "Profile",
  1: "Note",
  2: "Relay rec.",
  3: "Follows",
  4: "Encrypted DM",
  5: "Deletion",
  6: "Repost",
  7: "Reaction",
  8: "Badge award",
  9: "Group chat",
  10: "Group reply",
  11: "Group thread",
  12: "Group thread reply",
  13: "Seal",
  14: "Chat message",
  16: "Generic repost",
  17: "Website reaction",
  20: "Picture",
  21: "Video",
  22: "Short video",
  40: "Channel create",
  41: "Channel meta",
  42: "Channel msg",
  62: "Vanish request",
  1018: "Poll response",
  1040: "OpenTimestamps",
  1059: "Gift wrap",
  1063: "File metadata",
  1068: "Poll",
  1111: "Comment",
  1311: "Live chat",
  1984: "Report",
  1985: "Label",
  4550: "Community approval",
  5000: "DVM request",
  6000: "DVM result",
  7000: "DVM feedback",
  9000: "Group add user",
  9001: "Group remove user",
  9002: "Group edit meta",
  9005: "Group delete event",
  9007: "Group create",
  9008: "Group delete",
  9009: "Group invite",
  9021: "Group join req",
  9022: "Group leave req",
  9041: "Zap goal",
  9734: "Zap request",
  9735: "Zap",
  9802: "Highlight",
  10000: "Mute list",
  10001: "Pin list",
  10002: "Relay list",
  10003: "Bookmarks",
  10006: "Blocked relays",
  10007: "Search relays",
  10009: "Group list",
  10015: "Interests",
  10030: "Emoji list",
  10050: "DM relays",
  10063: "Blossom servers",
  10096: "File servers",
  13194: "Wallet info",
  21000: "Lightning pub RPC",
  22242: "Client auth",
  23194: "Wallet request",
  23195: "Wallet response",
  24133: "Nostr Connect",
  24242: "Blossom auth",
  27235: "HTTP auth",
  30000: "Follow sets",
  30001: "Generic lists",
  30002: "Relay sets",
  30003: "Bookmark sets",
  30008: "Profile badges",
  30009: "Badge definition",
  30017: "Stall",
  30018: "Product",
  30023: "Long-form",
  30024: "Draft long-form",
  30078: "App data",
  30311: "Live event",
  30315: "User status",
  30402: "Classified",
  30617: "Repo announcement",
  31922: "Date event",
  31923: "Time event",
  31924: "Calendar",
  31989: "Handler rec.",
  31990: "Handler info",
  34235: "Video (addr.)",
  34550: "Community",
  39000: "Group metadata",
  39001: "Group admins",
  39002: "Group members",
  39003: "Group roles",
};

export function kindName(kind: number): string {
  if (KIND_NAMES[kind]) return KIND_NAMES[kind];
  if (kind >= 1000 && kind < 10000) return `Regular ${kind}`;
  if (kind >= 10000 && kind < 20000) return `Replaceable ${kind}`;
  if (kind >= 20000 && kind < 30000) return `Ephemeral ${kind}`;
  if (kind >= 30000 && kind < 40000) return `Addressable ${kind}`;
  return `Kind ${kind}`;
}

export const getTag = (tags: string[][], name: string) => tags.find((t) => t[0] === name)?.[1];
export const getTags = (tags: string[][], name: string) => tags.filter((t) => t[0] === name).map((t) => t[1]);
