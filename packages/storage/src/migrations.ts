import type { Db, Migration } from "@beamhop/sdk";

export const NAMESPACE = "storage";

const eventsSqlite = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  tags TEXT NOT NULL,
  content TEXT NOT NULL,
  sig TEXT NOT NULL,
  d_tag TEXT,
  expiration INTEGER
);
CREATE TABLE IF NOT EXISTS event_tags (
  event_seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS events_tags_ad AFTER DELETE ON events BEGIN
  DELETE FROM event_tags WHERE event_seq = old.seq;
END;
`;

const eventsPostgres = `
CREATE TABLE IF NOT EXISTS events (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT COLLATE "C" NOT NULL UNIQUE,
  pubkey TEXT COLLATE "C" NOT NULL,
  created_at BIGINT NOT NULL,
  kind INTEGER NOT NULL,
  tags TEXT NOT NULL,
  content TEXT NOT NULL,
  sig TEXT NOT NULL,
  d_tag TEXT,
  expiration BIGINT,
  search TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, left(content, 100000))) STORED
);
CREATE TABLE IF NOT EXISTS event_tags (
  event_seq BIGINT NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
  name TEXT COLLATE "C" NOT NULL,
  value TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_search_idx ON events USING GIN (search);
`;

const eventIndexes = `
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS events_kind_created_idx ON events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS events_pubkey_created_idx ON events (pubkey, created_at DESC);
CREATE INDEX IF NOT EXISTS events_pubkey_kind_created_idx ON events (pubkey, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS events_replaceable_idx ON events (pubkey, kind, d_tag) WHERE d_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_expiration_idx ON events (expiration) WHERE expiration IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_tags_lookup_idx ON event_tags (name, value, created_at DESC, event_seq);
CREATE INDEX IF NOT EXISTS event_tags_seq_idx ON event_tags (event_seq);
CREATE TABLE IF NOT EXISTS deleted_events (
  pubkey TEXT NOT NULL,
  ref TEXT NOT NULL,
  deleted_at BIGINT NOT NULL,
  deletion_id TEXT NOT NULL,
  PRIMARY KEY (pubkey, ref)
);
`;

const misc = `
CREATE TABLE IF NOT EXISTS users (
  pubkey TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  allowed INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  rate_limit TEXT,
  blossom_quota BIGINT,
  nip05_name TEXT,
  invited_by TEXT,
  ban_reason TEXT,
  first_seen_at BIGINT NOT NULL DEFAULT 0,
  last_seen_at BIGINT NOT NULL DEFAULT 0,
  event_count BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS users_nip05_idx ON users (nip05_name) WHERE nip05_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS users_first_seen_idx ON users (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS users_event_count_idx ON users (event_count DESC);
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role) WHERE role IS NOT NULL;

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ip_rules (
  cidr TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (namespace, key)
);
`;

const auditSqlite = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT
);`;
const auditPostgres = `
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT
);`;
const auditIndexes = `
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_log (actor, id);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action, id);
CREATE INDEX IF NOT EXISTS audit_target_idx ON audit_log (target, id);
`;

/** SQLite FTS5 index over event content (external-content table, kept in sync by triggers). */
const ftsSqlite = `
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content, content='events', content_rowid='seq', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, content) VALUES ('delete', old.seq, old.content);
END;
INSERT INTO events_fts(events_fts) VALUES ('rebuild');
`;

export const FTS_MIGRATION_ID = "002_events_fts";

export function storageMigrations(withFts: boolean): Migration[] {
  const list: Migration[] = [
    {
      id: "001_init",
      up: {
        sqlite: eventsSqlite + eventIndexes + misc + auditSqlite + auditIndexes,
        postgres: eventsPostgres + eventIndexes + misc + auditPostgres + auditIndexes,
      },
    },
  ];
  // Postgres full-text search lives in 001 (generated tsvector column); the sqlite FTS5
  // migration is only offered when the sqlite build supports FTS5 (applied later if it becomes available).
  if (withFts) list.push({ id: FTS_MIGRATION_ID, up: { sqlite: ftsSqlite, postgres: "SELECT 1" } });
  return list;
}

/** Probes whether the sqlite build has FTS5 compiled in. */
export async function sqliteHasFts5(db: Db): Promise<boolean> {
  try {
    await db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp._beamhop_fts_probe USING fts5(x); DROP TABLE temp._beamhop_fts_probe;");
    return true;
  } catch {
    return false;
  }
}

/** Whether the sqlite FTS table is present (migration applied). */
export async function sqliteFtsReady(db: Db): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events_fts'",
  );
  return Number(row?.n ?? 0) > 0;
}
