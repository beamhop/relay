import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { getTag, nowSec } from "@beamhop/sdk";
import type { Verifier } from "../pipeline/verify";
import { validateEventShape } from "../protocol/messages";

export const HTTP_AUTH_KIND = 27235;
export const HTTP_AUTH_WINDOW_SEC = 60;

export type Nip98Result = { ok: true; pubkey: string } | { ok: false; status: 401 | 403; error: string };

/**
 * Verifies a NIP-98 `Authorization: Nostr <base64(event)>` header.
 * The `u` tag must equal publicUrl + path (+ query) — or the request URL itself — and `method` must match.
 */
export function verifyNip98(req: Request, opts: { publicUrl: string; verifier: Verifier; body?: Uint8Array }): Nip98Result {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Nostr\s+([A-Za-z0-9+/=_-]+)$/i.exec(header.trim());
  if (!m) return { ok: false, status: 401, error: "missing NIP-98 Authorization header" };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  } catch {
    return { ok: false, status: 401, error: "malformed authorization event" };
  }
  const v = validateEventShape(raw);
  if ("reason" in v) return { ok: false, status: 401, error: v.reason };
  const ev = v.event;
  if (ev.kind !== HTTP_AUTH_KIND) return { ok: false, status: 401, error: `authorization event must be kind ${HTTP_AUTH_KIND}` };
  if (Math.abs(nowSec() - ev.created_at) > HTTP_AUTH_WINDOW_SEC) return { ok: false, status: 401, error: "authorization event expired" };
  const reqUrl = new URL(req.url);
  const base = opts.publicUrl.replace(/\/+$/, "");
  const accepted = new Set([base + reqUrl.pathname, base + reqUrl.pathname + reqUrl.search, req.url]);
  const u = getTag(ev, "u");
  if (!u || !accepted.has(u)) return { ok: false, status: 401, error: "authorization u tag does not match request url" };
  if ((getTag(ev, "method") ?? "").toUpperCase() !== req.method.toUpperCase()) return { ok: false, status: 401, error: "authorization method tag does not match" };
  const payload = getTag(ev, "payload");
  if (payload !== undefined && opts.body) {
    const hash = createHash("sha256").update(opts.body).digest("hex");
    if (hash !== payload.toLowerCase()) return { ok: false, status: 401, error: "authorization payload hash mismatch" };
  }
  if (!opts.verifier.verify(ev)) return { ok: false, status: 401, error: "invalid authorization signature" };
  if (!markUsed(ev.id)) return { ok: false, status: 401, error: "authorization event already used" };
  return { ok: true, pubkey: ev.pubkey };
}

/** Auth event ids seen within the validity window (replay protection). */
const used = new Map<string, number>();

function markUsed(id: string): boolean {
  const now = nowSec();
  if (used.size > 10_000) for (const [k, exp] of used) if (exp < now) used.delete(k);
  const exp = used.get(id);
  if (exp !== undefined && exp >= now) return false;
  used.set(id, now + HTTP_AUTH_WINDOW_SEC * 2);
  return true;
}
