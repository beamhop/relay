import type { BlobStatus, Db, Migration } from "@beamhop/sdk";

const migrations: Migration[] = [
  {
    id: "001_init",
    up: `
CREATE TABLE IF NOT EXISTS blossom_blobs (
  sha256 TEXT PRIMARY KEY,
  size BIGINT NOT NULL,
  type TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  has_thumbnail INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS blossom_blobs_created_idx ON blossom_blobs (created_at);
CREATE INDEX IF NOT EXISTS blossom_blobs_status_idx ON blossom_blobs (status);
CREATE TABLE IF NOT EXISTS blossom_owners (
  sha256 TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (sha256, pubkey)
);
CREATE INDEX IF NOT EXISTS blossom_owners_pubkey_idx ON blossom_owners (pubkey, created_at);
CREATE TABLE IF NOT EXISTS blossom_blocklist (
  sha256 TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
`,
  },
  {
    // blossom_deletions: an owner deleted their copy of a blob at `deleted_at` (their delete token's created_at), so
    // their older upload tokens for it are refused; rows are pruned once no such token can still be valid.
    // blossom_stripped: metadata stripping turned `original` into the stored `sha256`; a block on the stored blob
    // also refuses the original bytes (e.g. mirrored byte-identical from another server).
    id: "002_deletions_stripped",
    up: `
CREATE TABLE IF NOT EXISTS blossom_deletions (
  sha256 TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  deleted_at BIGINT NOT NULL,
  PRIMARY KEY (sha256, pubkey)
);
CREATE INDEX IF NOT EXISTS blossom_deletions_at_idx ON blossom_deletions (deleted_at);
CREATE TABLE IF NOT EXISTS blossom_stripped (
  original TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS blossom_stripped_sha_idx ON blossom_stripped (sha256);
`,
  },
  {
    // who moderated: the admin who set a blob's pending/blocked status, and who put a hash on the blocklist
    id: "003_moderated_by",
    up: `
ALTER TABLE blossom_blobs ADD COLUMN moderated_by TEXT;
ALTER TABLE blossom_blocklist ADD COLUMN blocked_by TEXT;
`,
  },
  {
    // blossom_held: status (+ moderator) a non-approved blob was purged with when its last owner deleted it; a
    // re-upload starts out in it. Was the kv namespace "blossom-held-status" (moved over at startup).
    // blossom_used_tokens: BUD-11 delete tokens already used (`<event id>:<sha256>`), kept until the token expires
    // (ms). Was the kv namespace "blossom-used-delete-tokens".
    // blossom_pending_deletes: blob bytes whose deletion failed; retried while the blob has no row.
    id: "004_held_tokens_pending",
    up: `
CREATE TABLE IF NOT EXISTS blossom_held (
  sha256 TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  moderated_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS blossom_used_tokens (
  id TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS blossom_used_tokens_exp_idx ON blossom_used_tokens (expires_at);
CREATE TABLE IF NOT EXISTS blossom_pending_deletes (
  sha256 TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
`,
  },
];

export interface BlobRow {
  sha256: string;
  size: number;
  type: string;
  createdAt: number;
  status: BlobStatus;
  /** admin who set the current pending/blocked status (null when approved, or held back by requireApproval) */
  moderatedBy: string | null;
  hasThumbnail: boolean;
}

interface OwnedBlobRow extends BlobRow {
  /** when this owner uploaded it */
  ownedAt: number;
}

type RawBlob = {
  sha256: string;
  size: unknown;
  type: string;
  created_at: unknown;
  status: string;
  moderated_by: string | null;
  has_thumbnail: unknown;
  owned_at?: unknown;
};

const toRow = (r: RawBlob): BlobRow => ({
  sha256: r.sha256,
  size: Number(r.size),
  type: r.type,
  createdAt: Number(r.created_at),
  status: r.status as BlobStatus,
  moderatedBy: r.moderated_by ?? null,
  hasThumbnail: Number(r.has_thumbnail) === 1,
});

const BLOB_COLS = "b.sha256, b.size, b.type, b.created_at, b.status, b.moderated_by, b.has_thumbnail";

