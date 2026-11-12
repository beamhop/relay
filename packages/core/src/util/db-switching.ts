import { isDbSwitchingError, type DbSwitchHooks, type Logger } from "@beamhop/sdk";

export { isDbSwitchingError };

/** OK message for an EVENT refused because a database switch has writes paused (retryable). */
export const DB_SWITCHING_REASON = "error: database switch in progress, try again shortly";

/** Logs a background failure: at debug when it is a write refused during a database switch (retried later), else as asked. */
export function logUnlessSwitching(logger: Logger, level: "warn" | "error", msg: string, err: unknown, meta: Record<string, unknown> = {}): void {
  if (isDbSwitchingError(err)) logger.debug(`${msg} (database switch in progress)`, meta);
  else logger[level](msg, { ...meta, err: String(err) });
}

/**
 * Runs `fn`; when a database switch refuses it, runs it again once writes flow (up to `attempts` times). For cleanup
 * that must not be lost (e.g. removing an event whose state change failed). Never rejects: other failures (and the
 * last refusal) go to `onError`.
 */
export function whenWritesFlow(hooks: DbSwitchHooks | undefined, fn: () => Promise<unknown>, onError: (err: unknown) => void, attempts = 5): Promise<void> {
  return new Promise<void>((resolve) => {
    const attempt = (left: number) => {
      fn().then(
        () => resolve(),
        (err) => {
          if (!hooks || !isDbSwitchingError(err) || left <= 1) {
            onError(err);
            return resolve();
          }
          // resumed meanwhile: try again shortly
          if (hooks.phase === "normal") return void setTimeout(() => attempt(left - 1), 50);
          const off = hooks.onPhase((phase) => {
            if (phase !== "normal") return;
            off();
            attempt(left - 1);
          });
        },
      );
    };
    attempt(attempts);
  });
}
