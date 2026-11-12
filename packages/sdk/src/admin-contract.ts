/**
 * Admin REST API contract shared by @beamhop/admin-api (server) and @beamhop/admin-ui (client).
 * Base path: /admin/api. JSON in/out. Auth: httpOnly cookie `bh_session` OR `Authorization: Nostr <base64 NIP-98 event>`.
 * Errors: HTTP 4xx/5xx with body ApiError. Lists: { items } — paginated ones (documented as → Paged<T>) also carry `total`.
 * Live data: GET /admin/api/stream (Server-Sent Events) — see StreamEvents.
 */
import type { NostrEvent, Filter } from "./nostr";
import type { AdminRole, AuditEntry, Invite, IpRule, UserRecord, UserStatus, RateLimitOverride } from "./stores";
import type { RuntimeSettings, DeepPartial } from "./config";
import type { BlobRecord, BlobStatus, ConnectionSummary, GeoPoint, GroupSummary, LiveSnapshot, PluginInfo } from "./services";
import type { DatabaseStatus, DatabaseSwitchRequest } from "./db-switch";

export interface ApiError { error: string; code?: string }
export interface Paged<T> { items: T[]; total: number }

// ------------------------------------------------------------- permissions / RBAC
export const PERMISSIONS = [
  "dashboard.view", "connections.manage",
  "users.view", "users.edit", "users.ban", "users.delete",
  "invites.manage", "ip.manage",
  "content.view", "content.delete", "content.import", "content.export",
  "reports.view", "reports.resolve",
  "media.view", "media.moderate",
  "groups.view", "groups.manage",
  "settings.view", "settings.edit",
  "admins.manage",
  "plugins.view", "plugins.manage", "plugins.use",
  "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== "admins.manage"),
  moderator: [
    "dashboard.view", "users.view", "users.edit", "users.ban", "invites.manage", "content.view", "content.delete",
    "reports.view", "reports.resolve", "media.view", "media.moderate", "groups.view", "settings.view", "plugins.view", "plugins.use",
  ],
  viewer: ["dashboard.view", "users.view", "content.view", "reports.view", "media.view", "groups.view", "settings.view", "plugins.view"],
};

// ------------------------------------------------------------- auth   /auth/*
/** GET /auth/challenge — `url` is the exact `u` tag the signed login event must carry (always publicUrl-based) */
export interface ChallengeResponse { challenge: string; expiresAt: number; url: string }
/** POST /auth/nostr — body: a signed kind 27235 (NIP-98) event with tags u=<url from /auth/challenge>, method=POST, challenge=<challenge> */
export interface NostrLoginRequest { event: NostrEvent }
/** POST /auth/password — login is npub, hex pubkey or nip05 name */
export interface PasswordLoginRequest { login: string; password: string; totp?: string }
/**
 * Every mutating request that isn't NIP-98 authenticated (logins included) must send `X-Requested-With: beamhop` or an
 * Origin equal to the relay's public origin, and a body (if any) must be JSON (`application/json`, or NDJSON for
 * /events/import) — so another site can't submit forms to the API.
 */
/** POST /auth/passkey/login/options {login?} → PublicKeyCredentialRequestOptionsJSON; POST /auth/passkey/login/verify {response} */
export interface PasskeyLoginOptionsRequest { login?: string }
/** `response`: the WebAuthn credential JSON (AuthenticationResponseJSON / RegistrationResponseJSON) */
export interface PasskeyVerifyRequest { response: Record<string, unknown> }
/**
 * POST /auth/passkey/register/options {currentPassword?} → creation options; POST /auth/passkey/register/verify {response, name?};
 * DELETE /auth/passkey/:id {currentPassword?}. Adding or removing a factor needs a recent login, NIP-98 or `currentPassword`
 * (403 reauth_required).
 */
export interface ReauthRequest { currentPassword?: string }
export interface PasskeyRegisterVerifyRequest { response: Record<string, unknown>; name?: string }
/** POST /auth/password/set {password, currentPassword?}; POST /auth/logout */
export interface PasswordSetRequest { password: string; currentPassword?: string }
/**
 * TOTP: POST /auth/totp/setup {code?, currentPassword?} → TotpSetupResponse (`code`: one from the active authenticator
 * when replacing it); POST /auth/totp/enable {code}; POST /auth/totp/disable {code}
 */
export interface TotpSetupRequest { code?: string; currentPassword?: string }
export interface TotpSetupResponse { secret: string; uri: string }
export interface TotpCodeRequest { code: string }
/** GET /auth/me */
export interface Me {
  pubkey: string;
  role: AdminRole;
  permissions: Permission[];
  hasPassword: boolean;
  /** password logins also require a TOTP code (POST /auth/totp/setup → /auth/totp/enable; /auth/totp/disable {code}) */
  hasTotp: boolean;
  passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
  profile?: Profile;
}
export interface LoginResponse { me: Me }
/**
 * GET /auth/sessions → { items: SessionView[] }: your own panel sessions, newest first. DELETE /auth/sessions/:id ends one;
 * POST /auth/sessions/end-others ends all but the current one (all of them when called with NIP-98) → { ended }.
 */