interface ListQuery {
  pubkey?: string;
  status?: BlobStatus;
  type?: string;
  limit?: number;
  offset?: number;
}

/** Data access for blossom tables (portable SQL for sqlite + postgres). */
export class BlobRepo {
  constructor(private db: Db) {}

  migrate() {
    return this.db.migrate("blossom", migrations);
  }

  /**
   * Runs `fn` in one transaction with a repo bound to it. Only quick row work belongs in there: no driver I/O, hooks
   * or other slow awaits (SQLite has one connection, and every other statement waits for the transaction).
   */
  tx<T>(fn: (repo: BlobRepo) => Promise<T>): Promise<T> {
    return this.db.tx((db) => fn(new BlobRepo(db)));
  }

  async get(sha256: string): Promise<BlobRow | undefined> {
    const r = await this.db.get<RawBlob>(`SELECT ${BLOB_COLS} FROM blossom_blobs b WHERE b.sha256 = ?`, [sha256]);
    return r && toRow(r);
  }

  async insert(row: BlobRow): Promise<void> {
    await this.db.run(
      "INSERT INTO blossom_blobs (sha256, size, type, created_at, status, moderated_by, has_thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING",
      [row.sha256, row.size, row.type, row.createdAt, row.status, row.moderatedBy, row.hasThumbnail ? 1 : 0],
    );
  }

  /** `moderatedBy` is kept for pending/blocked and cleared on approval. */
  async setStatus(sha256: string, status: BlobStatus, moderatedBy: string | null): Promise<boolean> {
    const by = status === "approved" ? null : moderatedBy;
    return (await this.db.run("UPDATE blossom_blobs SET status = ?, moderated_by = ? WHERE sha256 = ?", [status, by, sha256])).changes > 0;
  }

  async remove(sha256: string): Promise<void> {
    await this.db.run("DELETE FROM blossom_owners WHERE sha256 = ?", [sha256]);
    await this.db.run("DELETE FROM blossom_blobs WHERE sha256 = ?", [sha256]);
  }

  async addOwner(sha256: string, pubkey: string, at: number): Promise<void> {
    await this.db.run("INSERT INTO blossom_owners (sha256, pubkey, created_at) VALUES (?, ?, ?) ON CONFLICT (sha256, pubkey) DO NOTHING", [
      sha256,
      pubkey,
      at,
    ]);
  }

  async removeOwner(sha256: string, pubkey: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM blossom_owners WHERE sha256 = ? AND pubkey = ?", [sha256, pubkey])).changes > 0;
  }

  async isOwner(sha256: string, pubkey: string): Promise<boolean> {
    return !!(await this.db.get("SELECT 1 AS x FROM blossom_owners WHERE sha256 = ? AND pubkey = ?", [sha256, pubkey]));
  }

  /** When `pubkey` became an owner of the blob (undefined when it isn't one). */
  async ownedAt(sha256: string, pubkey: string): Promise<number | undefined> {
    const r = await this.db.get<{ created_at: unknown }>("SELECT created_at FROM blossom_owners WHERE sha256 = ? AND pubkey = ?", [sha256, pubkey]);
    return r ? Number(r.created_at) : undefined;
  }

  /** Remembers that `pubkey` deleted its copy of the blob at `at` (only ever moves forward). */
  async recordDeletion(sha256: string, pubkey: string, at: number): Promise<void> {
    await this.db.run(
      `INSERT INTO blossom_deletions (sha256, pubkey, deleted_at) VALUES (?, ?, ?)
       ON CONFLICT (sha256, pubkey) DO UPDATE SET deleted_at = excluded.deleted_at WHERE blossom_deletions.deleted_at < excluded.deleted_at`,
      [sha256, pubkey, at],
    );
  }

  async deletedAt(sha256: string, pubkey: string): Promise<number | undefined> {
    const r = await this.db.get<{ deleted_at: unknown }>("SELECT deleted_at FROM blossom_deletions WHERE sha256 = ? AND pubkey = ?", [sha256, pubkey]);
    return r ? Number(r.deleted_at) : undefined;
  }

