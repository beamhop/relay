import type { Db, DbSwappedEvent, DbWritePhase, Logger, Migration, NamespaceMigrations, SwitchableDb } from "@beamhop/sdk";

export interface SwappableDbOptions {
  /** how long a write issued while paused waits for resume before rejecting with DbSwitchingError; default 2000 ms */
  pauseWaitMs?: number;
  logger?: Logger;
}

/**
 * Db wrapper whose inner database can be replaced at runtime (see SwitchableDb in @beamhop/sdk).
 * CONTRACT STUB: implemented on the storage-core branch.
 */
export class SwappableDb implements SwitchableDb {
  constructor(
    private inner: Db,
    private readonly opts: SwappableDbOptions = {},
  ) {}
  get current(): Db {
    return this.inner;
  }
  get dialect() {
    return this.inner.dialect;
  }
  /** forwarded sqlite transaction-context probe (events group commit relies on it) */
  get inTxContext(): boolean | undefined {
    return (this.inner as { inTxContext?: boolean }).inTxContext;
  }
  get phase(): DbWritePhase {
    return "normal";
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
  close() {
    return this.inner.close();
  }
  registeredMigrations(): NamespaceMigrations[] {
    throw new Error("not implemented");
  }
  pauseWrites(): Promise<void> {
    throw new Error("not implemented");
  }
  resumeWrites(): void {
    throw new Error("not implemented");
  }
  runBeforeFinalCopy(): Promise<void> {
    throw new Error("not implemented");
  }
  swap(_next: Db): Promise<Db> {
    throw new Error("not implemented");
  }
  onBeforeFinalCopy(_fn: () => void | Promise<void>, _name?: string): () => void {
    return () => {};
  }
  onSwapped(_fn: (e: DbSwappedEvent) => void | Promise<void>, _name?: string): () => void {
    return () => {};
  }
  onPhase(_fn: (phase: DbWritePhase) => void): () => void {
    return () => {};
  }
}
