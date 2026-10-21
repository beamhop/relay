// SPDX-License-Identifier: AGPL-3.0-or-later
/** SQL BlobIndex: per-relay blob ownership (blobs themselves live in a BlobStore). */
import type { BlobIndex, BlobOwnership, RelayId } from '@beamhop/core';
import { type SQL, sql } from 'drizzle-orm';
import type { Row, SqlExec } from './exec/types.ts';
import { num } from './sql-util.ts';

const COLS = sql.raw('relay_id, sha256, pubkey, size, type, uploaded_at, expires_at');

function toOwnership(r: Row): BlobOwnership {
  const o: BlobOwnership = {
    relayId: r.relay_id as string,
    sha256: r.sha256 as string,
    pubkey: r.pubkey as string,
    size: num(r.size),
    type: r.type as string,
    uploadedAt: num(r.uploaded_at),
  };
  if (r.expires_at !== null && r.expires_at !== undefined) o.expiresAt = num(r.expires_at);
  return o;
}

export class SqlBlobIndex implements BlobIndex {
  constructor(
    private readonly x: SqlExec,
    private readonly opts: { ready?: () => Promise<void> } = {},
  ) {}

  async init(): Promise<void> {
    await this.opts.ready?.();
  }

  private async rows(q: SQL): Promise<BlobOwnership[]> {
    return (await this.x.all(this.x.compile(q))).map(toOwnership);
  }

  async addOwner(o: BlobOwnership): Promise<void> {
    await this.x.run(
      this.x.compile(
        sql`INSERT INTO blob_owners (relay_id, sha256, pubkey, size, type, uploaded_at, expires_at)
          VALUES (${o.relayId}, ${o.sha256}, ${o.pubkey}, ${o.size}, ${o.type}, ${o.uploadedAt}, ${o.expiresAt ?? null})
          ON CONFLICT (relay_id, sha256, pubkey) DO UPDATE SET
            size = excluded.size, type = excluded.type,
            uploaded_at = excluded.uploaded_at, expires_at = excluded.expires_at`,
      ),
    );
  }

  async removeOwner(relayId: RelayId, sha256: string, pubkey: string): Promise<boolean> {
    const n = await this.x.run(
      this.x.compile(
        sql`DELETE FROM blob_owners WHERE relay_id = ${relayId} AND sha256 = ${sha256} AND pubkey = ${pubkey}`,
      ),
    );
    return n > 0;
  }

  owners(relayId: RelayId, sha256: string): Promise<BlobOwnership[]> {
    return this.rows(
      sql`SELECT ${COLS} FROM blob_owners WHERE relay_id = ${relayId} AND sha256 = ${sha256}
        ORDER BY uploaded_at, pubkey`,
    );
  }

  listByOwner(
    relayId: RelayId,
    pubkey: string,
    opts?: { since?: number; until?: number; limit?: number },
  ): Promise<BlobOwnership[]> {
    const parts: SQL[] = [sql`relay_id = ${relayId}`, sql`pubkey = ${pubkey}`];
    if (opts?.since !== undefined) parts.push(sql`uploaded_at >= ${opts.since}`);
    if (opts?.until !== undefined) parts.push(sql`uploaded_at <= ${opts.until}`);
    return this.rows(
      sql`SELECT ${COLS} FROM blob_owners WHERE ${sql.join(parts, sql` AND `)}
        ORDER BY uploaded_at DESC, sha256 ASC LIMIT ${opts?.limit ?? 1000}`,
    );
  }

  async list(
    relayId: RelayId,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: BlobOwnership[]; cursor?: string }> {
    const limit = Math.max(0, opts?.limit ?? 100);
    const parts: SQL[] = [sql`relay_id = ${relayId}`];
    if (opts?.cursor) {
      // Cursor = sha256 (64 hex) + pubkey of the last item.
      const sha = opts.cursor.slice(0, 64);
      const pk = opts.cursor.slice(64);
      parts.push(sql`(sha256 > ${sha} OR (sha256 = ${sha} AND pubkey > ${pk}))`);
    }
    const rows = await this.rows(
      sql`SELECT ${COLS} FROM blob_owners WHERE ${sql.join(parts, sql` AND `)}
        ORDER BY sha256, pubkey LIMIT ${limit + 1}`,
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, cursor: rows.length > limit && last ? last.sha256 + last.pubkey : undefined };
  }

  async usage(relayId: RelayId, pubkey: string): Promise<number> {
    const rows = await this.x.all(
      this.x.compile(
        sql`SELECT COALESCE(SUM(size), 0) AS n FROM blob_owners WHERE relay_id = ${relayId} AND pubkey = ${pubkey}`,
      ),
    );
    return num(rows[0]?.n ?? 0);
  }

  async refCount(sha256: string): Promise<number> {
    const rows = await this.x.all(
      this.x.compile(sql`SELECT COUNT(*) AS n FROM blob_owners WHERE sha256 = ${sha256}`),
    );
    return num(rows[0]?.n ?? 0);
  }

  expired(now: number, limit: number): Promise<BlobOwnership[]> {
    return this.rows(
      sql`SELECT ${COLS} FROM blob_owners WHERE expires_at IS NOT NULL AND expires_at <= ${now}
        ORDER BY expires_at LIMIT ${limit}`,
    );
  }
}
