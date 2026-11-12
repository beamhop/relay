/**
 * Test doubles for runtime database switching, shared by the package tests (core, blossom, metrics, admin-api,
 * server): a DbSwitchHooks whose phase the test drives, and a Db wrapper that refuses writes while it is "paused"
 * (like the real switchable wrapper does once its wait runs out).
 */
import { ConfigSchema, DbSwitchingError, type Db, type DbSwappedEvent, type DbSwitchHooks, type DbWritePhase, type Migration, type Stores } from "@beamhop/sdk";
import { createMemoryDb, createStores, silentLogger, type StorageStores } from "@beamhop/storage";

type Hook<T> = { fn: T; name?: string };

export class FakeDbSwitch implements DbSwitchHooks {
  phase: DbWritePhase = "normal";
  retryAfterSec = 5;
  readonly before: Hook<() => void | Promise<void>>[] = [];
  readonly swapped: Hook<(e: DbSwappedEvent) => void | Promise<void>>[] = [];
  private readonly phaseFns = new Set<(p: DbWritePhase) => void>();

  onBeforeFinalCopy(fn: () => void | Promise<void>, name?: string) {
    const h = { fn, name };
    this.before.push(h);
    return () => {
      const i = this.before.indexOf(h);
      if (i >= 0) this.before.splice(i, 1);
    };
  }
  onSwapped(fn: (e: DbSwappedEvent) => void | Promise<void>, name?: string) {
    const h = { fn, name };
    this.swapped.push(h);
    return () => {
      const i = this.swapped.indexOf(h);
      if (i >= 0) this.swapped.splice(i, 1);
    };
  }
  onPhase(fn: (p: DbWritePhase) => void) {
    this.phaseFns.add(fn);
    return () => void this.phaseFns.delete(fn);
  }
  pause() {
    this.setPhase("paused");
  }
  resume() {
    this.setPhase("normal");
  }
  private setPhase(p: DbWritePhase) {
    this.phase = p;
    for (const fn of [...this.phaseFns]) fn(p);
  }
  /** Runs the onBeforeFinalCopy hooks with writes allowed (the real wrapper lets them through). */
  async runBeforeFinalCopy() {
    const was = this.phase;
    this.phase = "normal";
    try {
      for (const h of [...this.before]) await h.fn();
    } finally {
      this.phase = was;
    }
  }
  async runSwapped(e: DbSwappedEvent = { from: "sqlite", to: "postgres" }) {
    for (const h of [...this.swapped]) await h.fn(e);
  }
  error() {
    return new DbSwitchingError(undefined, this.retryAfterSec);
  }
}

/** `inner`, refusing run/exec/tx/migrate with DbSwitchingError while `sw` is paused. Reads go through. */
export function pausableDb(inner: Db, sw: FakeDbSwitch): Db {
  const guard = () => {
    if (sw.phase === "paused") throw sw.error();
  };
  const wrap = (db: Db): Db => ({
    get dialect() {
      return db.dialect;
    },
    get inTxContext() {
      return (db as { inTxContext?: boolean }).inTxContext;
    },
    all: (sql, params) => db.all(sql, params),
    get: (sql, params) => db.get(sql, params),
    run: async (sql, params) => (guard(), db.run(sql, params)),
    exec: async (sql) => (guard(), db.exec(sql)),
    tx: async (fn) => (guard(), db.tx((t) => fn(wrap(t)))),
    migrate: async (ns: string, m: Migration[]) => (guard(), db.migrate(ns, m)),
    close: () => db.close(),
  } as Db);
  return wrap(inner);
}

/** Real (in-memory SQLite) stores over a pausable Db, with `dbSwitch` set to a fake the test drives. */
export async function switchableTestStores(): Promise<{ stores: StorageStores & Stores; sw: FakeDbSwitch }> {
  const sw = new FakeDbSwitch();
  const config = ConfigSchema.parse({ database: { driver: "sqlite", sqlitePath: ":memory:" } });
  const stores = await createStores(config, silentLogger, { db: pausableDb(await createMemoryDb(), sw) });
  (stores as { dbSwitch?: DbSwitchHooks }).dbSwitch = sw;
  return { stores, sw };
}
