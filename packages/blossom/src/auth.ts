import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "@beamhop/sdk";

export type AuthVerb = "get" | "upload" | "list" | "delete";

export interface BlossomAuth {
  pubkey: string;
  event: NostrEvent;
  /** lowercase `x` tag values */
  hashes: string[];
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

/** Allowed clock skew for `created_at` (seconds). */
const CREATED_AT_SKEW = 60;

function decodeBase64(token: string): string {
  let b64 = token.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isEventShape(e: unknown): e is NostrEvent {
  const ev = e as NostrEvent;
  return (
    !!ev && typeof ev === "object" && typeof ev.id === "string" && typeof ev.pubkey === "string" &&
    typeof ev.sig === "string" && typeof ev.kind === "number" && typeof ev.created_at === "number" &&
    typeof ev.content === "string" && Array.isArray(ev.tags) && ev.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))
  );
}

/** Parses `Authorization: Nostr <base64(url)>`. Returns undefined when no Nostr auth header is present. */
export function parseAuthHeader(header: string | null | undefined): NostrEvent | undefined {
  if (!header) return undefined;
  const m = /^Nostr\s+(\S+)\s*$/i.exec(header.trim());
  if (!m) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64(m[1]));
  } catch {
    throw new AuthError("invalid authorization token encoding");
  }
  if (!isEventShape(parsed)) throw new AuthError("invalid authorization event");
  return parsed;
}

export interface VerifyAuthOptions {
  verb: AuthVerb;
  /** our domain(s) for `server` tag scoping (lowercase hostname, optionally host:port) */
  domains: string[];
  /** hash implied by the endpoint; when `requireX` the token must have a matching `x` tag */
  sha256?: string;
  requireX?: boolean;
  now?: number;
}

/** Validates a kind 24242 Blossom authorization event (BUD-11). Throws AuthError. */
export function verifyAuthEvent(event: NostrEvent, opts: VerifyAuthOptions): BlossomAuth {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (event.kind !== 24242) throw new AuthError("invalid auth kind");
  if (!verifyEvent(event)) throw new AuthError("invalid auth signature");
  if (event.created_at > now + CREATED_AT_SKEW) throw new AuthError("auth created_at is in the future");
  const exp = event.tags.find((t) => t[0] === "expiration")?.[1];
  if (!exp || !/^\d+$/.test(exp)) throw new AuthError("auth missing expiration");
  if (Number(exp) <= now) throw new AuthError("auth expired");
  const verbs = event.tags.filter((t) => t[0] === "t").map((t) => t[1]);
  if (!verbs.includes(opts.verb)) throw new AuthError(`auth t tag must be '${opts.verb}'`);
  const servers = event.tags.filter((t) => t[0] === "server").map((t) => (t[1] ?? "").toLowerCase());
  if (servers.length > 0 && !servers.some((s) => opts.domains.includes(normalizeServer(s)))) {
    throw new AuthError("auth not valid for this server");
  }
  const hashes = event.tags.filter((t) => t[0] === "x" && t[1]).map((t) => t[1].toLowerCase());
  if (opts.sha256) {
    if (opts.requireX && hashes.length === 0) throw new AuthError("auth missing x tag");
    if (hashes.length > 0 && !hashes.includes(opts.sha256)) throw new AuthError("auth x tag does not match blob");
  }
  return { pubkey: event.pubkey, event, hashes };
}

/** Tolerates clients that put a full URL into the `server` tag. */
function normalizeServer(value: string): string {
  try {
    if (value.includes("://")) return new URL(value).host;
  } catch {
    /* fallthrough */
  }
  return value.replace(/\/+$/, "");
}

/** Hostname and host:port of the public URL, used to match `server` tags. */
export function domainsFromPublicUrl(publicUrl: string): string[] {
  try {
    const u = new URL(publicUrl);
    return [...new Set([u.hostname.toLowerCase(), u.host.toLowerCase()])];
  } catch {
    return [];
  }
}

/** Parses + verifies in one step. Returns undefined when no header was sent. */
export function authenticate(header: string | null | undefined, opts: VerifyAuthOptions): BlossomAuth | undefined {
  const event = parseAuthHeader(header);
  if (!event) return undefined;
  return verifyAuthEvent(event, opts);
}
