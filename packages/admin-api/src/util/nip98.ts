import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "@beamhop/sdk";

const NIP98_KIND = 27235;
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Structural check for a nostr event (prior to signature verification). */
export function isNostrEventShape(v: unknown): v is NostrEvent {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.pubkey === "string" &&
    typeof e.sig === "string" &&
    typeof e.content === "string" &&
    Number.isInteger(e.kind) &&
    Number.isInteger(e.created_at) &&
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))
  );
}

/** Verifies id + signature without mutating the input. */
export function isValidSignedEvent(ev: NostrEvent): boolean {
  if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey) || !/^[0-9a-f]{128}$/.test(ev.sig)) return false;
  try {
    return verifyEvent({ id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig });
  } catch {
    return false;
  }
}

/** Parses `Authorization: Nostr <base64(json event)>`. */
export function parseNostrAuthorization(header: string | undefined | null): NostrEvent | null {
  if (!header) return null;
  const m = /^Nostr\s+(\S+)\s*$/i.exec(header);
  if (!m || m[1].length > 16_384) return null;
  try {
    const json = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    return isNostrEventShape(json) ? json : null;
  } catch {
    return null;
  }
}

function normalizeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return null;
  }
}

export interface Nip98Options {
  /** acceptable absolute URLs (compared after normalisation) */
  urls: string[];
  method: string;
  nowSec: number;
  /** request body; when given and a `payload` tag exists, it must match sha256(body) */
  body?: Uint8Array | string | null;
  /** fail if there's no payload tag (NIP-86) */
  requirePayload?: boolean;
  /** skip the payload hash check (caller verifies it later with `payloadMatches`, e.g. after authorization) */
  skipPayload?: boolean;
  maxSkewSec?: number;
}

export type Nip98Result = { ok: true } | { ok: false; reason: string };

export function verifyNip98(ev: NostrEvent, opts: Nip98Options): Nip98Result {
  if (ev.kind !== NIP98_KIND) return { ok: false, reason: "auth event must be kind 27235" };
  const skew = opts.maxSkewSec ?? 60;
  if (Math.abs(ev.created_at - opts.nowSec) > skew) return { ok: false, reason: "auth event expired or from the future" };
  const tag = (name: string) => ev.tags.find((t) => t[0] === name)?.[1];
  const u = tag("u");
  const nu = u ? normalizeUrl(u) : null;
  if (!nu || !opts.urls.some((x) => normalizeUrl(x) === nu)) return { ok: false, reason: "auth event url mismatch" };
  if ((tag("method") ?? "").toUpperCase() !== opts.method.toUpperCase()) return { ok: false, reason: "auth event method mismatch" };
  const payload = tag("payload");
  if (opts.requirePayload && !payload) return { ok: false, reason: "auth event payload tag required" };
  if (payload && !opts.skipPayload && !payloadMatches(ev, opts.body)) return { ok: false, reason: "auth event payload mismatch" };
  if (!isValidSignedEvent(ev)) return { ok: false, reason: "invalid auth event signature" };
  return { ok: true };
}

/** True when the event has no `payload` tag, or it equals sha256(body). */
export function payloadMatches(ev: NostrEvent, body: Uint8Array | string | null | undefined): boolean {
  const payload = ev.tags.find((t) => t[0] === "payload")?.[1];
  return !payload || payload.toLowerCase() === sha256Hex(body ?? "");
}

/** Reads a request body, giving up (null) as soon as it exceeds `max` bytes — also for chunked bodies without Content-Length. */
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) (out.set(c, off), (off += c.byteLength));
  return out;
}
