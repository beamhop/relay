import type { Context, Hono } from "hono";
import type { AdminApiDeps, AdminRole, Logger, Permission, ReportView } from "@beamhop/sdk";
import type { SessionRecord, SessionService } from "./services/sessions";
import type { RoleService } from "./services/roles";
import type { ProfileService } from "./services/profiles";
import type { ReportService } from "./services/reports";
import type { PushSender, PushService } from "./services/push";
import type { UserService } from "./services/users";
import type { ModerationService } from "./services/moderation";
import type { BannedEventService } from "./services/banned-events";
import type { CredentialService } from "./services/credentials";
import type { ReplayGuard } from "./services/replay";
import type { PasswordHasher, ScryptParams } from "./util/password";

export interface Principal {
  pubkey: string;
  /** null = authenticated but not an admin */
  role: AdminRole | null;
  permissions: ReadonlySet<Permission>;
  via: "session" | "nip98";
  session?: SessionRecord;
}

export type AdminEnv = {
  Variables: {
    principal: Principal | undefined;
    ip: string | null;
  };
};
export type AdminApp = Hono<AdminEnv>;
export type AdminContext = Context<AdminEnv>;

export interface AdminApiOptions {
  /** clock override (ms), for tests */
  now?: () => number;
  /** SSE snapshot interval (ms), default 2000 */
  snapshotIntervalMs?: number;
  /** SSE heartbeat interval (ms), default 15000 */
  heartbeatMs?: number;
  /** web-push delivery override (tests / custom transports) */
  pushSender?: PushSender;
  /** scrypt parameters for new password hashes, default N=2^17, r=8, p=1 (tests use cheaper ones) */
  scryptParams?: ScryptParams;
  /** total size cap of a POST /events/import body (bytes), default 256 MiB */
  importMaxBytes?: number;
  /** minimum time between two report push notifications; reports in between are sent as one digest. Default 60000 */
  reportPushIntervalMs?: number;
  /** the same for alerts, per level and title: the first is pushed, the rest of the interval as one digest. Default 60000 */
  alertPushIntervalMs?: number;
  /** how long (ms) the banned-event id cache is trusted before it is re-read from the database, default 5000 */
  bannedEventsTtlMs?: number;
  /** time budget (ms) of one POST /users/bulk; targets not reached by then are returned as `remaining`. Default 20000 */
  bulkBudgetMs?: number;
  /** how often (ms) audit log retention (settings retention.auditLogDays) runs; default once a day */
  auditPruneIntervalMs?: number;
}

export interface ApiContext {
  deps: AdminApiDeps;
  opts: AdminApiOptions;
  logger: Logger;
  nowMs(): number;
  nowSec(): number;
  /** config.server.publicUrl without trailing slash */
  publicUrl: string;
  publicOrigin: string;
  rpID: string;
  secureCookies: boolean;
  sessions: SessionService;
  roles: RoleService;
  profiles: ProfileService;
  users: UserService;
  reports: ReportService;
  push: PushService;
  /** ban/unban, IP rules, user deletion: the effects every moderation path shares */
  moderation: ModerationService;
  /** event bans (NIP-86 banevent, REST /events/bans): rows, write enforcement, lift rank rule */
  bannedEvents: BannedEventService;
  credentials: CredentialService;
  passwords: PasswordHasher;
  /** NIP-98 event ids already used (replay protection, shared through the database) */
  replay: ReplayGuard;
  /** subscribe to enriched views of newly created reports (bus "report.created") */
  onReport(fn: (r: ReportView) => void): () => void;
  /** Records audit entry + emits bus "admin.action". Actor/ip taken from the request. */
  audit(c: AdminContext, action: string, target: string | null, details?: Record<string, unknown>): Promise<void>;
  auditAs(actor: string, ip: string | null, action: string, target: string | null, details?: Record<string, unknown>): Promise<void>;
}

export function principalOf(c: AdminContext): Principal {
  const p = c.get("principal");
  if (!p) throw new Error("principal missing (route not protected)");
  return p;
}