  /** Latest time `pubkey` deleted any of `shas` or the blobs they were stripped into (undefined: never). */
  async lastDeletion(pubkey: string, shas: string[]): Promise<number | undefined> {
    const q = shas.map(() => "?").join(",");
    const r = await this.db.get<{ d: unknown }>(
      `SELECT MAX(deleted_at) AS d FROM blossom_deletions
       WHERE pubkey = ? AND (sha256 IN (${q}) OR sha256 IN (SELECT sha256 FROM blossom_stripped WHERE original IN (${q})))`,
      [pubkey, ...shas, ...shas],
    );
    return r?.d == null ? undefined : Number(r.d);
  }

  async pruneDeletions(before: number): Promise<void> {
    await this.db.run("DELETE FROM blossom_deletions WHERE deleted_at < ?", [before]);
  }

  /** Records that stripping `original` produced the stored blob `sha256`. */
  async addStripped(original: string, sha256: string, at: number): Promise<void> {
    await this.db.run("INSERT INTO blossom_stripped (original, sha256, created_at) VALUES (?, ?, ?) ON CONFLICT (original) DO NOTHING", [original, sha256, at]);
  }

  /** The stored blob that `original` was stripped into, if any. */
  async strippedTo(original: string): Promise<string | undefined> {
    return (await this.db.get<{ sha256: string }>("SELECT sha256 FROM blossom_stripped WHERE original = ?", [original]))?.sha256;
  }

  /** Originals that stripping turned into `sha256`. */
  async originalsOf(sha256: string): Promise<string[]> {
    return (await this.db.all<{ original: string }>("SELECT original FROM blossom_stripped WHERE sha256 = ?", [sha256])).map((r) => r.original);
  }

  /**
   * Drops original → stored mappings involving `sha256` (as either side) that no longer matter: the stored blob is
   * gone and neither hash is on the blocklist (a row moderated to "blocked" still exists, so it's covered by the first).
   */
  async pruneStripped(sha256: string): Promise<void> {
    await this.db.run(
      `DELETE FROM blossom_stripped WHERE (sha256 = ? OR original = ?)
       AND NOT EXISTS (SELECT 1 FROM blossom_blobs b WHERE b.sha256 = blossom_stripped.sha256)
       AND NOT EXISTS (SELECT 1 FROM blossom_blocklist k WHERE k.sha256 = blossom_stripped.sha256 OR k.sha256 = blossom_stripped.original)`,
      [sha256, sha256],
    );
  }

  async ownerCount(sha256: string): Promise<number> {
    const r = await this.db.get<{ n: unknown }>("SELECT COUNT(*) AS n FROM blossom_owners WHERE sha256 = ?", [sha256]);
    return Number(r?.n ?? 0);
  }

  async owners(shas: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (shas.length === 0) return map;
    const rows = await this.db.all<{ sha256: string; pubkey: string }>(
      `SELECT sha256, pubkey FROM blossom_owners WHERE sha256 IN (${shas.map(() => "?").join(",")}) ORDER BY created_at ASC`,
      shas,
    );
    for (const r of rows) {
      const list = map.get(r.sha256) ?? [];
      list.push(r.pubkey);
      map.set(r.sha256, list);
    }
    return map;
  }

  async shasOwnedBy(pubkey: string): Promise<string[]> {
    const rows = await this.db.all<{ sha256: string }>("SELECT sha256 FROM blossom_owners WHERE pubkey = ?", [pubkey]);
    return rows.map((r) => r.sha256);
  }

