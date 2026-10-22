/**
 * Admin REST API contract shared by @beamhop/admin-api (server) and @beamhop/admin-ui (client).
 * Base path: /admin/api. JSON in/out. Auth: httpOnly cookie `bh_session` OR `Authorization: Nostr <base64 NIP-98 event>`.
 * Errors: HTTP 4xx/5xx with body ApiError. Lists: { items, total }.
 * Live data: GET /admin/api/stream (Server-Sent Events) — see StreamEvents.
 */
import type { NostrEvent, Filter } from "./nostr";
import type { AdminRole, AuditEntry, Invite, IpRule, UserRecord, UserStatus, RateLimitOverride } from "./stores";
import type { RuntimeSettings, DeepPartial } from "./config";
import type { BlobRecord, BlobStatus, ConnectionSummary, GeoPoint, GroupSummary, LiveSnapshot, PluginInfo } from "./services";

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
/** GET /auth/challenge */
export interface ChallengeResponse { challenge: string; expiresAt: number }
/** POST /auth/nostr — body: signed kind 27235 (NIP-98) event with tags u=<publicUrl>/admin/api/auth/nostr, method=POST, challenge=<challenge>. */
export interface NostrLoginRequest { event: NostrEvent }
/** POST /auth/password — login is npub, hex pubkey or nip05 name */
export interface PasswordLoginRequest { login: string; password: string; totp?: string }
/** POST /auth/passkey/login/options {login?} → PublicKeyCredentialRequestOptionsJSON; POST /auth/passkey/login/verify {response} */
/** POST /auth/passkey/register/options → creation options; POST /auth/passkey/register/verify {response, name}; DELETE /auth/passkey/:id */
/** POST /auth/password/set {password, currentPassword?}; POST /auth/logout */
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

// ------------------------------------------------------------- shared views
export interface Profile { name?: string; display_name?: string; picture?: string; about?: string; nip05?: string; banner?: string; lud16?: string; website?: string }
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
/** GET /dashboard/snapshot → LiveSnapshot */
export type DashboardSnapshot = LiveSnapshot;
/** GET /metrics/series?name=&from=&to=&step= */
export interface SeriesResponse { name: string; points: { t: number; v: number }[] }
/** GET /metrics/kinds?from&to → {items:{kind,count}[]}; /metrics/top-pubkeys?from&to&limit → {items: {pubkey,events,rejected,profile?}[]}
 *  /metrics/rejections?from&to → {items:{code,reason,count}[]};  /metrics/geo?from&to → {items: GeoPoint[]} */
export type GeoResponse = { items: GeoPoint[] };

/** GET /connections → {items: ConnectionSummary & {geo?}} ; DELETE /connections/:id ; POST /connections/disconnect {pubkey?|ip?} */
export type ConnectionView = ConnectionSummary & { geo?: { country: string; city?: string } };

// ------------------------------------------------------------- users
/** GET /users?search&status&role&tag&allowed&sort&limit&offset → Paged<UserView> */
export interface UserListQuery { search?: string; status?: UserStatus; role?: AdminRole; tag?: string; allowed?: boolean; sort?: "lastSeen" | "firstSeen" | "eventCount"; limit?: number; offset?: number }
/** GET /users/:pubkey → UserDetail (pubkey may be hex or npub) */
/** PATCH /users/:pubkey */
export interface UserPatch { notes?: string; tags?: string[]; rateLimit?: RateLimitOverride | null; blossomQuota?: number | null; nip05Name?: string | null; allowed?: boolean; denied?: boolean }
/** POST /users/:pubkey/ban */
export interface BanRequest { reason?: string; deleteEvents?: boolean; deleteMedia?: boolean; disconnect?: boolean }
/** POST /users/:pubkey/unban ; POST /users/:pubkey/mute ; POST /users/:pubkey/unmute */
/** PUT /users/:pubkey/role  (admins.manage) */
export interface RoleRequest { role: AdminRole | null }
/** POST /users/bulk */
export interface BulkUserRequest {
  pubkeys: string[];
  action: "ban" | "unban" | "mute" | "unmute" | "allow" | "disallow" | "deny" | "undeny" | "delete-events" | "add-tag" | "remove-tag";
  reason?: string;
  tag?: string;
}
export interface BulkResult { ok: number; failed: { pubkey: string; error: string }[] }
/** GET /users/:pubkey/events?limit&until → {items: NostrEvent[]} */
/** POST /users  {pubkey, allowed?, notes?, tags?} — add user manually (e.g. allowlist) */

