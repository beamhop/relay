import type { BlobStatus, Db, Migration } from "@beamhop/sdk";

export const migrations: Migration[] = [
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
];

export interface BlobRow {
  sha256: string;
  size: number;
  type: string;
  createdAt: number;
  status: BlobStatus;
  hasThumbnail: boolean;
}

export interface OwnedBlobRow extends BlobRow {
  /** when this owner uploaded it */
  ownedAt: number;
}

type RawBlob = { sha256: string; size: unknown; type: string; created_at: unknown; status: string; has_thumbnail: unknown; owned_at?: unknown };

const toRow = (r: RawBlob): BlobRow => ({
  sha256: r.sha256,
  size: Number(r.size),
  type: r.type,
  createdAt: Number(r.created_at),
  status: r.status as BlobStatus,
  hasThumbnail: Number(r.has_thumbnail) === 1,
});

const BLOB_COLS = "b.sha256, b.size, b.type, b.created_at, b.status, b.has_thumbnail";

export interface ListQuery {
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

  async get(sha256: string): Promise<BlobRow | undefined> {
    const r = await this.db.get<RawBlob>(`SELECT ${BLOB_COLS} FROM blossom_blobs b WHERE b.sha256 = ?`, [sha256]);
    return r && toRow(r);
  }

  async insert(row: BlobRow): Promise<void> {
    await this.db.run(
      "INSERT INTO blossom_blobs (sha256, size, type, created_at, status, has_thumbnail) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING",
      [row.sha256, row.size, row.type, row.createdAt, row.status, row.hasThumbnail ? 1 : 0],
    );
  }

  async setStatus(sha256: string, status: BlobStatus): Promise<boolean> {
    return (await this.db.run("UPDATE blossom_blobs SET status = ? WHERE sha256 = ?", [status, sha256])).changes > 0;
  }

  async setThumbnail(sha256: string, has: boolean): Promise<void> {
    await this.db.run("UPDATE blossom_blobs SET has_thumbnail = ? WHERE sha256 = ?", [has ? 1 : 0, sha256]);
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

  async isBlocked(sha256: string): Promise<boolean> {
    return !!(await this.db.get("SELECT 1 AS x FROM blossom_blocklist WHERE sha256 = ?", [sha256]));
  }

  async block(sha256: string, reason: string, at: number): Promise<void> {
    await this.db.run(
      "INSERT INTO blossom_blocklist (sha256, reason, created_at) VALUES (?, ?, ?) ON CONFLICT (sha256) DO UPDATE SET reason = excluded.reason",
      [sha256, reason, at],
    );
  }

  async unblock(sha256: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM blossom_blocklist WHERE sha256 = ?", [sha256])).changes > 0;
  }

  async blocklist(): Promise<{ sha256: string; reason: string; createdAt: number }[]> {
    const rows = await this.db.all<{ sha256: string; reason: string; created_at: unknown }>(
      "SELECT sha256, reason, created_at FROM blossom_blocklist ORDER BY created_at DESC",
    );
    return rows.map((r) => ({ sha256: r.sha256, reason: r.reason, createdAt: Number(r.created_at) }));
  }
}
