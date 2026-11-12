import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, DbSwappedEvent, DbWritePhase, Logger, Migration, NamespaceMigrations, SwitchableDb } from "@beamhop/sdk";
import { DbSwitchingError } from "@beamhop/sdk";

export interface SwappableDbOptions {
  /** how long a write issued while paused waits for resume before rejecting with DbSwitchingError; default 2000 ms */
  pauseWaitMs?: number;
  logger?: Logger;
}

interface Hook<F> {
  fn: F;
  name?: string;
}

/** Async context of work that passes the write gate (a transaction or a switch hook); live only while it runs. */
interface Ungated {
  live: boolean;
}

/** Leading whitespace and SQL comments. */
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const WRITE_VERB = /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const WRITE_ANYWHERE = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** Whether a statement passed to all()/get() modifies data (INSERT/UPDATE/DELETE/REPLACE, or a WITH containing one). */
export function isWriteSql(sql: string): boolean {
  const body = sql.replace(LEADING_NOISE, "");
  if (WRITE_VERB.test(body)) return true;
  return /^WITH\b/i.test(body) && WRITE_ANYWHERE.test(body);
}

/**
 * Db wrapper whose inner database can be replaced at runtime (see SwitchableDb in @beamhop/sdk).
 *
 * Write gate: while paused, writes (run/exec/tx/migrate, and all/get running a data-modifying statement) wait up to
 * `pauseWaitMs` for resume, then reject with DbSwitchingError. Reads always flow. Statements issued from inside a
 * transaction started through the wrapper, or from inside a switch hook, are not gated (the transaction already holds
 * its place; hooks run while paused on purpose).
 */
export class SwappableDb implements SwitchableDb {
  private _phase: DbWritePhase = "normal";
  /** write calls and transactions started through the gate that have not settled yet */
  private inflight = 0;
  private drainWaiters: (() => void)[] = [];
  private resumeWaiters = new Set<() => void>();
  private readonly ungated = new AsyncLocalStorage<Ungated>();
  private readonly migrations = new Map<string, Migration[]>();
  private beforeFinalCopyHooks: Hook<() => void | Promise<void>>[] = [];
  private swappedHooks: Hook<(e: DbSwappedEvent) => void | Promise<void>>[] = [];
  private phaseListeners = new Set<(phase: DbWritePhase) => void>();
  private readonly pauseWaitMs: number;

