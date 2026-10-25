import { settleBy, stopContext, type Logger, type StopContext } from "@beamhop/sdk";

/**
 * starting → ready (start() done) → draining (finishing what is in flight, refusing new work) → stopping (closing
 * services in order) → stopped.
 */
export type LifecyclePhase = "starting" | "ready" | "draining" | "stopping" | "stopped";

/** Paths still answered while shutting down: probes and the scrape endpoint. */
const ALWAYS_SERVED = (path: string) => path === "/health" || path.startsWith("/health/") || path === "/metrics";

/** Phase of one Beamhop and its in-flight HTTP requests (counted until the handler returned its Response). */
export class Lifecycle {
  phase: LifecyclePhase = "starting";
  private inFlight = 0;
  private idleWaiters: (() => void)[] = [];

  /** whether new work (requests, websocket connections) is taken */
  get accepting(): boolean {
    return this.phase === "starting" || this.phase === "ready";
  }

  get requestsInFlight(): number {
    return this.inFlight;
  }

  /**
   * Runs one HTTP request. While shutting down, requests other than probes and /metrics are answered 503 with
   * Connection: close, so keep-alive clients reconnect (to another instance) instead of reusing this connection.
   */
  async handle(req: Request, fn: () => Response | Promise<Response>): Promise<Response> {
    if (!this.accepting && !ALWAYS_SERVED(new URL(req.url).pathname)) {
      return new Response(JSON.stringify({ error: "server is shutting down" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5", connection: "close", "cache-control": "no-store" },
      });
    }
    this.inFlight++;
    try {
      return await fn();
    } finally {
      if (--this.inFlight === 0) for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  /** Resolves true once no request is in flight, false when `signal` aborts first. */
  idle(signal?: AbortSignal): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== waiter);
        done(false);
      };
      const waiter = () => done(true);
      this.idleWaiters.push(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** One shutdown step: `run` gets a context whose deadline is the step's budget. */
export interface ShutdownStep {
  name: string;
  /** budget (ms); capped by the overall deadline. Omitted: whatever is left of it. */
  ms?: number;
  /** phase entered when this step starts */
  phase?: LifecyclePhase;
  /** parts run in parallel; each overrun or failure is logged on its own */
  run: Record<string, ((ctx: StopContext) => Promise<unknown> | unknown) | undefined>;
}

export interface ShutdownOptions {
  reason: string;
  /** overall budget (ms) */
  totalMs: number;
  steps: ShutdownStep[];
  logger: Logger;
  lifecycle?: Lifecycle;
  now?: () => number;
}

/**
 * Runs the steps in order. Every step (and every part of it) races its own deadline: an overrun is logged and the
 * shutdown moves on (the work is abandoned, not awaited), so one stuck service can't hold the rest — the database
 * close at the end above all. Never rejects.
 */
export async function runShutdown(o: ShutdownOptions): Promise<void> {
  const now = o.now ?? Date.now;
  const root = stopContext(o.reason, o.totalMs, { now });
  try {
    for (const step of o.steps) {
      if (step.phase && o.lifecycle) o.lifecycle.phase = step.phase;
      const parts = Object.entries(step.run).filter((e): e is [string, NonNullable<(typeof e)[1]>] => typeof e[1] === "function");
      if (!parts.length) continue;
      const sc = stopContext(o.reason, step.ms ?? Infinity, { now, parent: root });
      const startedAt = now();
      await Promise.all(
        parts.map(async ([part, fn]) => {
          const label = parts.length > 1 ? `${step.name}/${part}` : step.name;
          const r = await settleBy(sc.signal, () => fn(sc));
          if (r.status === "timeout") o.logger.warn(`shutdown: ${label} did not finish within ${Math.max(0, sc.deadline - startedAt)} ms, moving on`);
          else if (r.status === "error") o.logger.error(`shutdown: ${label} failed`, { error: r.error });
        }),
      );
      sc.dispose();
    }
  } finally {
    root.dispose();
    if (o.lifecycle) o.lifecycle.phase = "stopped";
  }
}

/** Step budgets for an overall shutdown budget: drain at most 5 s (half of it), close handshakes at most 1 s. */
export function shutdownBudgets(totalMs: number) {
  return {
    drain: Math.min(5_000, totalMs * 0.5),
    relay: Math.min(1_000, totalMs * 0.1),
    plugins: totalMs * 0.2,
    services: totalMs * 0.1,
  };
}
