import type { EventSource } from "@beamhop/sdk";

export const GROUP_KIND = {
  PUT_USER: 9000,
  REMOVE_USER: 9001,
  EDIT_METADATA: 9002,
  DELETE_EVENT: 9005,
  CREATE_GROUP: 9007,
  DELETE_GROUP: 9008,
  CREATE_INVITE: 9009,
  JOIN_REQUEST: 9021,
  LEAVE_REQUEST: 9022,
  METADATA: 39000,
  ADMINS: 39001,
  MEMBERS: 39002,
  ROLES: 39003,
} as const;

export const METADATA_KINDS = [GROUP_KIND.METADATA, GROUP_KIND.ADMINS, GROUP_KIND.MEMBERS, GROUP_KIND.ROLES];
/** Group control kinds (moderation, join, leave). */
export const CONTROL_KINDS: readonly number[] = Array.from({ length: 23 }, (_, i) => 9000 + i);
export const GROUP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** How many recent group events `previous` tags may reference (NIP-29 suggests the last 50). */
export const PREVIOUS_WINDOW = 100;
/** `previous` references per event (NIP-29 clients send a few). */
export const MAX_PREVIOUS_REFS = 50;
/** Ids listed per window while looking up `previous` references (id-only rows, no event bodies). */
export const PREVIOUS_SCAN = 1_000;
/**
 * Group control events (9000-9022) from clients, sync and plugins must be recent: NIP-29 asks relays to
 * prevent late publication, and it stops old moderation/join/leave events from being replayed after
 * state changed (younger replays are caught by the applied-control record).
 */
export const GROUP_CONTROL_MAX_AGE_SEC = 10 * 60;
/** Sources whose group control events must be recent and may not carry relay-signed group metadata. */
export const UNTRUSTED_SOURCES: ReadonlySet<EventSource> = new Set(["ws", "sync", "plugin"]);
/** Invite codes are chosen by group moderators; very short ones are guessable. */
export const MIN_INVITE_CODE_LENGTH = 6;
/** Failed invite-code join attempts (closed groups), per group and per client address, per minute. */
export const INVITE_ATTEMPTS_PER_MINUTE = { group: 60, ip: 10 };
/**
 * Groups one pubkey (and one client address) may create per hour (staff exempt). Every group stays in memory and
 * makes the relay sign and store four metadata events, and read visibility checks scale with the number of groups.
 */
export const GROUP_CREATES_PER_HOUR = { pubkey: 10, ip: 40 };
/** Authed-pubkey sets whose unreadable() result is kept (until group state changes). */
export const UNREADABLE_CACHE_SIZE = 256;
/** `previous` may also reference any event stored on this relay within this many seconds (cheap bounded lookup). */
export const PREVIOUS_RECENT_SEC = 24 * 3600;
export const PREVIOUS_RECENT_LIMIT = 500;
/** NIP-29 late publication: group events older than this are rejected (relay-signed events are exempt). */
export const LATE_PUBLICATION_SEC = 3600;
/** Standard 39000 flags; a 9002 carries the full metadata set, so an absent flag means off. */
export const FLAG_TAGS = ["private", "closed", "restricted", "hidden"] as const;

export const DEFAULT_ROLES: Record<string, string> = {
  admin: "Full control over the group",
  moderator: "Can add and remove members, create invites and delete events",
};

export const ALL_MODERATION = [9000, 9001, 9002, 9005, 9007, 9008, 9009];
export const PERMISSIONS: Record<string, ReadonlySet<number>> = {
  admin: new Set(ALL_MODERATION),
  moderator: new Set([9000, 9001, 9005, 9009]),
};

export const isAdminRole = (roles: string[] | undefined) => !!roles?.includes("admin");
export const canInvite = (roles: string[] | undefined) => !!roles?.some((r) => PERMISSIONS[r]?.has(GROUP_KIND.CREATE_INVITE));
