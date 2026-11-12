import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { isDbSwitchingError, type ApiError, type Logger } from "@beamhop/sdk";

export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    message: string,
    public readonly code?: string,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = "bad_request") => new HttpError(400, msg, code);
export const unauthorized = (msg = "authentication required", code = "unauthorized") => new HttpError(401, msg, code);
export const forbidden = (msg = "forbidden", code = "forbidden") => new HttpError(403, msg, code);
export const notFound = (msg = "not found", code = "not_found") => new HttpError(404, msg, code);
export const conflict = (msg: string, code = "conflict") => new HttpError(409, msg, code);

/** The answer to a write refused while a database switch has writes paused: 503, retry after the given seconds. */
export const DB_SWITCHING_MESSAGE = "database switch in progress, try again shortly";
export const dbSwitching = (retryAfterSec = 5, msg = DB_SWITCHING_MESSAGE) =>
  new HttpError(503, msg, "db_switching", { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))) });

interface ZodLikeError {
  name: string;
  issues: { path: PropertyKey[]; message: string }[];
}
export const isZodError = (err: unknown): err is ZodLikeError =>
  !!err && typeof err === "object" && (err as { name?: string }).name === "ZodError" && Array.isArray((err as ZodLikeError).issues);

export function zodMessage(err: ZodLikeError): string {
  return err.issues
    .slice(0, 10)
    .map((i) => `${i.path.length ? i.path.map(String).join(".") : "value"}: ${i.message}`)
    .join("; ");
}

export function errorBody(error: string, code?: string): ApiError {
  return code ? { error, code } : { error };
}

export function createErrorHandler(logger: Logger) {
  return (err: unknown, c: Context) => {
    if (err instanceof HttpError) {
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
      return c.json(errorBody(err.message, err.code), err.status);
    }
    if (isZodError(err)) return c.json(errorBody(zodMessage(err), "validation"), 400);
    // a write refused while a database switch has writes paused: retryable, not a server fault
    if (isDbSwitchingError(err)) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(err.retryAfterSec))));
      return c.json(errorBody(DB_SWITCHING_MESSAGE, "db_switching"), 503);
    }
    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      return c.json(errorBody(err.message || "request failed", status === 413 ? "too_large" : undefined), status);
    }
    logger.error("admin api error", { path: c.req.path, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    return c.json(errorBody("internal error", "internal"), 500);
  };
}
