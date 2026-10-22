import type { Context } from "hono";
import type { z } from "zod";
import { badRequest, isZodError, zodMessage } from "../errors";

/** Parses a JSON body (empty body → `{}`) and validates it. */
export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest("invalid JSON body", "invalid_json");
    }
  }
  return validate(schema, raw);
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return validate(schema, c.req.query());
}

export function validate<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    if (isZodError(r.error)) throw badRequest(zodMessage(r.error), "validation");
    throw badRequest("validation failed", "validation");
  }
  return r.data;
}

const IP_HEADER_CANDIDATES = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"];

/**
 * Best-effort client IP.
 * - trustProxy: X-Forwarded-For (first hop) / X-Real-IP / CF-Connecting-IP
 * - otherwise from runtime bindings: `c.env.ip` (server adapter), Bun `server.requestIP`, @hono/node-server `incoming.socket`.
 */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    for (const h of IP_HEADER_CANDIDATES) {
      const v = c.req.header(h);
      if (v) return v.split(",")[0].trim() || null;
    }
  }
  const env = c.env as Record<string, unknown> | undefined;
  if (env && typeof env === "object") {
    if (typeof env.ip === "string") return env.ip;
    const server = (env.server ?? env) as { requestIP?: (r: Request) => { address: string } | null };
    if (typeof server.requestIP === "function") {
      try {
        const a = server.requestIP(c.req.raw);
        if (a?.address) return a.address;
      } catch {
        /* ignore */
      }
    }
    const incoming = env.incoming as { socket?: { remoteAddress?: string } } | undefined;
    if (incoming?.socket?.remoteAddress) return incoming.socket.remoteAddress;
  }
  return null;
}

export const clampInt = (v: number | undefined, def: number, min: number, max: number) =>
  v === undefined || !Number.isFinite(v) ? def : Math.max(min, Math.min(max, Math.floor(v)));
