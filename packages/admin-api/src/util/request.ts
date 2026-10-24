import type { Context } from "hono";
import type { z } from "zod";
import { badRequest, isZodError, zodMessage } from "../errors";
import { ipv6Groups } from "./ip";

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

/**
 * Best-effort client IP. Forwarding headers are never read here: the server adapter resolves them (against
 * server.trustedProxies) and binds the result as `c.env.ip`.
 * - `c.env.ip`: set by the server adapter (already proxy-aware and normalized) — always preferred
 * - otherwise (the app mounted on its own) Bun `server.requestIP`, @hono/node-server `incoming.socket`.
 */
export function clientIp(c: Context): string | null {
  const bound = (c.env as { ip?: unknown } | undefined)?.ip;
  if (typeof bound === "string" && bound) return normalizeIp(bound);
  const env = c.env as Record<string, unknown> | undefined;
  if (env && typeof env === "object") {
    const server = (env.server ?? env) as { requestIP?: (r: Request) => { address: string } | null };
    if (typeof server.requestIP === "function") {
      try {
        const a = server.requestIP(c.req.raw);
        if (a?.address) return normalizeIp(a.address);
      } catch {
        /* ignore */
      }
    }
    const incoming = env.incoming as { socket?: { remoteAddress?: string } } | undefined;
    if (incoming?.socket?.remoteAddress) return normalizeIp(incoming.socket.remoteAddress);
  }
  return null;
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → plain IPv4, so both spellings share rate-limit keys. */
const normalizeIp = (ip: string) => ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");

/**
 * Rate-limit key for a client IP: IPv4 as is, IPv6 aggregated to its /64 (one subscriber usually holds a
 * whole /64, so per-address keys would hand out 2^64 buckets). Keep the full address for audit/display.
 */
export function rateKey(ip: string | null | undefined): string {
  if (!ip) return "unknown";
  const plain = normalizeIp(ip);
  if (!plain.includes(":")) return plain;
  const g = ipv6Groups(plain);
  if (!g) return plain;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