export interface SessionView {
  /** the session's server-side id (a hash of its cookie, which it can't be turned back into) */
  id: string;
  method: "nostr" | "password" | "passkey" | "unknown";
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  /** the session this request was made with */
  current: boolean;
}

// ------------------------------------------------------------- shared views
export interface Profile { name?: string; display_name?: string; picture?: string; about?: string; nip05?: string; banner?: string; website?: string }
export interface UserView extends UserRecord { profile?: Profile }
export interface UserDetail extends UserView {
  stats: { eventCount: number; kinds: { kind: number; count: number }[]; blobCount: number; blobBytes: number; reportsAgainst: number; reportsFiled: number };
}

// ------------------------------------------------------------- system & dashboard
/** GET /system */
export interface SystemInfo {
  name: string; version: string; runtime: "bun" | "node"; runtimeVersion: string; uptimeSec: number;
  dbDialect: "sqlite" | "postgres"; nips: number[]; relayPubkey: string; publicUrl: string;
  blossomEnabled: boolean; geoipEnabled: boolean; otelEnabled: boolean; pushEnabled: boolean;
}
/**
 * Database switching (SQLite ⇄ Postgres at runtime; types in db-switch.ts). Every route answers 501
 * `db_switch_unavailable` when the server has no switcher.
 * - GET /database → DatabaseStatusResponse (settings.edit)
 * - POST /database/test {target} → DatabaseTestResult (owner)
 * - POST /database/switch DatabaseSwitchBody → 202 DatabaseSwitchJobView (owner + fresh login, NIP-98 or `currentPassword`: 403 reauth_required)
 * - GET /database/switch/:id → DatabaseSwitchJobView (settings.edit; poll it)
 * - POST /database/switch/:id/cancel → {cancelled: boolean} (owner; only before writes pause)
 * - DELETE /database/rollback/:id DatabaseRollbackDeleteBody → {ok: true} (owner + fresh login)
 * A postgres target's `postgresUrl` may be "env": the URL from the environment / config (the prefill is redacted).
 */
export interface DatabaseStatusResponse extends DatabaseStatus {
  /** suggested SQLite target: `beamhop.db` in the data directory, or a dated name when that one is taken */
  defaultSqlitePath: string;
  /** the caller may start a switch / delete rollback points (owner role) */
  canSwitch: boolean;
}
export interface DatabaseSwitchBody extends DatabaseSwitchRequest { currentPassword?: string }
export interface DatabaseRollbackDeleteBody { confirm: string; currentPassword?: string }
export { WIPE_CONFIRM_PHRASE, DELETE_ROLLBACK_CONFIRM_PHRASE } from "./db-switch";
export type { DatabaseStatus, DatabaseSwitchJobView, DatabaseSwitchPhase, DatabaseTarget, DatabaseTestResult, DatabaseSwitchRequest, TableProgress } from "./db-switch";
/** GET /dashboard/snapshot → LiveSnapshot */
export type DashboardSnapshot = LiveSnapshot;
/** GET /metrics/series?name=&from=&to=&step= */
export interface SeriesResponse { name: string; points: { t: number; v: number }[] }
/** GET /metrics/kinds?from&to → {items:{kind,count}[]}; /metrics/top-pubkeys?from&to&limit → {items: {pubkey,events,rejected,profile?}[]}
 *  /metrics/rejections?from&to → {items:{code,reason,count}[]};  /metrics/geo?from&to → {items: GeoPoint[]} */
export type GeoResponse = { items: GeoPoint[] };

/** GET /connections → {items: ConnectionSummary & {geo?}} ; DELETE /connections/:id ; POST /connections/disconnect {pubkey?|ip?} */
export type ConnectionView = ConnectionSummary & { geo?: { country: string; city?: string } };
export interface DisconnectRequest { pubkey?: string; ip?: string }
/** the time range of GET /metrics/* (unix seconds; default the last 24 h, step chosen from the range) */
export interface MetricsRangeQuery { from?: number; to?: number; step?: number }

