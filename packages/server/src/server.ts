import { isBun, runtimeName, type EventBus, type Logger, type MetricsService } from "@beamhop/sdk";
import { createBeamhop, type Beamhop, type BeamhopOverrides } from "./app";
import type { LoadedConfig } from "./config";
import type { RunningServer, ServeOptions } from "./runtime/common";
import { wsUrlFrom } from "./landing";

export type { RunningServer, ServeOptions };

/** Starts the HTTP/WebSocket listener with the best adapter for the current runtime. */
export async function serve(beamhop: Beamhop, opts: ServeOptions & { runtime?: "bun" | "node" } = {}): Promise<RunningServer> {
  const useBun = (opts.runtime ?? (isBun ? "bun" : "node")) === "bun";
  if (useBun) return (await import("./runtime/bun")).serveBun(beamhop, opts);
  return (await import("./runtime/node")).serveNode(beamhop, opts);
}

export interface StartedServer {
  beamhop: Beamhop;
  server: RunningServer;
  shutdown(reason?: string): Promise<void>;
}

export interface ProcessGuardOptions {
  logger: Logger;
  bus?: EventBus;
  metrics?: Pick<MetricsService, "counter">;
  /** graceful shutdown (bounded by its own force-exit timer) */
  shutdown(reason: string): Promise<void>;
  exit?: (code: number) => void;
  proc?: Pick<NodeJS.Process, "on" | "off">;
  /** more unhandled rejections than this within a minute escalate to shutdown + exit(1) (default 10) */
  maxRejectionsPerMinute?: number;
  now?: () => number;
}

/**
 * Process-level crash handling:
 * - uncaughtException: the process state is unknown → log fatal, graceful shutdown, exit(1).
 * - unhandledRejection: usually a missing catch in one request path → log with stack, count, raise a coalesced
 *   alert (at most one a minute) and keep serving; more than `maxRejectionsPerMinute` in a minute means something
 *   is looping → shutdown + exit(1).
 * Returns the uninstaller.
 */
export function installProcessHandlers(o: ProcessGuardOptions): () => void {
  const proc = o.proc ?? process;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const now = o.now ?? Date.now;
  const max = o.maxRejectionsPerMinute ?? 10;
  const counter = o.metrics?.counter("process_unhandled_rejections_total", "promise rejections nobody handled");
  let recent: number[] = [];
  let lastAlert = 0;
  let suppressed = 0;
  let fatal = false;
  const die = (reason: string) => {
    if (fatal) return;
    fatal = true;
    o.shutdown(reason).then(() => exit(1), () => exit(1));
  };
  const onRejection = (reason: unknown) => {
    const t = now();
    o.logger.error("unhandled promise rejection", { error: reason });
    counter?.add(1);
    recent = recent.filter((at) => t - at < 60_000);
    recent.push(t);
    if (recent.length > max) {
      o.logger.error(`${recent.length} unhandled promise rejections within a minute, shutting down`);
      die("too many unhandled promise rejections");
      return;
    }
    if (lastAlert && t - lastAlert < 60_000) {
      suppressed++;
      return;
    }
    lastAlert = t;
    const msg = reason instanceof Error ? reason.message : String(reason);
    o.bus?.emit("alert", {
      level: "warning",
      title: "Unhandled promise rejection",
      message: `${msg.slice(0, 300)}${suppressed ? ` (${suppressed} more since the last alert)` : ""}. See the server log for the stack.`,
    });
    suppressed = 0;
  };
  const onException = (err: unknown) => {
    o.logger.error("uncaught exception, shutting down", { error: err });
    die("uncaught exception");
  };
  proc.on("unhandledRejection", onRejection);
  proc.on("uncaughtException", onException);
  return () => {
    proc.off("unhandledRejection", onRejection);
    proc.off("uncaughtException", onException);
  };
}

/** Composition + listen + graceful shutdown wiring. */
export async function startServer(
  loaded: LoadedConfig,
  overrides: BeamhopOverrides & ServeOptions & {
    handleSignals?: boolean;
    /** install uncaughtException/unhandledRejection handlers (default true; embedders and tests may opt out) */
    handleProcessErrors?: boolean;
    runtime?: "bun" | "node";
  } = {},
): Promise<StartedServer> {
  const beamhop = await createBeamhop(loaded.config, { ...overrides, extras: { ...loaded.extras, ...overrides.extras } });
  const log = beamhop.logger.child("server");
  if (loaded.configPath) log.info(`config: ${loaded.configPath}`);
  try {
    await beamhop.start();
  } catch (err) {
    await beamhop.stop();
    throw err;
  }
  let server: RunningServer;
  try {
    server = await serve(beamhop, overrides);
  } catch (err) {
    await beamhop.stop();
    throw err;
  }
  const shownHost = server.hostname === "0.0.0.0" || server.hostname === "::" ? "localhost" : server.hostname;
  log.info(`beamhop v${beamhop.version} on ${runtimeName} listening on http://${shownHost}:${server.port}`);
  log.info(`relay ${wsUrlFrom(beamhop.config.server.publicUrl)} · admin ${beamhop.config.server.publicUrl}/admin/`);

  let shuttingDown: Promise<void> | undefined;
  let uninstall: (() => void) | undefined;
  const shutdown = (reason = "shutdown") =>
    (shuttingDown ??= (async () => {
      log.info(`${reason}: shutting down gracefully…`);
      const force = setTimeout(() => {
        log.error("graceful shutdown timed out, forcing exit");
        process.exit(1);
      }, 10_000);
      force.unref?.();
      server.stopAccepting();
      await beamhop.stop();
      await server.stop();
      clearTimeout(force);
      uninstall?.();
      log.info("bye");
    })());

  if (overrides.handleProcessErrors !== false) {
    uninstall = installProcessHandlers({ logger: beamhop.logger.child("process"), bus: beamhop.bus, metrics: beamhop.metrics, shutdown });
  }

  if (overrides.handleSignals !== false) {
    const onSignal = (sig: NodeJS.Signals) => {
      if (shuttingDown) {
        log.warn(`received ${sig} again, exiting immediately`);
        process.exit(1);
      }
      shutdown(sig).then(() => process.exit(0), () => process.exit(1));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  return { beamhop, server, shutdown };
}
