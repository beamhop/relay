export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * JSON for log lines that never throws: Errors become {name, message, stack} (plus cause), BigInts strings,
 * repeated/circular references "[Circular]", functions and symbols their description.
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const replace = (_key: string, v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (typeof v === "symbol") return v.toString();
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      if (v instanceof Error) {
        const out: Record<string, unknown> = { name: v.name, message: v.message, stack: v.stack };
        if (v.cause !== undefined) out.cause = v.cause;
        return out;
      }
    }
    return v;
  };
  try {
    return JSON.stringify(value, replace) ?? String(value);
  } catch (err) {
    // a throwing getter or toJSON
    try {
      return JSON.stringify({ unserializable: String(err) });
    } catch {
      return '"[unserializable]"';
    }
  }
}

/** "text": `<time> LEVEL [scope] message {data}`; "json": one object per line (`time`, `level`, `scope`, `msg`, data fields). */
export type LogFormat = "text" | "json";

export function createLogger(level: LogLevel = "info", scope = "beamhop", format: LogFormat = "text"): Logger {
  const log = (l: LogLevel) => (msg: string, data?: Record<string, unknown>) => {
    if (order[l] < order[level]) return;
    try {
      const time = new Date().toISOString();
      let line: string;
      if (format === "json") {
        // fixed fields first, and data fields can't shadow them
        const head = { time, level: l, scope, msg: String(msg) };
        line = safeStringify(Object.assign({}, head, data, head));
      } else {
        line = `${time} ${l.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
        if (data) line += ` ${safeStringify(data)}`;
      }
      (l === "error" ? console.error : l === "warn" ? console.warn : console.log)(line);
    } catch {
      // logging must never take the caller down (closed stdout, a throwing message toString …)
    }
  };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error"), child: (s) => createLogger(level, `${scope}:${s}`, format) };
}
