import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  DELETE_ROLLBACK_CONFIRM_PHRASE,
  WIPE_CONFIRM_PHRASE,
  type DatabaseInstanceInfo,
  type DatabaseRollbackPoint,
  type DatabaseStateFile,
  type DatabaseStatus,
  type DatabaseSwitcher,
  type DatabaseSwitchJobView,
  type DatabaseSwitchPhase,
  type DatabaseSwitchRequest,
  type DatabaseTarget,
  type DatabaseTestResult,
  type Db,
  type Logger,
  type NamespaceMigrations,
  type SwitchableDb,
  type TableProgress,
} from "@beamhop/sdk";
import type { SqliteOptions } from "./db";
import {
  DatabaseCopier,
  inspectDatabase,
  openDatabase,
  prepareSchema,
  wipeDatabase,
  type DatabaseInspection,
  type TransferOptions,
  type VerifyReport,
} from "./transfer";

/** What the switcher needs from a copier (DatabaseCopier, or a fake in tests). */
export interface DatabaseCopierLike {
  progress(): TableProgress[];
  bulkCopy(): Promise<void>;
  finalCopy(): Promise<void>;
  verify(): Promise<VerifyReport>;
}

/** The database operations the switcher runs; defaults to the real ones from ./transfer (tests inject fakes). */
export interface DatabaseSwitcherOps {
  openDatabase(target: DatabaseTarget, sqlite?: SqliteOptions): Promise<Db>;
  inspectDatabase(db: Db, target?: DatabaseTarget): Promise<DatabaseInspection>;
  wipeDatabase(db: Db): Promise<void>;
  prepareSchema(target: Db, namespaces: NamespaceMigrations[]): Promise<void>;
  createCopier(source: Db, target: Db, opts: TransferOptions): DatabaseCopierLike;
  /** deletes a file if it exists (sqlite rollback files and their -wal/-shm/-journal siblings) */
  removeFile(path: string): Promise<void>;
}

export const defaultSwitcherOps: DatabaseSwitcherOps = {
  openDatabase,
  inspectDatabase,
  wipeDatabase,
  prepareSchema,
  createCopier: (source, target, opts) => new DatabaseCopier(source, target, opts),
  removeFile: (path) => rm(path, { force: true }),
};

export interface DatabaseSwitcherDeps {
  db: SwitchableDb;
  logger: Logger;
  /** the database the server runs on at startup */
  initial: DatabaseTarget;
  /** env vars pin the database: switching is refused */
  envPinned: boolean;
  /**
   * postgres URL from env/config, offered as a prefill (unredacted; the switcher redacts it in views). A target with
   * `postgresUrl: "env"` (or the redacted prefill sent back unchanged) means this URL.
   */
  defaultPostgresUrl?: string;
  readState(): DatabaseStateFile | undefined;
  writeState(state: DatabaseStateFile): Promise<void>;
  /** live instances on the current database (heartbeats), including this one */
  instances(): Promise<DatabaseInstanceInfo[]>;
  /** audit entry; written to the database current at the time of the call */
  audit(entry: { actor: string; action: string; target: string | null; details: Record<string, unknown> }): Promise<void>;
  /** called after a successful switch (e.g. to update config.database) */
  onSwitched?(target: DatabaseTarget): void;
  /** longest write pause before the switch gives up and resumes on the old database; default 15000 ms */
  pauseBudgetMs?: number;
  sqlite?: SqliteOptions;
  /** database operations (tests inject fakes); each one missing falls back to the real implementation */
  ops?: Partial<DatabaseSwitcherOps>;
  /** clock (ms), for tests */
  now?: () => number;
}

/** The switcher plus `whenIdle()` (resolves once no job is running: tests, shutdown). */
export interface DatabaseSwitcherService extends DatabaseSwitcher {
  whenIdle(): Promise<void>;
}

/** A refusal or failure with a message meant for the admin; `code` lets the admin API pick the HTTP status. */
export class DatabaseSwitchRefusedError extends Error {
  constructor(
    message: string,
    readonly code: "db_switch_refused" | "db_switch_busy" | "db_target_invalid" | "db_confirm_mismatch" | "db_target_not_empty" | "db_rollback_not_found",
  ) {
    super(message);
    this.name = "DatabaseSwitchRefusedError";
  }
}

const REDACTED = "***";

