import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { getTag, nowSec } from "@beamhop/sdk";
import type { Verifier } from "../pipeline/verify";
import { validateEventShape } from "../protocol/messages";

export const HTTP_AUTH_KIND = 27235;
export const HTTP_AUTH_WINDOW_SEC = 60;

export type Nip98Result = { ok: true; pubkey: string } | { ok: false; status: 401 | 403 | 503; error: string };
/** Live replay-cache entries; when full of unexpired ids new requests are refused rather than old ids forgotten. */
export const NIP98_REPLAY_CAP = 50_000;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Verifies a NIP-98 `Authorization: Nostr <base64(event)>` header.
 * The `u` tag must equal publicUrl + path (+ query) and `method` must match. Requests with a body must carry a
 * `payload` tag binding the body to the signature.
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
  // NIP-98: the u tag MUST be the absolute request URL, including query parameters — built from publicUrl, never
  // the request's own URL (its host comes from the client-controlled Host header)
  const accepted = new Set([base + reqUrl.pathname + reqUrl.search]);
  const u = getTag(ev, "u");
  if (!u || !accepted.has(u)) return { ok: false, status: 401, error: "authorization u tag does not match request url" };
  if ((getTag(ev, "method") ?? "").toUpperCase() !== req.method.toUpperCase()) return { ok: false, status: 401, error: "authorization method tag does not match" };
  const payload = getTag(ev, "payload");
  if (payload === undefined && BODY_METHODS.has(req.method.toUpperCase())) return { ok: false, status: 401, error: "authorization payload tag required" };
  if (payload !== undefined && opts.body) {
    const hash = createHash("sha256").update(opts.body).digest("hex");
    if (hash !== payload.toLowerCase()) return { ok: false, status: 401, error: "authorization payload hash mismatch" };
  }
  if (!opts.verifier.verify(ev)) return { ok: false, status: 401, error: "invalid authorization signature" };
  const mark = markUsed(ev.id);
  if (mark === "used") return { ok: false, status: 401, error: "authorization event already used" };
  if (mark === "full") return { ok: false, status: 503, error: "busy: retry shortly" };
  return { ok: true, pubkey: ev.pubkey };
}

/** Auth event ids seen within the validity window (replay protection). */
const used = new Map<string, number>();

let lastPrune = 0;

function markUsed(id: string): "ok" | "used" | "full" {
  const now = nowSec();
  const exp = used.get(id);
  if (exp !== undefined && exp >= now) return "used";
  // prune at most once a second so a full map doesn't cost a full scan per request
  if (used.size >= NIP98_REPLAY_CAP && now !== lastPrune) {
    lastPrune = now;
    for (const [k, e] of used) if (e < now) used.delete(k);
  }
  if (used.size >= NIP98_REPLAY_CAP) return "full";
  used.set(id, now + HTTP_AUTH_WINDOW_SEC * 2);
  return "ok";
}
