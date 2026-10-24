import type { BeamhopConfig, Db, Logger, Migration, Stores } from "@beamhop/sdk";
import { createDb } from "./db";
import { SqlEventStore } from "./events";
import { FTS_MIGRATION_ID, NAMESPACE, sqliteFtsReady, sqliteHasFts5, storageMigrations } from "./migrations";
import { SqlAuditLog, SqlInviteStore, SqlIpRuleStore, SqlKvStore } from "./misc";
import { SqlUserStore, type UserStoreOptions } from "./users";

/** sqlite: how often planner statistics are refreshed (`PRAGMA optimize`). */
export const SQLITE_OPTIMIZE_INTERVAL_MS = 60 * 60_000;

export interface CreateStoresOptions {
  /** reuse an existing Db (otherwise created from config.database) */
  db?: Db;
  users?: UserStoreOptions;
}

export interface StorageStores extends Stores {
  events: SqlEventStore;
  users: SqlUserStore;
  kv: SqlKvStore;
  /** writes buffered data (user activity) to the database */
  flush(): Promise<void>;
  /** flushes and closes the database (same as `db.close()`) */
  close(): Promise<void>;
}

/** Db wrapper whose close() first runs a hook (flushing buffered writes). */
class ManagedDb implements Db {
  constructor(
    private inner: Db,
    private beforeClose: () => Promise<void>,
  ) {}
  get dialect() {
    return this.inner.dialect;
  }
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return this.inner.all<T>(sql, params);
  }
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return this.inner.get<T>(sql, params);
  }
  run(sql: string, params?: unknown[]) {
    return this.inner.run(sql, params);
  }
  exec(sql: string) {
    return this.inner.exec(sql);
  }
  tx<T>(fn: (db: Db) => Promise<T>) {
    return this.inner.tx(fn);
  }
  migrate(namespace: string, migrations: Migration[]) {
    return this.inner.migrate(namespace, migrations);
  }
  private closing: Promise<void> | null = null;
  close() {
    this.closing ??= (async () => {
      try {
        await this.beforeClose();
      } finally {
        await this.inner.close();
      }
    })();
    return this.closing;
  }
}

export async function createStores(config: BeamhopConfig, logger: Logger, opts: CreateStoresOptions = {}): Promise<StorageStores> {
  const log = logger.child("storage");
  const raw = opts.db ?? (await createDb(config));
  let fts = raw.dialect === "postgres";
  if (raw.dialect === "sqlite") {
    const available = await sqliteHasFts5(raw);
    if (!available) log.warn("sqlite build lacks FTS5; NIP-50 search falls back to LIKE matching");
    await raw.migrate(NAMESPACE, storageMigrations(available));
    fts = available && (await sqliteFtsReady(raw));
    if (available && !fts) log.warn(`migration ${FTS_MIGRATION_ID} not applied; search falls back to LIKE`);
  } else {
    await raw.migrate(NAMESPACE, storageMigrations(true));
  }

  const users = new SqlUserStore(raw, log.child("users"), opts.users);
  // A fresh database has no planner stats until something runs ANALYZE; refresh them periodically
  // (cheap when nothing changed) instead of only at startup/shutdown.
  const optimizer =
    raw.dialect === "sqlite"
      ? setInterval(() => void raw.exec("PRAGMA optimize=0x10002").catch((err) => log.debug("PRAGMA optimize failed", { err: String(err) })), SQLITE_OPTIMIZE_INTERVAL_MS)
      : undefined;
  (optimizer as { unref?: () => void } | undefined)?.unref?.();
  const db = new ManagedDb(raw, async () => {
    clearInterval(optimizer);
    await users.close();
    if (raw.dialect === "sqlite") await raw.exec("PRAGMA optimize").catch(() => {});
  });
  const events = new SqlEventStore(raw, log.child("events"), { fts });
  await events.init();

  return {
    db,
    events,
    users,
    invites: new SqlInviteStore(raw),
    ipRules: new SqlIpRuleStore(raw),
    kv: new SqlKvStore(raw),
    audit: new SqlAuditLog(raw),
    flush: () => users.flush(),
    close: () => db.close(),
  };
}
