import { createHash } from "node:crypto";

export class BlossomError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

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

/** Error response with the Blossom `X-Reason` header (plain-text body with the same message). */
export function errorResponse(status: number, reason: string): Response {
  return withCors(
    new Response(reason, {
      status,
      headers: { "X-Reason": reason.replace(/[\r\n]+/g, " ").slice(0, 512), "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

export const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * Reads a stream fully while hashing incrementally; aborts with 413 once `maxBytes` is exceeded.
 */
export async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ data: Uint8Array; sha256: string }> {
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BlossomError(413, `blob too large (max ${maxBytes} bytes)`);
      }
      hash.update(value);
      chunks.push(value);
    }
  }
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    data.set(c, off);
    off += c.byteLength;
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
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Client IP; only trusts proxy headers when configured to. */
export function clientIp(req: Request, trustProxy: boolean, env?: unknown): string {
  if (trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  const e = env as { ip?: unknown; remoteAddress?: unknown } | undefined;
  if (e && typeof e.ip === "string") return e.ip;
  if (e && typeof e.remoteAddress === "string") return e.remoteAddress;
  return "unknown";
}
