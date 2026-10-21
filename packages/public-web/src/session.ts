// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Portal sign-in: stateless HMAC challenges, NIP-98 (kind 27235) HTTP auth
 * verification and short-lived HMAC-signed session cookies (WebCrypto only).
 *
 * The HMAC secret is generated once and kept in the DocStore so every node
 * (and every Durable Object / Worker isolate) shares it.
 */
import {
  type NostrEvent,
  type Ports,
  tagValue,
  validateEventShape,
  verifyEvent,
} from '@beamhop/core';

export const SECRETS = 'public.secrets';
export const USED_CHALLENGES = 'public.challenges';
export const NIP98_KIND = 27235;
export const COOKIE = 'bh_portal';
/** Allowed clock skew for signed requests. */
export const MAX_SKEW_SECONDS = 60;
export const CHALLENGE_TTL_SECONDS = 300;

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const keys = new WeakMap<Ports, Promise<CryptoKey>>();

async function loadKey(ports: Ports): Promise<CryptoKey> {
  let secret = (await ports.docs.get<{ key: string }>(SECRETS, 'session'))?.key;
  if (!secret) {
    const fresh = { key: ports.crypto.randomHex(32) };
    await ports.docs.cas(SECRETS, 'session', null, fresh);
    secret = (await ports.docs.get<{ key: string }>(SECRETS, 'session'))?.key ?? fresh.key;
  }
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function hmac(ports: Ports, data: string): Promise<string> {
  let k = keys.get(ports);
  if (!k) {
    k = loadKey(ports);
    keys.set(ports, k);
    k.catch(() => keys.delete(ports));
  }
  const sig = await crypto.subtle.sign('HMAC', await k, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

// ───────────────────────────── challenges ─────────────────────────────

export async function issueChallenge(ports: Ports, relayId: string): Promise<string> {
  const body = `${relayId}.${ports.clock.now() + CHALLENGE_TTL_SECONDS}.${ports.crypto.randomHex(16)}`;
  return `${body}.${await hmac(ports, `challenge:${body}`)}`;
}

/** Validate and consume (single use) a challenge. */
export async function consumeChallenge(
  ports: Ports,
  relayId: string,
  challenge: string,
): Promise<boolean> {
  const parts = challenge.split('.');
  if (parts.length !== 4) return false;
  const [rid, exp, nonce, sig] = parts as [string, string, string, string];
  const body = `${rid}.${exp}.${nonce}`;
  if (!safeEqual(sig, await hmac(ports, `challenge:${body}`))) return false;
  if (rid !== relayId) return false;
  const expiresAt = Number(exp);
  const now = ports.clock.now();
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const fresh = await ports.docs.cas(USED_CHALLENGES, nonce, null, { expiresAt });
  if (!fresh) return false;
  await pruneChallenges(ports, now);
  return true;
}

async function pruneChallenges(ports: Ports, now: number): Promise<void> {
  const { items } = await ports.docs.list<{ expiresAt: number }>(USED_CHALLENGES, { limit: 50 });
  for (const it of items) {
    if (it.value.expiresAt < now) await ports.docs.delete(USED_CHALLENGES, it.key);
  }
}

// ───────────────────────────── NIP-98 ─────────────────────────────

export type Nip98Result =
  | { ok: true; pubkey: string; event: NostrEvent }
  | { ok: false; reason: string };

/**
 * Verify a NIP-98 `Authorization: Nostr <base64 event>` header for a request
 * to `url` with `method` and raw `body` (the `payload` tag must match the body hash).
 */
export async function verifyNip98(
  header: string | undefined,
  opts: { url: string; method: string; body: Uint8Array; now: number },
): Promise<Nip98Result> {
  if (!header?.startsWith('Nostr ')) return { ok: false, reason: 'missing auth' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromB64url(header.slice(6).trim())));
  } catch {
    return { ok: false, reason: 'malformed auth' };
  }
  const shape = validateEventShape(parsed);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  const ev = shape.event;
  if (ev.kind !== NIP98_KIND) return { ok: false, reason: 'wrong kind' };
  if (!verifyEvent(ev)) return { ok: false, reason: 'bad signature' };
  if (Math.abs(ev.created_at - opts.now) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };
  const u = tagValue(ev, 'u');
  if (!u || stripSlash(u) !== stripSlash(opts.url)) return { ok: false, reason: 'url mismatch' };
  if ((tagValue(ev, 'method') ?? '').toUpperCase() !== opts.method.toUpperCase())
    return { ok: false, reason: 'method mismatch' };
  const payload = tagValue(ev, 'payload');
  if (!payload || payload !== (await sha256Hex(opts.body)))
    return { ok: false, reason: 'payload mismatch' };
  return { ok: true, pubkey: ev.pubkey, event: ev };
}

const stripSlash = (u: string) => u.replace(/\/+$/, '');

// ───────────────────────────── session cookie ─────────────────────────────

export interface Session {
  pubkey: string;
  relayId: string;
  /** Unix seconds. */
  exp: number;
}

export async function signSession(ports: Ports, s: Session): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify([s.pubkey, s.relayId, s.exp])));
  return `${body}.${await hmac(ports, `session:${body}`)}`;
}

export async function readSession(
  ports: Ports,
  token: string | undefined,
  relayId: string,
): Promise<(Session & { token: string }) | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!safeEqual(sig, await hmac(ports, `session:${body}`))) return null;
  try {
    const [pubkey, rid, exp] = JSON.parse(new TextDecoder().decode(fromB64url(body))) as [
      string,
      string,
      number,
    ];
    if (rid !== relayId || typeof exp !== 'number' || exp < ports.clock.now()) return null;
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
    return { pubkey, relayId: rid, exp, token };
  } catch {
    return null;
  }
}

/** Per-session form token (double protection on top of SameSite=Strict). */
export function csrfToken(ports: Ports, sessionToken: string): Promise<string> {
  return hmac(ports, `csrf:${sessionToken}`);
}

// ───────────────────────────── npub ─────────────────────────────

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] as number;
  }
  return chk;
}

/** NIP-19 bech32 encoding of a hex key (`npub`), dependency-free. */
export function bech32Hex(hrp: string, hexStr: string): string {
  const bytes = hexStr.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? [];
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const hrpExp = [...hrp].map((c) => c.charCodeAt(0) >>> 5);
  hrpExp.push(0, ...[...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...hrpExp, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

export const npub = (pubkey: string) => bech32Hex('npub', pubkey);
