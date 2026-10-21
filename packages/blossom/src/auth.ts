// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Blossom authorization (kind 24242), sent as `Authorization: Nostr <base64(event)>`.
 * Checks: signature, kind, `t` verb, `expiration` in the future, `created_at`
 * not in the future, and optional `server` scoping (BUD-11 style).
 */
import {
  type NostrEvent,
  tagValue,
  tagValues,
  validateEventShape,
  verifyEvent,
} from '@beamhop/core';

export const BLOSSOM_AUTH_KIND = 24242;

export type AuthVerb = 'get' | 'upload' | 'list' | 'delete' | 'media';

export type AuthResult =
  | { ok: true; event: NostrEvent; pubkey: string; hashes: string[] }
  | { ok: false; status: 401 | 403; reason: string; missing?: boolean };

export interface AuthCheckOptions {
  /** Unix seconds. */
  now: number;
  /** Request host (no port), for `server` tag scoping. */
  host?: string;
  /** Clock skew tolerance for `created_at`, seconds. Default 60. */
  skewSeconds?: number;
}

function decodeBase64(s: string): string {
  const norm = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function hostOf(server: string): string {
  try {
    return new URL(server.includes('://') ? server : `https://${server}`).hostname.toLowerCase();
  } catch {
    return server.toLowerCase();
  }
}

export function checkAuth(
  header: string | null | undefined,
  verb: AuthVerb,
  opts: AuthCheckOptions,
): AuthResult {
  if (!header) return { ok: false, status: 401, reason: 'Sign-in required', missing: true };
  const m = /^nostr\s+(.+)$/i.exec(header.trim());
  if (!m?.[1]) return { ok: false, status: 401, reason: 'Invalid auth: expected "Nostr <base64>"' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64(m[1]));
  } catch {
    return { ok: false, status: 401, reason: 'Invalid auth: malformed event' };
  }
  const shape = validateEventShape(parsed);
  if (!shape.ok) return { ok: false, status: 401, reason: `Invalid auth: ${shape.reason}` };
  const event = shape.event;
  if (event.kind !== BLOSSOM_AUTH_KIND) {
    return { ok: false, status: 401, reason: `Invalid auth: kind must be ${BLOSSOM_AUTH_KIND}` };
  }
  if (!verifyEvent(event)) return { ok: false, status: 401, reason: 'Invalid auth: bad signature' };
  const skew = opts.skewSeconds ?? 60;
  if (event.created_at > opts.now + skew) {
    return { ok: false, status: 401, reason: 'Invalid auth: created in the future' };
  }
  const exp = Number(tagValue(event, 'expiration'));
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: false, status: 401, reason: 'Invalid auth: missing expiration' };
  }
  if (exp <= opts.now) return { ok: false, status: 401, reason: 'Auth expired' };
  const t = tagValue(event, 't');
  if (t !== verb) {
    return {
      ok: false,
      status: 401,
      reason: `Invalid auth: expected t=${verb}, got ${t ?? 'none'}`,
    };
  }
  const servers = tagValues(event, 'server');
  if (servers.length && opts.host) {
    const host = opts.host.toLowerCase().replace(/:\d+$/, '');
    if (!servers.some((s) => hostOf(s) === host)) {
      return { ok: false, status: 403, reason: 'Auth is for a different server' };
    }
  }
  return { ok: true, event, pubkey: event.pubkey, hashes: tagValues(event, 'x') };
}