/** `postgres://user:secret@host/db?password=x` → `postgres://user:***@host/db?password=***`. */
export function redactPostgresUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/?#]*):(.*)@(?=[^@]*$)/i, `$1:${REDACTED}@`)
    .replace(/([?&](?:password|sslpassword)=)[^&#]*/gi, `$1${REDACTED}`);
}

/** The target as shown to admins and written to logs/audit (postgres password redacted). */
export function redactTarget(t: DatabaseTarget): DatabaseTarget {
  return t.driver === "postgres" ? { driver: "postgres", postgresUrl: t.postgresUrl ? redactPostgresUrl(t.postgresUrl) : undefined } : { driver: "sqlite", sqlitePath: t.sqlitePath };
}

/** One-line description for logs and audit details. */
export function describeTarget(t: DatabaseTarget): string {
  return t.driver === "postgres" ? redactPostgresUrl(t.postgresUrl ?? "") : `sqlite:${t.sqlitePath ?? ""}`;
}

function postgresPassword(url: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^:@/?#]*:(.*)@(?=[^@]*$)/i.exec(url);
  const q = /[?&]password=([^&#]*)/i.exec(url);
  return m?.[1] || q?.[1] || undefined;
}

/** Removes a target's postgres URL / password from an error message (drivers sometimes quote the connection string). */
function scrub(message: string, ...targets: (DatabaseTarget | undefined)[]): string {
  let out = message;
  for (const t of targets) {
    if (t?.driver !== "postgres" || !t.postgresUrl) continue;
    out = out.split(t.postgresUrl).join(redactPostgresUrl(t.postgresUrl));
    const pw = postgresPassword(t.postgresUrl);
    if (pw && pw.length >= 3) {
      out = out.split(pw).join(REDACTED);
      try {
        const decoded = decodeURIComponent(pw);
        if (decoded.length >= 3) out = out.split(decoded).join(REDACTED);
      } catch {
        /* not percent-encoded */
      }
    }
  }
  return out;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** host:port/database of a postgres URL (credentials and options ignored), for "same database" checks. */
function postgresKey(url: string): string {
  try {
    const u = new URL(url);
    const host = (u.hostname || u.searchParams.get("host") || "localhost").toLowerCase();
    const db = decodeURIComponent(u.pathname.replace(/^\//, "")) || decodeURIComponent(u.username);
    return `${host}:${u.port || "5432"}/${db}`;
  } catch {
    return redactPostgresUrl(url).replace(/\/\/[^@/]*@/, "//").toLowerCase();
  }
}

const sqliteSiblings = (path: string) => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];

/** Whether two targets name the same database (sqlite: the same file, or one's -wal/-shm/-journal; postgres: host, port and database). */
export function sameDatabase(a: DatabaseTarget, b: DatabaseTarget): boolean {
  if (a.driver !== b.driver) return false;
  if (a.driver === "sqlite") {
    if (!a.sqlitePath || !b.sqlitePath) return false;
    const x = resolve(a.sqlitePath);
    const y = resolve(b.sqlitePath);
    return sqliteSiblings(x).includes(y) || sqliteSiblings(y).includes(x);
  }
  return !!a.postgresUrl && !!b.postgresUrl && postgresKey(a.postgresUrl) === postgresKey(b.postgresUrl);
}

const TERMINAL: ReadonlySet<DatabaseSwitchPhase> = new Set(["done", "failed", "cancelled"]);

interface Job {
  id: string;
  from: DatabaseTarget;
  to: DatabaseTarget;
  phase: DatabaseSwitchPhase;
  startedAt: number;
  finishedAt?: number;
  tables: TableProgress[];
  pauseStartedAt?: number;
  pausedMs?: number;
  error?: string;
  cancellable: boolean;
  actor: string;
  controller: AbortController;
  copier?: DatabaseCopierLike;
}

class StepTimeout extends Error {}
class Cancelled extends Error {}

export const TOO_MANY_CHANGES =
  "too many changes during the final copy, try again at a quieter time (writes were paused too long, so the switch was abandoned; the current database is unchanged)";

export function createDatabaseSwitcher(deps: DatabaseSwitcherDeps): DatabaseSwitcherService {
  const ops: DatabaseSwitcherOps = { ...defaultSwitcherOps, ...deps.ops };
  const log = deps.logger.child("db-switch");
  const now = deps.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const budgetMs = deps.pauseBudgetMs ?? 15_000;
  let current: DatabaseTarget = { ...deps.initial };
  let job: Job | undefined;
  /** set while a start() runs its preflight or a job runs: one switch at a time */
  let busy = false;
  let running: Promise<void> = Promise.resolve();

  /** the copier's own progress when it has any (onProgress may lag behind its last update), else the last reported */
  const liveTables = (j: Job): TableProgress[] => {
    const live = j.copier?.progress();
    return live?.length ? live : j.tables;
  };
  const view = (j: Job): DatabaseSwitchJobView => ({
    id: j.id,
    from: redactTarget(j.from),
    to: redactTarget(j.to),
    phase: j.phase,
    startedAt: j.startedAt,
    ...(j.finishedAt !== undefined ? { finishedAt: j.finishedAt } : {}),
    tables: liveTables(j).map((t) => ({ ...t })),
    ...(j.pauseStartedAt !== undefined ? { pausedMs: j.pausedMs ?? now() - j.pauseStartedAt } : {}),
    ...(j.error !== undefined ? { error: j.error } : {}),
    cancellable: j.cancellable,
    actor: j.actor,
  });

  const audit = async (actor: string, action: string, details: Record<string, unknown>) => {
    try {
      await deps.audit({ actor, action, target: null, details });
    } catch (err) {
      log.warn("audit write failed", { action, error: errMsg(err) });
    }
  };

  const readState = (): DatabaseStateFile | undefined => {
    try {
      return deps.readState();
    } catch (err) {
      log.error("database state file unreadable", { error: errMsg(err) });
      return undefined;
    }
  };

  /** `postgresUrl: "env"` (or the redacted prefill sent back unchanged) → the env/config URL; sqlite paths must be absolute. */
  function resolveTarget(t: DatabaseTarget): DatabaseTarget {
    if (t.driver === "postgres") {
      let url = t.postgresUrl?.trim();
      const def = deps.defaultPostgresUrl;
      if (url === "env" || (def && url === redactPostgresUrl(def))) {
        if (!def) throw new DatabaseSwitchRefusedError("no Postgres URL is configured in the environment or config", "db_target_invalid");
        url = def;
      }
      if (!url || !/^postgres(ql)?:\/\//i.test(url)) throw new DatabaseSwitchRefusedError("the Postgres URL must start with postgres:// or postgresql://", "db_target_invalid");
      return { driver: "postgres", postgresUrl: url };
    }
    if (t.driver === "sqlite") {
      const p = t.sqlitePath?.trim();
      if (!p || !isAbsolute(p)) throw new DatabaseSwitchRefusedError("the SQLite path must be absolute", "db_target_invalid");
      return { driver: "sqlite", sqlitePath: resolve(p) };
    }
    throw new DatabaseSwitchRefusedError("unknown database driver", "db_target_invalid");
  }

  /** Why the target can't be used regardless of its contents (same as current, a rollback point's file). */
  function targetConflict(t: DatabaseTarget): string | undefined {
    if (sameDatabase(t, current)) return "this is the database the server already uses";
    if (t.driver === "sqlite" && (readState()?.rollbacks ?? []).some((r) => sameDatabase(r.target, t)))
      return "this file is a rollback point (an earlier database); delete it first or pick another path";
    return undefined;
  }

  async function otherInstances(): Promise<DatabaseInstanceInfo[]> {
    return (await deps.instances()).filter((i) => !i.self);
  }

  function blockedReason(others: DatabaseInstanceInfo[]): string | undefined {
    if (deps.envPinned)
      return "The database driver is pinned by the BEAMHOP_DB_DRIVER environment variable. Remove it and restart to switch from the panel.";
    if (others.length)
      return `${others.length} other instance${others.length === 1 ? " is" : "s are"} running on this database. Switching only works with a single instance; scaled deployments switch through config and a restart.`;
    if (job && !TERMINAL.has(job.phase)) return "A database switch is already running.";
    return undefined;
  }

  /** sqlite target that doesn't exist yet: don't create it while testing, just check its directory is writable. */
  async function probeNewSqliteFile(path: string): Promise<string | undefined> {
    try {
      await access(dirname(path), fsConstants.W_OK);
      return undefined;
    } catch {
      return `directory ${dirname(path)} does not exist or is not writable`;
    }
  }

  async function test(input: DatabaseTarget): Promise<DatabaseTestResult> {
    const target = resolveTarget(input);
    const result: DatabaseTestResult = { ok: false, reachable: false, empty: false, existingTables: [], sameAsCurrent: sameDatabase(target, current), errors: [] };
    const conflict = targetConflict(target);
    if (conflict) {
      result.reachable = true;
      result.errors.push(conflict);
      return result;
    }
    if (target.driver === "sqlite" && !existsSync(target.sqlitePath!)) {
      const problem = await probeNewSqliteFile(target.sqlitePath!);
      if (problem) result.errors.push(problem);
      else Object.assign(result, { ok: true, reachable: true, empty: true });
      return result;
    }
    let db: Db | undefined;
    try {
      db = await ops.openDatabase(target, deps.sqlite);
      result.reachable = true;
      const info = await ops.inspectDatabase(db, target);
      result.serverVersion = info.serverVersion;
      result.existingTables = info.tables;
      result.empty = info.tables.length === 0;
      result.ok = true;
    } catch (err) {
      result.errors.push(scrub(errMsg(err), target));
    } finally {
      await db?.close().catch(() => {});
    }
    return result;
  }

  async function status(): Promise<DatabaseStatus> {
    let tables: { name: string; rows: number }[] = [];
    let sizeBytes: number | undefined;
    try {
      const info = await ops.inspectDatabase(deps.db.current, current);
      tables = info.tables;
      sizeBytes = info.sizeBytes;
    } catch (err) {
      log.warn("could not inspect the current database", { error: errMsg(err) });
    }
    let instances: DatabaseInstanceInfo[] = [];
    try {
      instances = await deps.instances();
    } catch (err) {
      log.warn("could not list instances", { error: errMsg(err) });
    }
    const rollbacks = (readState()?.rollbacks ?? []).map((r) => ({ ...r, target: redactTarget(r.target) }));
    const reason = blockedReason(instances.filter((i) => !i.self));
    return {
      current: redactTarget(current),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      tables,
      envPinned: deps.envPinned,
      ...(deps.defaultPostgresUrl ? { envPostgresUrl: redactPostgresUrl(deps.defaultPostgresUrl) } : {}),
      instances,
      rollbacks,
      ...(job ? { job: view(job) } : {}),
      ...(reason ? { blockedReason: reason } : {}),
    };
  }

  async function start(req: DatabaseSwitchRequest, actor: string): Promise<DatabaseSwitchJobView> {
    if (deps.envPinned) throw new DatabaseSwitchRefusedError(blockedReason([])!, "db_switch_refused");
    if (busy) throw new DatabaseSwitchRefusedError("a database switch is already running", "db_switch_busy");
    busy = true;
    let targetDb: Db | undefined;
    try {
      const target = resolveTarget(req.target);
      const conflict = targetConflict(target);
      if (conflict) throw new DatabaseSwitchRefusedError(conflict, "db_target_invalid");
      const others = await otherInstances();
      if (others.length) throw new DatabaseSwitchRefusedError(blockedReason(others)!, "db_switch_refused");
      try {
        targetDb = await ops.openDatabase(target, deps.sqlite);
      } catch (err) {
        throw new DatabaseSwitchRefusedError(`cannot open the target database: ${scrub(errMsg(err), target)}`, "db_switch_refused");
      }
      let info: DatabaseInspection;
      try {
        info = await ops.inspectDatabase(targetDb, target);
      } catch (err) {
        throw new DatabaseSwitchRefusedError(`cannot inspect the target database: ${scrub(errMsg(err), target)}`, "db_switch_refused");
      }
      const wipe = info.tables.length > 0;
      if (wipe && req.wipeConfirm !== WIPE_CONFIRM_PHRASE) {
        const list = info.tables.slice(0, 10).map((t) => `${t.name} (${t.rows} rows)`).join(", ");
        throw new DatabaseSwitchRefusedError(
          `the target database is not empty (${list}${info.tables.length > 10 ? ", …" : ""}); type "${WIPE_CONFIRM_PHRASE}" to erase it`,
          "db_target_not_empty",
        );
      }
      const j: Job = {
        id: randomUUID(),
        from: { ...current },
        to: target,
        phase: "preflight",
        startedAt: nowSec(),
        tables: [],
        cancellable: true,
        actor,
        controller: new AbortController(),
      };
      job = j;
      const details = { from: describeTarget(j.from), to: describeTarget(target), wipe, jobId: j.id };
      log.info("database switch started", details);
      await audit(actor, "db.switch.start", details);
      const db = targetDb;
      targetDb = undefined;
      running = run(j, db, wipe).finally(() => {
        busy = false;
      });
      return view(j);
    } catch (err) {
      busy = false;
      await targetDb?.close().catch(() => {});
      throw err;
    }
  }

  /** Races a step against the remaining pause budget. */
  async function withinBudget<T>(deadline: number, step: Promise<T>): Promise<T> {
    const left = deadline - now();
    if (left <= 0) {
      step.catch(() => {});
      throw new StepTimeout();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        step,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StepTimeout()), left);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(j: Job, target: Db, wipe: boolean): Promise<void> {
    const signal = j.controller.signal;
    const checkCancel = () => {
      if (signal.aborted) throw new Cancelled();
    };
    let paused = false;
    let swapped = false;
    let old: Db | undefined;
    let warning: string | undefined;
    try {
      if (wipe) await ops.wipeDatabase(target);
      checkCancel();
      j.phase = "schema";
      await ops.prepareSchema(target, deps.db.registeredMigrations());
      checkCancel();
      j.phase = "bulk_copy";
      const copier = ops.createCopier(deps.db.current, target, {
        logger: log,
        signal,
        onProgress: (tables) => {
          j.tables = tables.map((t) => ({ ...t }));
        },
      });
      j.copier = copier;
      await copier.bulkCopy();
      // from here on the switch can't be cancelled (synchronously with the last check, so cancel() can't slip between)
      checkCancel();
      j.cancellable = false;
      j.phase = "pausing";
      j.pauseStartedAt = now();
      const deadline = j.pauseStartedAt + budgetMs;
      try {
        paused = true;
        await withinBudget(deadline, deps.db.pauseWrites());
        await withinBudget(deadline, deps.db.runBeforeFinalCopy());
        j.phase = "final_copy";
        await withinBudget(deadline, copier.finalCopy());
        j.phase = "verify";
        const report = await withinBudget(deadline, copier.verify());
        if (!report.ok) {
          const bad = report.tables.filter((t) => !t.ok);
          throw new Error(
            `verification failed: ${bad
              .slice(0, 5)
              .map((t) => `${t.table} (${t.sourceRows} source rows, ${t.targetRows} copied${t.detail ? `, ${t.detail}` : ""})`)
              .join("; ")}${bad.length > 5 ? "; …" : ""}. The current database is unchanged.`,
          );
        }
        if (now() > deadline) throw new StepTimeout();
        j.phase = "switching";
        try {
          old = await deps.db.swap(target);
        } catch (err) {
          throw new Error(`switching failed, still on the old database: ${errMsg(err)}`);
        }
        swapped = true;
        j.phase = "persist";
        warning = await persist(j, old);
      } finally {
        if (paused) {
          try {
            deps.db.resumeWrites();
          } catch (err) {
            log.error("resuming writes failed", { error: errMsg(err) });
          }
          j.pausedMs = now() - j.pauseStartedAt;
        }
      }
      current = { ...j.to };
      try {
        deps.onSwitched?.(j.to);
      } catch (err) {
        log.error("onSwitched failed", { error: errMsg(err) });
      }
      if (warning) j.error = `done with warning: ${warning}`;
      j.phase = "done";
      j.finishedAt = nowSec();
      const details = { jobId: j.id, from: describeTarget(j.from), to: describeTarget(j.to), pausedMs: j.pausedMs, ...(warning ? { warning } : {}) };
      log.info("database switch done", details);
      await audit(j.actor, "db.switch.done", details);
    } catch (err) {
      if (swapped) {
        // only persist() runs after the swap and it doesn't throw; keep running on the new database whatever happened
        j.error = `done with warning: ${scrub(errMsg(err), j.from, j.to)}`;
        j.phase = "done";
        j.finishedAt = nowSec();
        return;
      }
      const cancelled = err instanceof Cancelled || (signal.aborted && j.cancellable);
      j.phase = cancelled ? "cancelled" : "failed";
      j.cancellable = false;
      j.error = cancelled ? "cancelled" : err instanceof StepTimeout ? TOO_MANY_CHANGES : scrub(errMsg(err), j.from, j.to);
      j.finishedAt = nowSec();
      if (!signal.aborted) j.controller.abort();
      // the target was empty (or erased with confirmation): leave it empty again so a retry needs no confirmation
      await ops.wipeDatabase(target).catch((e) => log.warn("could not clean up the target database", { error: scrub(errMsg(e), j.to) }));
      await target.close().catch(() => {});
      const details = { jobId: j.id, from: describeTarget(j.from), to: describeTarget(j.to), error: j.error, ...(j.pausedMs !== undefined ? { pausedMs: j.pausedMs } : {}) };
      if (cancelled) log.info("database switch cancelled", details);
      else log.warn("database switch failed", details);
      await audit(j.actor, "db.switch.failed", details);
    }
  }

  /** After the swap (writes still paused): state file, freeze marker in the old database, close it. Returns a warning instead of throwing. */
  async function persist(j: Job, old: Db): Promise<string | undefined> {
    const problems: string[] = [];
    const at = nowSec();
    try {
      const prev = readState();
      const point: DatabaseRollbackPoint = { id: randomUUID(), target: { ...j.from }, frozenAt: at, replacedBy: j.to.driver };
      await deps.writeState({
        version: 1,
        current: { ...j.to },
        rollbacks: [...(prev?.rollbacks ?? []).filter((r) => !sameDatabase(r.target, j.to) && !sameDatabase(r.target, j.from)), point],
        switchedAt: at,
      });
    } catch (err) {
      problems.push(`the switch could not be saved to the database state file (${scrub(errMsg(err), j.from, j.to)}); the server runs on the new database, but a restart would go back to the old one`);
    }
    try {
      await old.run(
        "INSERT INTO kv (namespace, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        ["server", "frozenAt", JSON.stringify({ at, replacedBy: j.to.driver }), at],
      );
    } catch (err) {
      problems.push(`the old database could not be marked as frozen (${scrub(errMsg(err), j.from)})`);
    }
    try {
      await old.close();
    } catch (err) {
      log.warn("closing the old database failed", { error: scrub(errMsg(err), j.from) });
    }
    if (problems.length) log.error("database switch persisted with problems", { problems });
    return problems.length ? problems.join("; ") : undefined;
  }

  function cancel(id: string): boolean {
    if (!job || job.id !== id || !job.cancellable || TERMINAL.has(job.phase)) return false;
    job.controller.abort();
    return true;
  }

  async function deleteRollback(id: string, confirm: string, actor: string): Promise<void> {
    if (confirm !== DELETE_ROLLBACK_CONFIRM_PHRASE) throw new DatabaseSwitchRefusedError(`type "${DELETE_ROLLBACK_CONFIRM_PHRASE}" to confirm`, "db_confirm_mismatch");
    if (busy) throw new DatabaseSwitchRefusedError("a database switch is running; try again when it has finished", "db_switch_busy");
    const state = readState();
    const point = state?.rollbacks.find((r) => r.id === id);
    if (!state || !point) throw new DatabaseSwitchRefusedError("rollback point not found", "db_rollback_not_found");
    if (sameDatabase(point.target, current)) throw new DatabaseSwitchRefusedError("this rollback point is the database the server uses now", "db_switch_refused");
    busy = true;
    const details = { id, target: describeTarget(point.target), frozenAt: point.frozenAt };
    try {
      if (point.target.driver === "sqlite") {
        const path = point.target.sqlitePath;
        if (!path || !isAbsolute(path)) throw new DatabaseSwitchRefusedError("the rollback point has no absolute SQLite path", "db_switch_refused");
        for (const f of sqliteSiblings(path)) await ops.removeFile(f);
      } else {
        let db: Db | undefined;
        try {
          db = await ops.openDatabase(point.target, deps.sqlite);
          await ops.wipeDatabase(db);
        } catch (err) {
          throw new Error(`could not delete the old database: ${scrub(errMsg(err), point.target)}`);
        } finally {
          await db?.close().catch(() => {});
        }
      }
      const latest = readState() ?? state;
      await deps.writeState({ ...latest, rollbacks: latest.rollbacks.filter((r) => r.id !== id) });
      log.info("rollback point deleted", details);
      await audit(actor, "db.rollback.delete", details);
    } catch (err) {
      await audit(actor, "db.rollback.delete", { ...details, error: scrub(errMsg(err), point.target) });
      throw err;
    } finally {
      busy = false;
    }
  }

  return {
    status,
    test,
    start,
    job: (id) => (job && job.id === id ? view(job) : undefined),
    cancel,
    deleteRollback,
    whenIdle: () => running,
  };
}