/** GET /admins → {items: UserView[]} users with a role */

// ------------------------------------------------------------- invites & ip rules
/** GET /invites → {items: Invite[]}; POST /invites {maxUses?, expiresAt?, note?, count?} → {items: Invite[]}; DELETE /invites/:code */
export type InviteView = Invite & { url: string };
/** GET /ip-rules → {items: IpRule[]}; POST /ip-rules IpRuleInput; DELETE /ip-rules/:cidr (url-encoded) */
export type IpRuleInput = Omit<IpRule, "createdAt">;

// ------------------------------------------------------------- content
/** POST /events/query */
export interface EventQueryRequest { filters: Filter[]; limit?: number }
export interface EventQueryResponse { items: EventView[] }
export interface EventView { event: NostrEvent; author?: Profile; reports: number }
/** GET /events/:id → EventView ; DELETE /events/:id {reason?} */
/** POST /events/delete */
export interface EventDeleteRequest { ids?: string[]; filters?: Filter[]; reason?: string }
/** POST /events/import  body: JSONL (one event per line), ?bypassPolicies=true → ImportResult */
export interface ImportResult { imported: number; duplicates: number; rejected: number; errors: string[] }
/** GET /events/export?filters=<urlencoded json Filter[]> → application/x-ndjson stream */

// ------------------------------------------------------------- reports (NIP-56 kind 1984)
export type ReportStatus = "open" | "resolved" | "dismissed";
export interface ReportView {
  id: string; // report event id
  report: NostrEvent;
  reporter: string;
  reporterProfile?: Profile;
  targetPubkey: string;
  targetProfile?: Profile;
  targetEventId?: string;
  targetEvent?: NostrEvent;
  targetBlob?: string;
  type: string; // nudity|malware|profanity|illegal|spam|impersonation|other
  status: ReportStatus;
  resolution?: { action: string; by: string; at: number; note?: string };
  /** count of open reports against same target */
  relatedCount: number;
}
/** GET /reports?status&type&limit&offset → Paged<ReportView> */
/** POST /reports/:id/resolve */
export interface ResolveReportRequest { action: "dismiss" | "delete-event" | "ban-user" | "delete-and-ban" | "delete-media"; note?: string }
/** POST /reports/bulk-resolve {ids: string[], action, note?} → BulkResult-like {ok, failed} */

// ------------------------------------------------------------- media (blossom)
/** GET /media?pubkey&status&type&limit&offset → Paged<BlobRecord> ; GET /media/stats */
export interface MediaStats { count: number; bytes: number; byType: { type: string; count: number; bytes: number }[]; pending: number }
/** POST /media/:sha256/status {status: BlobStatus} ; DELETE /media/:sha256?block=true ; POST /media/bulk {sha256s, action:"approve"|"block"|"delete"} */
export type MediaStatusRequest = { status: BlobStatus };
export type MediaItem = BlobRecord;

// ------------------------------------------------------------- settings
/** GET /settings → SettingsResponse ; PATCH /settings DeepPartial<RuntimeSettings> → SettingsResponse */
export interface SettingsResponse { settings: RuntimeSettings; schema: Record<string, unknown> /* JSON Schema */ }
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
/** GET /audit?actor&action&target&before&limit → {items: AuditEntry[]} */
export type AuditView = AuditEntry;

// ------------------------------------------------------------- push notifications
/** GET /push/vapid → {publicKey: string | null}; POST /push/subscribe {subscription: PushSubscriptionJSON, topics?: PushTopic[]}; POST /push/unsubscribe {endpoint} */
export type PushTopic = "reports" | "alerts" | "users";

// ------------------------------------------------------------- SSE  GET /stream?events=1&kinds=1,7
/** Server-sent event names and payloads */
export interface StreamEvents {
  snapshot: LiveSnapshot; // every 2s
  event: { event: NostrEvent; status: "accepted" | "rejected"; reason?: string; ip?: string; country?: string }; // only if ?events=1
  alert: { level: "info" | "warning" | "critical"; title: string; message: string; url?: string };
  report: ReportView;
}

export type { AdminRole, AuditEntry, BlobRecord, BlobStatus, ConnectionSummary, GeoPoint, GroupSummary, Invite, IpRule, LiveSnapshot, PluginInfo, UserRecord, UserStatus, RuntimeSettings, DeepPartial, NostrEvent, Filter };
