// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bun-only helpers (SQLite file snapshots, pg_dump). Loaded with a non-literal
 * dynamic import only when running on Bun, so Worker bundles never see
 * `bun:sqlite` or `node:*` (same pattern as storage-sql's factory).
 */
import type { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Row, type SqlExecLike, type SqlQuery, type TableSource, dumpTables } from './sql.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'beamhop-backup-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Online, consistent SQLite snapshot via `VACUUM INTO` (compact, WAL-safe). */
export function snapshotSqlite(x: SqlExecLike): Promise<Uint8Array> {
  return withTmp(async (dir) => {
    const path = join(dir, 'snapshot.sqlite');
    await x.run({ sql: 'VACUUM INTO ?', params: [path] });
    return new Uint8Array(await readFile(path));
  });
}

function dbExec(db: Database): SqlExecLike {
  const all = (q: SqlQuery) => db.query(q.sql).all(...(q.params as never[])) as Row[];
  const run = (q: SqlQuery) => db.query(q.sql).run(...(q.params as never[])).changes;
  return {
    dialect: 'sqlite',
    driver: 'sqlite',
    all: async (q) => all(q),
    run: async (q) => run(q),
    batch: async (stmts) => stmts.map((s) => run(s)),
    sync: { all, run, transaction: (fn) => db.transaction(fn)() },
  };
}

/** Read every table of a SQLite snapshot file (as stored in an archive). */
export function readSqliteSnapshot(bytes: Uint8Array): Promise<TableSource> {
  return withTmp(async (dir) => {
    const path = join(dir, 'restore.sqlite');
    await writeFile(path, bytes);
    const spec = 'bun:sqlite';
    const { Database: Db } = (await import(spec)) as typeof import('bun:sqlite');
    const db = new Db(path, { readonly: true });
    try {
      const dumps = await dumpTables(dbExec(db));
      const map = new Map(dumps.map((d) => [d.table, d.rows]));
      return { tables: () => [...map.keys()], rows: (t) => map.get(t) ?? [] };
    } finally {
      db.close();
    }
  });
}

/** `pg_dump` (plain SQL) when the binary is on PATH, else null. */
export async function pgDump(url: string): Promise<Uint8Array | null> {
  const bin = Bun.which('pg_dump');
  if (!bin) return null;
  // Keep the password off the command line (visible in `ps`): pass it via PGPASSWORD.
  const env: Record<string, string | undefined> = { ...process.env };
  let target = url;
  try {
    const u = new URL(url);
    if (u.password) {
      env.PGPASSWORD = decodeURIComponent(u.password);
      u.password = '';
      target = u.toString();
    }
  } catch {
    // Not a URL (e.g. a libpq keyword string): pass through unchanged.
  }
  const proc = Bun.spawn([bin, '--format=plain', '--no-owner', '--no-privileges', target], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`pg_dump failed (${code}): ${err.slice(0, 300)}`);
  }
  return new Uint8Array(out);
}
