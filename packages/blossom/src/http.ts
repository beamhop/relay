import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { normalizeIp } from "@beamhop/sdk/net";

export class BlossomError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

/**
 * Status for a request body that broke off mid-read (the client went away or reset the connection): nginx's
 * "client closed request". Not a server error, so it's logged at debug, not as a 500 with a stack.
 */
export const CLIENT_CLOSED = 499;

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-SHA-256, X-Content-Type, X-Content-Length, Range, If-None-Match, *",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "X-Reason, Content-Length, Content-Range, Accept-Ranges, ETag, Location",
  "Access-Control-Max-Age": "86400",
};

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

/**
 * Error response with the Blossom `X-Reason` header (plain-text body with the full message). The header is cut down
 * to printable ASCII: a header value outside Latin-1 (e.g. a plugin's localized rejection reason) would make the
 * Response constructor throw.
 */
export function errorResponse(status: number, reason: string): Response {
  const header = reason.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e]/g, "?").slice(0, 512);
  return withCors(new Response(reason, { status, headers: { "X-Reason": header, "Content-Type": "text/plain; charset=utf-8" } }));
}

/** Reason given for writes refused while a database switch has writes paused. */
export const DB_SWITCHING_REASON = "database switch in progress, try again shortly";

/** 503 for a write refused during a database switch, with Retry-After (seconds) and the X-Reason header. */
export function switchingResponse(retryAfterSec: number): Response {
  const res = errorResponse(503, DB_SWITCHING_REASON);
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterSec))));
  return res;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

export { sha256Hex } from "@beamhop/sdk/util";

export interface ReadLimits {
  /** reserves memory for each chunk before it is kept (shared budget); false aborts with 503 */
  reserve?: (bytes: number) => boolean;
  /** gives back reserved bytes no longer held (the chunk copies of a chunked body once it's joined) */
  unreserve?: (bytes: number) => void;
  /**
   * admission check against the announced size (Content-Length) before anything is read: false → 503 right away
   * instead of mid-body. Nothing is held by it — bytes are still reserved as they arrive — so a client lying
   * about its Content-Length can't park budget it never sends.
   */
  admit?: (bytes: number) => boolean;
  /** abort with 408 when no data arrives for this long (ms) */
  stallMs?: number;
  /** once `rateGraceMs` have passed, abort with 408 while the average rate is below this (bytes/s) */
  minBytesPerSec?: number;
  rateGraceMs?: number;
}

const EMPTY = new Uint8Array(0);

type ReadResult<T> = Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>;

async function readOrStall<T>(reader: ReadableStreamDefaultReader<T>, ms: number | undefined): Promise<ReadResult<T> | "stalled"> {
  if (!ms) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([reader.read(), new Promise<"stalled">((r) => (timer = setTimeout(() => r("stalled"), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a stream fully while hashing incrementally; aborts with 413 once `maxBytes` is exceeded.
 * With a size hint (Content-Length) bytes go straight into one buffer of that size. Without one (chunked) the
 * chunks are kept and copied once at the end — the body is briefly held twice, which is what gets reserved —
 * instead of regrowing a buffer (old + new copy alive on every doubling).
 */
export async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  sizeHint?: number,
  limits: ReadLimits = {},
): Promise<{ data: Uint8Array; sha256: string }> {
  const hash = createHash("sha256");
  const hint = sizeHint !== undefined && Number.isFinite(sizeHint) && sizeHint > 0 ? Math.min(sizeHint, maxBytes) : 0;
  let buf: Uint8Array | undefined = hint ? new Uint8Array(hint) : undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  /** bytes reserved twice (kept as chunks, then joined into one buffer) */
  let doubled = 0;
  if (stream) {
    if (hint && limits.admit && !limits.admit(hint)) {
      await stream.cancel().catch(() => {});
      throw new BlossomError(503, "server busy, retry later");
    }
    const reader = stream.getReader();
    const fail = async (status: number, reason: string): Promise<never> => {
      await reader.cancel().catch(() => {});
      throw new BlossomError(status, reason);
    };
    const started = Date.now();
    for (;;) {
      let r: ReadResult<Uint8Array> | "stalled";
      try {
        r = await readOrStall(reader, limits.stallMs);
      } catch {
        throw new BlossomError(CLIENT_CLOSED, "connection closed while receiving the body");
      }
      if (r === "stalled") await fail(408, "upload stalled");
      const { done, value } = r as ReadResult<Uint8Array>;
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > maxBytes) await fail(413, `blob too large (max ${maxBytes} bytes)`);
      if (buf && total + value.byteLength > buf.byteLength) {
        // more than the hint announced: fall back to collecting chunks
        chunks.push(buf.subarray(0, total));
        buf = undefined;
      }
      if (limits.reserve && !limits.reserve(buf ? value.byteLength : value.byteLength * 2)) await fail(503, "server busy, retry later");
      if (buf) buf.set(value, total);
      else (chunks.push(value), (doubled += value.byteLength));
      total += value.byteLength;
      hash.update(value);
      const elapsed = Date.now() - started;
      if (limits.minBytesPerSec && elapsed > (limits.rateGraceMs ?? 0) && total < (limits.minBytesPerSec * elapsed) / 1000) {
        await fail(408, "upload too slow");
      }
    }
  }
  let data: Uint8Array;
  if (buf) data = total === buf.byteLength ? buf : buf.subarray(0, total);
  else if (chunks.length === 1) {
    data = chunks[0];
    limits.unreserve?.(doubled);
  } else {
    data = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      data.set(chunks[i], offset);
      offset += chunks[i].byteLength;
      chunks[i] = EMPTY;
    }
    // the chunk copies (reserved as a second copy of each chunk) are garbage now
    limits.unreserve?.(doubled);
  }
  return { data, sha256: hash.digest("hex") };
}

/**
 * Parses a single `Range: bytes=...` header against a known size.
 * Returns undefined (serve full), the range, or "unsatisfiable".
 */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim());
  if (!m) return undefined; // multi-range or malformed: ignore and serve whole body (RFC 9110 allows)
  const [, s, e] = m;
  if (s === "" && e === "") return undefined;
  let start: number;
  let end: number;
  if (s === "") {
    const suffix = Number(e);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(s);
    // last-pos < first-pos is syntactically invalid: ignore the header (RFC 9110 §14.1.1), don't 416
    if (e !== "" && Number(e) < start) return undefined;
    end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

/**
 * Client IP. Prefers the address resolved by the server runtime adapter (`env.ip`, already proxy-aware and
 * normalized) so blossom and the relay always agree. Standalone (no adapter): when trustProxy is on, the
 * rightmost X-Forwarded-For hop (the one appended by the trusted proxy; anything left of it is client-controlled),
 * X-Real-IP only when there's no X-Forwarded-For; non-IP values are ignored.
 */
export function clientIp(req: Request, trustProxy: boolean, env?: unknown): string {
  const e = env as { ip?: unknown; remoteAddress?: unknown } | undefined;
  if (e && typeof e.ip === "string" && e.ip) return normalizeIp(e.ip);
  if (trustProxy) {
    // same default rules as the server adapters: rightmost X-Forwarded-For hop, X-Real-IP only without XFF
    const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const raw = hops.length ? hops[hops.length - 1] : req.headers.get("x-real-ip");
    const ip = raw?.trim() ? normalizeIp(raw) : "";
    if (isIP(ip)) return ip;
  }
  if (e && typeof e.remoteAddress === "string") return normalizeIp(e.remoteAddress);
  return "unknown";
}
