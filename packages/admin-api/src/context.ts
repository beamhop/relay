import type { Context, Hono } from "hono";
import type { AdminApiDeps, AdminRole, Logger, Permission, ReportView } from "@beamhop/sdk";
import type { SessionRecord, SessionService } from "./services/sessions";
import type { RoleService } from "./services/roles";
import type { ProfileService } from "./services/profiles";
import type { ReportService } from "./services/reports";
import type { PushSender, PushService } from "./services/push";
import type { UserService } from "./services/users";
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