  /** Blobs owned by pubkey, newest first (by ownership time). `cursor` = sha256 of the last item of the previous page. */
  async listByOwner(
    pubkey: string,
    q: { since?: number; until?: number; limit?: number; cursor?: string; includeUnapproved?: boolean },
  ): Promise<OwnedBlobRow[]> {
    const where = ["o.pubkey = ?"];
    const params: unknown[] = [pubkey];
    if (!q.includeUnapproved) where.push("b.status = 'approved'");
    if (q.since !== undefined) (where.push("o.created_at >= ?"), params.push(q.since));
    if (q.until !== undefined) (where.push("o.created_at <= ?"), params.push(q.until));
    if (q.cursor) {
      const c = await this.db.get<{ created_at: unknown }>("SELECT created_at FROM blossom_owners WHERE pubkey = ? AND sha256 = ?", [
        pubkey,
        q.cursor,
      ]);
      if (c) {
        where.push("(o.created_at < ? OR (o.created_at = ? AND o.sha256 > ?))");
        params.push(Number(c.created_at), Number(c.created_at), q.cursor);
      }
    }
    let sql = `SELECT ${BLOB_COLS}, o.created_at AS owned_at FROM blossom_owners o JOIN blossom_blobs b ON b.sha256 = o.sha256
      WHERE ${where.join(" AND ")} ORDER BY o.created_at DESC, o.sha256 ASC`;
    if (q.limit !== undefined) (sql += " LIMIT ?", params.push(q.limit));
    const rows = await this.db.all<RawBlob>(sql, params);
    return rows.map((r) => ({ ...toRow(r), ownedAt: Number(r.owned_at) }));
  }

