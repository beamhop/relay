import type { Db, Migration } from "@beamhop/sdk";
import { hashSessionId } from "./services/sessions";

/** marks session ids stored before they were hashed (see 005) */
const LEGACY_SESSION_PREFIX = "legacy:";

export const ADMIN_MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    up: `
CREATE TABLE IF NOT EXISTS admin_credentials (
  pubkey TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_passkeys (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX IF NOT EXISTS admin_passkeys_pubkey ON admin_passkeys (pubkey);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  last_seen_at BIGINT NOT NULL,
  method TEXT NOT NULL DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS admin_sessions_pubkey ON admin_sessions (pubkey);
CREATE INDEX IF NOT EXISTS admin_sessions_expires ON admin_sessions (expires_at);
CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  subscription TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_report_status (
  report_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  action TEXT NOT NULL,
  by TEXT NOT NULL,
  at BIGINT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS admin_banned_events (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL,
  at BIGINT NOT NULL
);
`,
  },
  {
    // last accepted TOTP time step, persisted so a used code can't be replayed after a restart
    id: "002_totp_last_step",
    up: "ALTER TABLE admin_credentials ADD COLUMN totp_last_step BIGINT",
  },
  {
    // when the password itself was last set (updated_at also moves on TOTP changes); NULL for older rows
    id: "003_password_set_at",
    up: "ALTER TABLE admin_credentials ADD COLUMN password_set_at BIGINT",
  },
  {
    // the session that registered a push device: logging it out (or out of every other session) drops the device;
    // NULL for NIP-98 registrations and older rows
    id: "004_push_session",
    up: "ALTER TABLE admin_push_subscriptions ADD COLUMN session_id TEXT",
  },
  {
    // sessions are stored under sha256(id) from now on (the raw id only lives in the cookie). SQLite has no SQL
    // sha256, so existing ids (and the push devices bound to them) are only marked here and hashed in place by
    // hashLegacySessionIds right after migrating — signed-in admins stay signed in
    id: "005_hash_session_ids",
    up: `
UPDATE admin_sessions SET id = '${LEGACY_SESSION_PREFIX}' || id;
UPDATE admin_push_subscriptions SET session_id = '${LEGACY_SESSION_PREFIX}' || session_id WHERE session_id IS NOT NULL;
`,
  },
  {
    // NIP-98 auth event ids already used, shared by every instance on this database (replay protection)
    id: "006_used_auth",
    up: `
CREATE TABLE IF NOT EXISTS admin_used_auth (
  id TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_used_auth_expires ON admin_used_auth (expires_at);
`,
  },
  {
    // the role of whoever banned an event (NIP-86 banevent): lifting the ban needs at least that rank. NULL for older
    // rows, which fall back to the banner's current rank
    id: "007_banned_event_role",
    up: "ALTER TABLE admin_banned_events ADD COLUMN by_role TEXT",
  },
  {
    // deliveries in a row a push service refused with 400/401/403; the device is dropped at MAX_PUSH_FAILURES
    id: "008_push_failures",
    up: "ALTER TABLE admin_push_subscriptions ADD COLUMN failures INTEGER NOT NULL DEFAULT 0",
  },
  {
    // one row per stored report (kind 1984) with what the queue filters on, so listing, filters, counts and paging run
    // in SQL over every report. Filled from bus "report.created" and backfilled once from the event store (see
    // ReportService.backfill); `status` mirrors admin_report_status ('open' without a row there)
    id: "009_report_index",
    up: `
CREATE TABLE IF NOT EXISTS admin_report_index (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  reporter TEXT NOT NULL,
  type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_event TEXT,
  target_blob TEXT,
  subject_pubkey TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS admin_report_index_created ON admin_report_index (created_at);
CREATE INDEX IF NOT EXISTS admin_report_index_status ON admin_report_index (status, created_at);
CREATE INDEX IF NOT EXISTS admin_report_index_type ON admin_report_index (type, created_at);
CREATE INDEX IF NOT EXISTS admin_report_index_target ON admin_report_index (target_key, status);
CREATE INDEX IF NOT EXISTS admin_report_index_event ON admin_report_index (target_event);
CREATE INDEX IF NOT EXISTS admin_report_index_blob ON admin_report_index (target_blob);
CREATE INDEX IF NOT EXISTS admin_report_index_subject ON admin_report_index (subject_pubkey, created_at);
`,
  },
];

export async function migrateAdmin(db: Db): Promise<void> {
  await db.migrate("admin", ADMIN_MIGRATIONS);
  await hashLegacySessionIds(db);
}

/**
 * Finishes 005: replaces each marked session id, and the push devices' references to it, with its hash. Idempotent
 * (each update matches the marked value only), so instances starting together or a run interrupted halfway are fine.
 */
async function hashLegacySessionIds(db: Db): Promise<void> {
  const like = `${LEGACY_SESSION_PREFIX}%`;
  const ids = new Set(
    [
      ...(await db.all<{ id: string }>("SELECT id FROM admin_sessions WHERE id LIKE ?", [like])),
      ...(await db.all<{ id: string }>("SELECT DISTINCT session_id AS id FROM admin_push_subscriptions WHERE session_id LIKE ?", [like])),
    ].map((r) => r.id),
  );
  if (!ids.size) return;
  await db.tx(async (tx) => {
    for (const legacy of ids) {
      const hashed = hashSessionId(legacy.slice(LEGACY_SESSION_PREFIX.length));
      await tx.run("UPDATE admin_sessions SET id = ? WHERE id = ?", [hashed, legacy]);
      await tx.run("UPDATE admin_push_subscriptions SET session_id = ? WHERE session_id = ?", [hashed, legacy]);
    }
  });
}

/** Splits a list into chunks for `IN (?, ?, …)` queries (keeps parameter counts portable; 500 by default). */
export { chunk } from "@beamhop/sdk/util";
export const placeholders = (n: number) => new Array(n).fill("?").join(",");
