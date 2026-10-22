import type { Db, Migration } from "@beamhop/sdk";

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
];

export const migrateAdmin = (db: Db) => db.migrate("admin", ADMIN_MIGRATIONS);

/** Splits a list into chunks for `IN (?, ?, …)` queries (keeps parameter counts portable). */
export function chunk<T>(items: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
export const placeholders = (n: number) => new Array(n).fill("?").join(",");
