import type { Logger } from "./logger";

/**
 * What a service is given to drain or stop: why, until when (ms since epoch, same clock as `Date.now`), and a signal
 * that fires at that deadline (or when the whole shutdown is cut short). Work still running past it is abandoned.
 */
export interface StopContext {
  readonly reason: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

export interface StopContextOptions {
  now?: () => number;
  /** the enclosing context: its signal aborts this one too, and its deadline caps this one */
  parent?: StopContext;
}

/** A StopContext with its own timer; `dispose()` clears the timer once the step is done. */
export interface OwnedStopContext extends StopContext {
  dispose(): void;
}

/** Context whose signal fires `ms` from now (never later than `parent`'s deadline). */
export function stopContext(reason: string, ms: number, opts: StopContextOptions = {}): OwnedStopContext {
  const now = opts.now ?? Date.now;
  const parent = opts.parent;
  const deadline = Math.min(now() + Math.max(0, ms), parent?.deadline ?? Infinity);
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParent = () => ac.abort(parent?.signal.reason);
  const dispose = () => {
    clearTimeout(timer);
    parent?.signal.removeEventListener("abort", onParent);
  };
  ac.signal.addEventListener("abort", dispose, { once: true });
  if (parent?.signal.aborted) ac.abort(parent.signal.reason);
  else {
    parent?.signal.addEventListener("abort", onParent, { once: true });
    timer = setTimeout(() => ac.abort(new Error(`${reason}: deadline reached`)), Math.max(0, deadline - now()));
    (timer as { unref?: () => void }).unref?.();
  }
  return { reason, deadline, signal: ac.signal, dispose };
}

/** A step's share of `ctx`: at most `ms`, never past `ctx.deadline`, aborted with it. */
export function subContext(ctx: StopContext, ms: number, now: () => number = Date.now): OwnedStopContext {
  return stopContext(ctx.reason, ms, { now, parent: ctx });
}

/** Resolves when `signal` aborts (immediately if it already has). */
export function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export type SettleResult = { status: "done" } | { status: "error"; error: unknown } | { status: "timeout" };

/** Waits for `work` until `signal` aborts. Never rejects; the work itself keeps running after a timeout. */
export async function settleBy(signal: AbortSignal, work: Promise<unknown> | (() => Promise<unknown> | unknown)): Promise<SettleResult> {
  let p: Promise<unknown>;
  try {
    p = Promise.resolve(typeof work === "function" ? work() : work);
  } catch (error) {
    return { status: "error", error };
  }
  const outcome = p.then(
    (): SettleResult => ({ status: "done" }),
    (error): SettleResult => ({ status: "error", error }),
  );
  return Promise.race([outcome, whenAborted(signal).then((): SettleResult => ({ status: "timeout" }))]);
}

export interface TaskTrackerOptions {
  logger?: Pick<Logger, "warn" | "error" | "debug">;
}

/**
 * Background work started off a request path (bus handlers, report filing, pushes, prunes). Shutdown awaits it,
 * bounded by a deadline, before the database closes, and logs what was still running when the deadline hit.
 * Nothing here rejects: `run` logs failures, `track` leaves the caller's promise (and its handling) untouched.
 */
export class TaskTracker {
  private readonly pending = new Map<number, { label: string; done: Promise<void> }>();
  private seq = 0;
  private readonly ac = new AbortController();
  private closed = false;

  constructor(private readonly opts: TaskTrackerOptions = {}) {}

  /** Aborts when the tracker is closed: long tasks started with `run` stop at their next check. */
  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** Tasks still running. */
  get size(): number {
    return this.pending.size;
  }

  /** Labels of the tasks still running (one entry per task). */
  labels(): string[] {
    return [...this.pending.values()].map((t) => t.label);
  }

  /** Tracks a promise someone else started; returns it unchanged (its rejection is still the caller's to handle). */
  track<T>(label: string, work: Promise<T>): Promise<T> {
    const id = ++this.seq;
    const done = work.then(
      () => {},
      () => {},
    );
    this.pending.set(id, { label, done });
    void done.then(() => this.pending.delete(id));
    return work;
  }

  /**
   * Runs `fn` as a tracked task, handing it the tracker's signal. Failures are logged and resolve `undefined`;
   * after `close()` nothing new starts (also `undefined`).
   */
  run<T>(label: string, fn: (signal: AbortSignal) => Promise<T> | T): Promise<T | undefined> {
    if (this.closed) {
      this.opts.logger?.debug(`task ${label} not started: shutting down`);
      return Promise.resolve(undefined);
    }
    let p: Promise<T>;
    try {
      p = Promise.resolve(fn(this.ac.signal));
    } catch (err) {
      p = Promise.reject(err);
    }
    return this.track(
      label,
      p.catch((err) => {
        this.opts.logger?.error(`task ${label} failed`, { error: err });
        return undefined;
      }),
    );
  }

  /**
   * Resolves true once nothing is running (tasks started meanwhile included), false when `signal` aborts first; the
   * labels still running then are logged. Never rejects.
   */
  async idle(signal?: AbortSignal): Promise<boolean> {
    const aborted = signal ? whenAborted(signal).then(() => false as const) : undefined;
    while (this.pending.size) {
      const all = Promise.all([...this.pending.values()].map((t) => t.done)).then(() => true as const);
      if (!(await (aborted ? Promise.race([all, aborted]) : all))) {
        this.opts.logger?.warn("background tasks still running at the shutdown deadline", { tasks: summarize(this.labels()) });
        return false;
      }
    }
    return true;
  }

  /** Refuses new `run` tasks and aborts the signal given to running ones. Tracked work keeps being counted. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ac.abort(new Error("shutting down"));
  }
}

/** "label ×n" counts, so a flood of one kind of task logs as one entry. */
function summarize(labels: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l));
}
