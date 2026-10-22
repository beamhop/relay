import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "@beamhop/sdk";

export const NIP98_KIND = 27235;
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

export function normalizeUrl(u: string): string | null {
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
  if (payload) {
    const body = opts.body ?? "";
    if (payload.toLowerCase() !== sha256Hex(body)) return { ok: false, reason: "auth event payload mismatch" };
  }
  if (!isValidSignedEvent(ev)) return { ok: false, reason: "invalid auth event signature" };
  return { ok: true };
}
