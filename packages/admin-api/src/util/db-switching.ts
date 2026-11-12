import { isDbSwitchingError, type Logger } from "@beamhop/sdk";

export { isDbSwitchingError };

/**
 * Logs a background failure: at debug when it is a write refused while a database switch has writes paused (the work
 * is retried later), otherwise at `level`.
 */
export function logUnlessSwitching(logger: Logger, level: "warn" | "error", msg: string, err: unknown, meta: Record<string, unknown> = {}): void {
  if (isDbSwitchingError(err)) logger.debug(`${msg} (database switch in progress)`, meta);
  else logger[level](msg, { ...meta, error: String(err) });
}