// ------------------------------------------------------------- users
/** GET /users?search&status&role&tag&allowed&sort&limit&offset → Paged<UserView> */
export interface UserListQuery { search?: string; status?: UserStatus; role?: AdminRole; tag?: string; allowed?: boolean; sort?: "lastSeen" | "firstSeen" | "eventCount"; limit?: number; offset?: number }
/** GET /users/:pubkey → UserDetail (pubkey may be hex or npub) */
/** PATCH /users/:pubkey */
export interface UserPatch { notes?: string; tags?: string[]; rateLimit?: RateLimitOverride | null; blossomQuota?: number | null; nip05Name?: string | null; allowed?: boolean; denied?: boolean }
/** POST /users/:pubkey/ban */
export interface BanRequest { reason?: string; deleteEvents?: boolean; deleteMedia?: boolean; disconnect?: boolean }
/** DELETE /users/:pubkey  (users.delete) — removes the record, events and media; not a ban → DeleteUserResult */
export interface DeleteUserResult { deletedEvents: number; deletedMedia: number; disconnected: number }
/** POST /users/:pubkey/unban ; POST /users/:pubkey/mute ; POST /users/:pubkey/unmute */
/** PUT /users/:pubkey/role (admins.manage). Removing a role ends the admin's sessions and drops their push devices and login
 *  factors (password, TOTP, passkeys). Deleting a user who has a role also needs admins.manage. */
export interface RoleRequest { role: AdminRole | null }
/** POST /users/bulk */
export interface BulkUserRequest {
  pubkeys: string[];
  action: "ban" | "unban" | "mute" | "unmute" | "allow" | "disallow" | "deny" | "undeny" | "delete-events" | "delete" | "add-tag" | "remove-tag";
  reason?: string;
  tag?: string;
}
export interface BulkResult {
  ok: number;
  failed: { pubkey: string; error: string }[];
  /**
   * Present only when the action stopped early (its time budget ran out, or the client went away): the inputs not
   * reached, to which nothing was done — resend them
   */
  remaining?: string[];
}
/** GET /users/:pubkey/events?limit&until&kinds=1,7 → {items: NostrEvent[]} */
export interface UserEventsQuery { limit?: number; until?: number; /** comma-separated */ kinds?: string }
/** POST /users  {pubkey, allowed?, notes?, tags?} — add user manually (e.g. allowlist) → UserView */
export interface AddUserRequest { pubkey: string; allowed?: boolean; notes?: string; tags?: string[] }

/** GET /admins → {items: UserView[]} users with a role */

// ------------------------------------------------------------- invites & ip rules
/** GET /invites → {items: InviteView[]}; POST /invites {maxUses?, expiresAt?, note?, count?} → {items: InviteView[]}; DELETE /invites/:code */
export type InviteView = Invite & { url: string };
export interface InviteCreateRequest { maxUses?: number; expiresAt?: number | null; note?: string; count?: number }
/**
 * GET /ip-rules → {items: IpRule[]}; POST /ip-rules IpRuleInput; DELETE /ip-rules/:cidr (url-encoded).
 * An allow rule exempts matching addresses from per-IP limits and overrides block rules; one wider than an IPv4 /16
 * or IPv6 /48 is refused (400 `broad_allow_rule`) unless `confirmBroad: true` is sent.
 */
export type IpRuleInput = Omit<IpRule, "createdAt"> & { confirmBroad?: boolean };

// ------------------------------------------------------------- content
/** POST /events/query */
export interface EventQueryRequest { filters: Filter[]; limit?: number }
export interface EventQueryResponse { items: EventView[] }
export interface EventView { event: NostrEvent; author?: Profile; reports: number }
/** GET /events/:id → EventView ; DELETE /events/:id {reason?} → {deleted} */
export interface EventDeleteOneRequest { reason?: string }
/** POST /events/delete */
export interface EventDeleteRequest { ids?: string[]; filters?: Filter[]; reason?: string }
/** POST /events/import  body: JSONL (one event per line), ?bypassPolicies=true → ImportResult */
export interface ImportResult { imported: number; duplicates: number; rejected: number; errors: string[] }
/** GET /events/export?filters=<urlencoded json Filter[]> → application/x-ndjson stream */
/**
 * GET /events/bans?limit → EventBanListResponse (content.view): event ids refused on write (NIP-86 banevent), newest
 * first. DELETE /events/bans/:id {reason?} → {ok: true} (content.delete; 404 without a ban): lifts the write block only,
 * the deleted event is not restored. A ban placed by a higher role can't be lifted (403 forbidden_target).
 */
export interface EventBanView {
  id: string;
  reason: string;
  /** pubkey that placed the ban */
  by: string;
  at: number;
  /** role it was placed with (null: recorded before roles were) */
  byRole: AdminRole | null;
}
export interface EventBanListQuery { limit?: number }
export interface EventBanListResponse { items: EventBanView[] }
export interface EventBanLiftRequest { reason?: string }

