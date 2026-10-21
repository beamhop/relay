// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime migrator (no drizzle-kit, no filesystem): applies embedded Drizzle Kit
 * SQL on bun:sqlite, D1 and Postgres, tracked in `__beamhop_migrations`.
 *
 * Other modules (e.g. enterprise) contribute their own tables with
 * `registerMigrations()` at module load; `migrate()` applies every registered
 * set in `order`, then registration order. Each migration (its statements plus
 * its bookkeeping row) is applied atomically.
 */
import { sql } from 'drizzle-orm';
import type { Dialect, SqlExec, Stmt } from './exec/types.ts';
import { pgMigrations, sqliteMigrations } from './migrations/generated.ts';

export interface SqlMigration {
  /** Unique within its module; applied in array order. */
  tag: string;
  /** Statements separated by `--> statement-breakpoint` (Drizzle Kit format). */
  sql: string;
}

export interface MigrationSet {
  /** Owner, e.g. `storage-sql`, `enterprise-compliance`. */
  module: string;
  /** Lower runs first. Core storage is 0; default 100. */
  order?: number;
  sqlite?: SqlMigration[];
  pg?: SqlMigration[];
}

export const CORE_MIGRATIONS_MODULE = 'storage-sql';
export const MIGRATIONS_TABLE = '__beamhop_migrations';

const registry = new Map<string, MigrationSet>();

/** Register (or replace) a module's migrations. Returns an unregister function. */
export function registerMigrations(set: MigrationSet): () => void {
  registry.delete(set.module); // re-registering moves it to the end
  registry.set(set.module, set);
  return () => {
    if (registry.get(set.module) === set) registry.delete(set.module);
  };
}

export function registeredMigrations(): MigrationSet[] {
  const all = [...registry.values()];
  return all
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? 100) - (b.s.order ?? 100) || a.i - b.i)
    .map(({ s }) => s);
}

registerMigrations({
  module: CORE_MIGRATIONS_MODULE,
  order: 0,
  sqlite: sqliteMigrations,
  pg: pgMigrations,
});

/** Split Drizzle Kit SQL into statements, dropping comment-only chunks. */
export function splitStatements(text: string): string[] {
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) =>
      s.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')),
    );
}

/** FNV-1a: cheap drift detection without WebCrypto (sync, runtime-agnostic). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface MigrateOptions {
  /** Defaults to every registered set. */
  sets?: MigrationSet[];
  now?: () => number;
}

export interface MigrateResult {
  /** `module/tag` of migrations applied by this call. */
  applied: string[];
}

function migrationsFor(set: MigrationSet, dialect: Dialect): SqlMigration[] {
  return (dialect === 'pg' ? set.pg : set.sqlite) ?? [];
}

export async function migrate(x: SqlExec, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const now = opts.now ?? (() => Date.now());
  const bigint = x.dialect === 'pg' ? 'BIGINT' : 'INTEGER';
  await x.run(
    x.compile(
      sql.raw(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        module TEXT NOT NULL,
        tag TEXT NOT NULL,
        hash TEXT NOT NULL,
        applied_at ${bigint} NOT NULL,
        PRIMARY KEY (module, tag)
      )`),
    ),
  );
  const appliedRows = await x.all(
    x.compile(sql.raw(`SELECT module, tag FROM ${MIGRATIONS_TABLE}`)),
  );
  const done = new Set(appliedRows.map((r) => `${r.module}/${r.tag}`));
  // D1 deployments may apply migrations/sqlite with `wrangler d1 migrations apply`
  // (tracked in `d1_migrations` by file name): treat those as applied here.
  if (x.dialect === 'sqlite') {
    const hasWrangler = await x.all(
      x.compile(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'`,
      ),
    );
    if (hasWrangler.length) {
      const rows = await x.all(x.compile(sql`SELECT name FROM d1_migrations`));
      for (const r of rows) {
        done.add(`${CORE_MIGRATIONS_MODULE}/${String(r.name).replace(/\.sql$/, '')}`);
      }
    }
  }
  const applied: string[] = [];

  for (const set of opts.sets ?? registeredMigrations()) {
    for (const m of migrationsFor(set, x.dialect)) {
      const id = `${set.module}/${m.tag}`;
      if (done.has(id)) continue;
      const stmts: Stmt[] = [];
      // Postgres: serialize concurrent migrators (released at commit).
      if (x.dialect === 'pg') {
        stmts.push({
          ...x.compile(sql`SELECT pg_advisory_xact_lock(${0x6265616d})`),
          returning: true,
        });
      }
      // Bookkeeping first: a concurrent migrator fails fast on the primary key.
      stmts.push(
        x.compile(
          sql`INSERT INTO ${sql.raw(MIGRATIONS_TABLE)} (module, tag, hash, applied_at)
            VALUES (${set.module}, ${m.tag}, ${hash(m.sql)}, ${now()})`,
        ),
      );
      for (const s of splitStatements(m.sql)) stmts.push({ sql: s, params: [] });
      try {
        await x.batch(stmts);
      } catch (err) {
        // Lost a race with another node? Then it is applied; otherwise rethrow.
        const rows = await x.all(
          x.compile(
            sql`SELECT 1 AS ok FROM ${sql.raw(MIGRATIONS_TABLE)} WHERE module = ${set.module} AND tag = ${m.tag}`,
          ),
        );
        if (rows.length === 0) throw err;
        continue;
      }
      done.add(id);
      applied.push(id);
    }
  }
  return { applied };
}
