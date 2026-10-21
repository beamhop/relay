// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NIP-98 HTTP auth verification (kind 27235), used by NIP-07 / NIP-46
 * signers for login and by NIP-86 clients. Uses the kernel clock (not
 * wall time) and refuses replays of the same auth event.
 */
import {
  type NostrEvent,
  type Ports,
  tagValue,
  validateEventShape,
  verifyEvent,
} from '@beamhop/core';
import { unpackEventFromToken } from 'nostr-tools/nip98';
import { COL } from '../settings.ts';
import { sha256Hex } from '../util.ts';

export const NIP98_KIND = 27235;
const WINDOW_SECONDS = 60;

export type Nip98Result = { ok: true; event: NostrEvent } | { ok: false; reason: string };

/** Candidate URLs the signer may have used for this request (proxy-aware when trusted). */
export function requestUrls(req: Request, trustProxy: boolean): string[] {
  const url = new URL(req.url);
  const out = new Set<string>([url.toString()]);
  if (trustProxy) {
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    if (proto || host) {
      const f = new URL(url.toString());
      if (proto) f.protocol = `${proto}:`;
      if (host) f.host = host;
      out.add(f.toString());
    }
  }
  return [...out];
}

function stripSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

export async function verifyNip98(
  ports: Ports,
  req: Request,
  opts: { trustProxy: boolean; body?: Uint8Array; consume?: boolean },
): Promise<Nip98Result> {
  const header = req.headers.get('authorization');
  if (!header || !/^nostr\s/i.test(header))
    return { ok: false, reason: 'missing Nostr authorization' };
  let event: NostrEvent;
  try {
    event = (await unpackEventFromToken(header.replace(/^nostr\s+/i, 'Nostr '))) as NostrEvent;
  } catch {
    return { ok: false, reason: 'malformed NIP-98 token' };
  }
  if (event.kind !== NIP98_KIND) return { ok: false, reason: 'wrong kind' };
  if (!validateEventShape(event).ok || !verifyEvent(event))
    return { ok: false, reason: 'bad signature' };
  const now = ports.clock.now();
  if (Math.abs(now - event.created_at) > WINDOW_SECONDS)
    return { ok: false, reason: 'auth event is too old or in the future' };
  const u = tagValue(event, 'u');
  const candidates = requestUrls(req, opts.trustProxy).map(stripSlash);
  if (!u || !candidates.includes(stripSlash(u))) return { ok: false, reason: 'url mismatch' };
  const method = tagValue(event, 'method');
  if (!method || method.toUpperCase() !== req.method.toUpperCase())
    return { ok: false, reason: 'method mismatch' };
  const payloadTag = tagValue(event, 'payload');
  const body = opts.body;
  if (body && body.length > 0) {
    if (!payloadTag) return { ok: false, reason: 'payload tag required for requests with a body' };
    if ((await sha256Hex(body)) !== payloadTag.toLowerCase())
      return { ok: false, reason: 'payload hash mismatch' };
  } else if (payloadTag && payloadTag !== (await sha256Hex(new Uint8Array()))) {
    return { ok: false, reason: 'payload hash mismatch' };
  }
  if (opts.consume !== false) {
    const fresh = await ports.docs.cas(COL.nip98Seen, event.id, null, {
      exp: event.created_at + WINDOW_SECONDS * 2,
    });
    if (!fresh) return { ok: false, reason: 'auth event already used' };
  }
  return { ok: true, event };
}

export async function gcNip98(ports: Ports): Promise<void> {
  const now = ports.clock.now();
  const page = await ports.docs.list<{ exp: number }>(COL.nip98Seen, { limit: 1000 });
  for (const i of page.items) if (i.value.exp < now) await ports.docs.delete(COL.nip98Seen, i.key);
}