// ------------------------------------------------------------- reports (NIP-56 kind 1984)
export type ReportStatus = "open" | "resolved" | "dismissed";
export interface ReportView {
  id: string; // report event id
  report: NostrEvent;
  reporter: string;
  reporterProfile?: Profile;
  /** who bans apply to: the stored target event's author (or blob uploader), else the report's `p` tag */
  targetPubkey: string;
  targetProfile?: Profile;
  /** the report's `p` tag when it names someone other than targetPubkey */
  claimedPubkey?: string;
  claimedProfile?: Profile;
  targetEventId?: string;
  targetEvent?: NostrEvent;
  targetBlob?: string;
  type: string; // nudity|malware|profanity|illegal|spam|impersonation|other
  status: ReportStatus;
  resolution?: { action: string; by: string; at: number; note?: string };
  /** count of open reports against same target */
  relatedCount: number;
}
/** GET /reports?status&type&target&limit&offset → Paged<ReportView>; a pubkey `target` matches ReportView.targetPubkey (the content's author), not the report's `p` tag */
export interface ReportListQuery { status?: ReportStatus; type?: string; target?: string; limit?: number; offset?: number }
/** POST /reports/:id/resolve */
export interface ResolveReportRequest { action: "dismiss" | "delete-event" | "ban-user" | "delete-and-ban" | "delete-media"; note?: string }
/** POST /reports/bulk-resolve {ids: string[], action, note?} → ReportBulkResult */
export interface ReportBulkResolveRequest { ids: string[]; action: ResolveReportRequest["action"]; note?: string }
export interface ReportBulkResult { ok: number; failed: { id: string; error: string }[] }

// ------------------------------------------------------------- media (blossom)
/** GET /media?pubkey&status&type&limit&offset → Paged<BlobRecord> ; GET /media/stats */
export interface MediaStats { count: number; bytes: number; byType: { type: string; count: number; bytes: number }[]; pending: number }
/**
 * POST /media/:sha256/status {status: BlobStatus} ; DELETE /media/:sha256?block=true ; POST /media/bulk {sha256s, action:"approve"|"block"|"delete"} → MediaBulkResult.
 * Below owner, deleting, blocking or hiding (status pending/blocked) a blob uploaded by a peer or superior is refused (403 forbidden_target).
 */
export type MediaStatusRequest = { status: BlobStatus };
export interface MediaBulkResult { ok: number; failed: { sha256: string; error: string }[] }
export type MediaItem = BlobRecord;

// ------------------------------------------------------------- settings
/** GET /settings → SettingsResponse ; PATCH /settings DeepPartial<RuntimeSettings> → SettingsResponse */
export interface SettingsResponse { settings: RuntimeSettings }
export type SettingsPatch = DeepPartial<RuntimeSettings>;

// ------------------------------------------------------------- groups (NIP-29)
/** GET /groups → {items: GroupSummary[]}; GET /groups/:id ; DELETE /groups/:id */
export type GroupView = GroupSummary;

// ------------------------------------------------------------- plugins
/** GET /plugins → {items: PluginInfo[]}; POST /plugins/:name/enable ; POST /plugins/:name/disable
 *  GET /plugins/:name/settings → {values, schema}; PATCH /plugins/:name/settings {values}
 *  ANY /plugins/x/:name/*  → plugin admin routes */
export type PluginView = PluginInfo;

// ------------------------------------------------------------- audit
/** GET /audit?actor&action&target&before&limit → {items: AuditEntry[]} (`before`: an entry id cursor) */
export type AuditView = AuditEntry;
export interface AuditListQuery { actor?: string; action?: string; target?: string; before?: number; limit?: number }

// ------------------------------------------------------------- push notifications
/** GET /push/vapid → {publicKey: string | null}; POST /push/subscribe {subscription: PushSubscriptionJSON, topics?: PushTopic[]}; POST /push/unsubscribe {endpoint} */
export type PushTopic = "reports" | "alerts";
/** `subscription`: PushSubscription.toJSON(); `topics` default: all the admin's permissions allow */
export interface PushSubscribeRequest {
  subscription: { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
  topics?: PushTopic[];
}
export interface PushUnsubscribeRequest { endpoint: string }
/** "reports" pushes are coalesced: at most one per minute per device, the reports filed meanwhile arrive as one digest. */

// ------------------------------------------------------------- SSE  GET /stream?events=1&kinds=1,7
/** Server-sent event names and payloads */
export interface StreamEvents {
  snapshot: LiveSnapshot; // every 2s
  event: { event: NostrEvent; status: "accepted" | "rejected"; reason?: string; ip?: string; country?: string }; // only if ?events=1
  alert: { level: "info" | "warning" | "critical"; title: string; message: string; url?: string };
  report: ReportView; // relatedCount is not computed here (0): GET /reports has it
}

export type { AdminRole, AuditEntry, BlobRecord, BlobStatus, ConnectionSummary, GeoPoint, GroupSummary, Invite, IpRule, LiveSnapshot, PluginInfo, UserRecord, UserStatus, RuntimeSettings, DeepPartial, NostrEvent, Filter };