  constructor(
    private inner: Db,
    private readonly opts: SwappableDbOptions = {},
  ) {
    this.pauseWaitMs = opts.pauseWaitMs ?? 2000;
  }

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
    return this._phase;
  }

  // ------------------------------------------------------------------ Db

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!isWriteSql(sql)) return this.inner.all<T>(sql, params);
    return this.gated(() => this.inner.all<T>(sql, params));
  }
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
    if (!isWriteSql(sql)) return this.inner.get<T>(sql, params);
    return this.gated(() => this.inner.get<T>(sql, params));
  }
  run(sql: string, params?: unknown[]) {
    return this.gated(() => this.inner.run(sql, params));
  }
  exec(sql: string) {
    return this.gated(() => this.inner.exec(sql));
  }
  /** fn receives the inner database's transaction handle: its statements bypass the gate. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.gated(() => {
      const ctx: Ungated = { live: true };
      return this.ungated.run(ctx, () => this.inner.tx(fn)).finally(() => {
        ctx.live = false;
      });
    });
  }
  migrate(namespace: string, migrations: Migration[]) {
    // the latest list per namespace; Map keeps the namespace's first-seen position
    this.migrations.set(namespace, [...migrations]);
    return this.gated(() => this.inner.migrate(namespace, migrations));
  }
  close() {
    return this.inner.close();
  }

  // ------------------------------------------------------------------ gate

  private isUngated(): boolean {
    return this.ungated.getStore()?.live === true;
  }

  private gated<T>(op: () => Promise<T>): Promise<T> {
    if (this.isUngated()) return op();
    if (this._phase === "normal") return this.track(op);
    return this.waitForResume().then(() => this.track(op));
  }

  private track<T>(op: () => Promise<T>): Promise<T> {
    this.inflight++;
    let p: Promise<T>;
    try {
      p = op();
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.finally(() => {
      this.inflight--;
      if (this.inflight === 0 && this.drainWaiters.length) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const w of waiters) w();
      }
    });
  }

  /** Resolves once writes may flow (phase "normal" when checked synchronously), or rejects after pauseWaitMs. */
  private waitForResume(): Promise<void> {
    const deadline = Date.now() + this.pauseWaitMs;
    return new Promise<void>((resolve, reject) => {
      const attempt = () => {
        if (this._phase === "normal") return resolve();
        const left = deadline - Date.now();
        if (left <= 0) return reject(new DbSwitchingError());
        const timer = setTimeout(() => {
          this.resumeWaiters.delete(wake);
          reject(new DbSwitchingError());
        }, left);
        const wake = () => {
          clearTimeout(timer);
          this.resumeWaiters.delete(wake);
          attempt();
        };
        this.resumeWaiters.add(wake);
      };
      attempt();
    });
  }

  private setPhase(phase: DbWritePhase) {
    if (this._phase === phase) return;
    this._phase = phase;
    for (const fn of [...this.phaseListeners]) {
      try {
        fn(phase);
      } catch (err) {
        this.opts.logger?.error("database phase listener failed", { err: String(err) });
      }
    }
  }

  async pauseWrites(): Promise<void> {
    this.setPhase("paused");
    if (this.inflight === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  resumeWrites(): void {
    this.setPhase("normal");
    for (const wake of [...this.resumeWaiters]) wake();
  }

  // ------------------------------------------------------------------ switching

  registeredMigrations(): NamespaceMigrations[] {
    return [...this.migrations].map(([namespace, migrations]) => ({ namespace, migrations: [...migrations] }));
  }

  /** Runs `fn` so that what it does through this wrapper passes the write gate. */
  private runUngated<T>(fn: () => Promise<T>): Promise<T> {
    const ctx: Ungated = { live: true };
    return this.ungated.run(ctx, fn).finally(() => {
      ctx.live = false;
    });
  }

  private requirePaused(what: string) {
    if (this._phase !== "paused") throw new Error(`${what} requires paused writes`);
  }

  async runBeforeFinalCopy(): Promise<void> {
    this.requirePaused("runBeforeFinalCopy");
    await this.runUngated(async () => {
      for (const h of [...this.beforeFinalCopyHooks]) await h.fn();
    });
  }

  async swap(next: Db): Promise<Db> {
    this.requirePaused("swap");
    const prev = this.inner;
    this.inner = next;
    const forward: DbSwappedEvent = { from: prev.dialect, to: next.dialect };
    try {
      await this.runUngated(async () => {
        for (const h of [...this.swappedHooks]) await h.fn(forward);
      });
    } catch (err) {
      this.opts.logger?.error("database swap hook failed; switching back", { err: String(err) });
      this.inner = prev;
      const back: DbSwappedEvent = { from: next.dialect, to: prev.dialect };
      await this.runUngated(async () => {
        for (const h of [...this.swappedHooks]) {
          try {
            await h.fn(back);
          } catch (e) {
            this.opts.logger?.error("database swap hook failed while switching back", { hook: h.name, err: String(e) });
          }
        }
      });
      throw err;
    }
    return prev;
  }

  onBeforeFinalCopy(fn: () => void | Promise<void>, name?: string): () => void {
    const h = { fn, name };
    this.beforeFinalCopyHooks.push(h);
    return () => {
      this.beforeFinalCopyHooks = this.beforeFinalCopyHooks.filter((x) => x !== h);
    };
  }

  onSwapped(fn: (e: DbSwappedEvent) => void | Promise<void>, name?: string): () => void {
    const h = { fn, name };
    this.swappedHooks.push(h);
    return () => {
      this.swappedHooks = this.swappedHooks.filter((x) => x !== h);
    };
  }

  onPhase(fn: (phase: DbWritePhase) => void): () => void {
    this.phaseListeners.add(fn);
    return () => this.phaseListeners.delete(fn);
  }
}
