import { isBun, runtimeName } from "@beamhop/sdk";
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

/** Composition + listen + graceful shutdown wiring. */
export async function startServer(loaded: LoadedConfig, overrides: BeamhopOverrides & ServeOptions & { handleSignals?: boolean; runtime?: "bun" | "node" } = {}): Promise<StartedServer> {
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
      log.info("bye");
    })());

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