  async list(q: ListQuery): Promise<{ items: BlobRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.pubkey) (where.push("b.sha256 IN (SELECT sha256 FROM blossom_owners WHERE pubkey = ?)"), params.push(q.pubkey));
    if (q.status) (where.push("b.status = ?"), params.push(q.status));
    if (q.type) {
      const t = q.type.toLowerCase();
      if (t.endsWith("/*")) (where.push("b.type LIKE ?"), params.push(`${t.slice(0, -2)}/%`));
      else if (t.includes("/")) (where.push("b.type = ?"), params.push(t));
      else (where.push("b.type LIKE ?"), params.push(`${t}/%`));
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM blossom_blobs b ${w}`, params))?.n ?? 0);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);
    const rows = await this.db.all<RawBlob>(
      `SELECT ${BLOB_COLS} FROM blossom_blobs b ${w} ORDER BY b.created_at DESC, b.sha256 ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items: rows.map(toRow), total };
  }

  async usage(pubkey: string): Promise<{ count: number; bytes: number }> {
    const r = await this.db.get<{ n: unknown; bytes: unknown }>(
      "SELECT COUNT(*) AS n, COALESCE(SUM(b.size), 0) AS bytes FROM blossom_owners o JOIN blossom_blobs b ON b.sha256 = o.sha256 WHERE o.pubkey = ?",
      [pubkey],
    );
    return { count: Number(r?.n ?? 0), bytes: Number(r?.bytes ?? 0) };
  }

  async statsByType(): Promise<{ type: string; count: number; bytes: number }[]> {
    const rows = await this.db.all<{ type: string; n: unknown; bytes: unknown }>(
      "SELECT type, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blossom_blobs GROUP BY type",
    );
    return rows.map((r) => ({ type: r.type, count: Number(r.n), bytes: Number(r.bytes) }));
  }

  /**
   * Whether any of `shas` is refused: on the blocklist, moderated to "blocked", or stripped into a blob that is one of
   * those. One query (it runs several times per upload).
   */
  async refused(shas: string[]): Promise<boolean> {
    const q = shas.map(() => "?").join(",");
    const r = await this.db.get<{ refused: unknown }>(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM blossom_blocklist k WHERE k.sha256 IN (${q}) OR k.sha256 IN (SELECT s.sha256 FROM blossom_stripped s WHERE s.original IN (${q})))
         OR EXISTS (SELECT 1 FROM blossom_blobs b WHERE b.status = 'blocked'
           AND (b.sha256 IN (${q}) OR b.sha256 IN (SELECT s.sha256 FROM blossom_stripped s WHERE s.original IN (${q}))))
       THEN 1 ELSE 0 END AS refused`,
      [...shas, ...shas, ...shas, ...shas],
    );
    return Number(r?.refused ?? 0) === 1;
  }

  async isBlocked(sha256: string): Promise<boolean> {
    return !!(await this.db.get("SELECT 1 AS x FROM blossom_blocklist WHERE sha256 = ?", [sha256]));
  }

  async block(sha256: string, reason: string, at: number, blockedBy: string | null): Promise<void> {
    await this.db.run(
      `INSERT INTO blossom_blocklist (sha256, reason, created_at, blocked_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (sha256) DO UPDATE SET reason = excluded.reason, blocked_by = excluded.blocked_by`,
      [sha256, reason, at, blockedBy],
    );
  }

  async unblock(sha256: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM blossom_blocklist WHERE sha256 = ?", [sha256])).changes > 0;
  }

  async blocklist(): Promise<{ sha256: string; reason: string; createdAt: number; blockedBy: string | null }[]> {
    const rows = await this.db.all<{ sha256: string; reason: string; created_at: unknown; blocked_by: string | null }>(
      "SELECT sha256, reason, created_at, blocked_by FROM blossom_blocklist ORDER BY created_at DESC",
    );
    return rows.map((r) => ({ sha256: r.sha256, reason: r.reason, createdAt: Number(r.created_at), blockedBy: r.blocked_by ?? null }));
  }

  // ---------------------------------------------------------------- held status

  async held(sha256: string): Promise<{ status: BlobStatus; by: string | null } | undefined> {
    const r = await this.db.get<{ status: string; moderated_by: string | null }>("SELECT status, moderated_by FROM blossom_held WHERE sha256 = ?", [sha256]);
    return r && (r.status === "pending" || r.status === "blocked") ? { status: r.status, by: r.moderated_by ?? null } : undefined;
  }

  async setHeld(sha256: string, status: BlobStatus, by: string | null, at: number): Promise<void> {
    await this.db.run(
      `INSERT INTO blossom_held (sha256, status, moderated_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (sha256) DO UPDATE SET status = excluded.status, moderated_by = excluded.moderated_by, created_at = excluded.created_at`,
      [sha256, status, by, at],
    );
  }

  async clearHeld(sha256: string): Promise<void> {
    await this.db.run("DELETE FROM blossom_held WHERE sha256 = ?", [sha256]);
  }

  // ---------------------------------------------------------------- used delete tokens

  /** `now` and `expiresAt` in ms */
  async tokenUsed(id: string, now: number): Promise<number | undefined> {
    const r = await this.db.get<{ expires_at: unknown }>("SELECT expires_at FROM blossom_used_tokens WHERE id = ? AND expires_at > ?", [id, now]);
    return r ? Number(r.expires_at) : undefined;
  }

  async markTokenUsed(id: string, expiresAt: number): Promise<void> {
    await this.db.run("INSERT INTO blossom_used_tokens (id, expires_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at", [
      id,
      expiresAt,
    ]);
  }

  async pruneUsedTokens(now: number): Promise<void> {
    await this.db.run("DELETE FROM blossom_used_tokens WHERE expires_at <= ?", [now]);
  }

  // ---------------------------------------------------------------- pending byte deletions

  async addPendingDelete(sha256: string, at: number): Promise<void> {
    await this.db.run("INSERT INTO blossom_pending_deletes (sha256, created_at, attempts) VALUES (?, ?, 0) ON CONFLICT (sha256) DO NOTHING", [sha256, at]);
  }

  async pendingDeletes(limit: number): Promise<{ sha256: string; attempts: number }[]> {
    const rows = await this.db.all<{ sha256: string; attempts: unknown }>(
      "SELECT sha256, attempts FROM blossom_pending_deletes ORDER BY attempts ASC, created_at ASC LIMIT ?",
      [limit],
    );
    return rows.map((r) => ({ sha256: r.sha256, attempts: Number(r.attempts) }));
  }

  async pendingDeleteFailed(sha256: string): Promise<void> {
    await this.db.run("UPDATE blossom_pending_deletes SET attempts = attempts + 1 WHERE sha256 = ?", [sha256]);
  }

  async clearPendingDelete(sha256: string): Promise<void> {
    await this.db.run("DELETE FROM blossom_pending_deletes WHERE sha256 = ?", [sha256]);
  }
}
