export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(level: LogLevel = "info", scope = "beamhop"): Logger {
  const log = (l: LogLevel) => (msg: string, data?: Record<string, unknown>) => {
    if (order[l] < order[level]) return;
    const line = `${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    (l === "error" ? console.error : l === "warn" ? console.warn : console.log)(data ? `${line} ${JSON.stringify(data)}` : line);
  };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error"), child: (s) => createLogger(level, `${scope}:${s}`) };
}
