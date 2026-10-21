// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web Push, implemented directly on WebCrypto (Bun + Workers):
 * - RFC 8291 message encryption with RFC 8188 `aes128gcm` content coding.
 * - RFC 8292 VAPID: ES256 JWT, `Authorization: vapid t=<jwt>, k=<public key>`.
 */

type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

export function b64urlEncode(data: Uint8Array): string {
  let s = '';
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Bytes {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function copy(u: Uint8Array): Bytes {
  return new Uint8Array(u);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await crypto.subtle.importKey(
    'raw',
    copy(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, copy(data)));
}

/** JWK for a P-256 key from its 65-byte uncompressed public point (and optional 32-byte d). */
function p256Jwk(publicKey: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4)
    throw new Error('expected uncompressed P-256 point');
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(publicKey.slice(1, 33)),
    y: b64urlEncode(publicKey.slice(33, 65)),
    ext: true,
  };
  if (d) jwk.d = b64urlEncode(d);
  return jwk;
}

export interface EncryptOptions {
  /** Test hook: fixed 16-byte salt (random otherwise). */
  salt?: Uint8Array;
  /** Test hook: fixed application-server ECDH key pair (ephemeral otherwise). */
  serverKey?: { publicKey: Uint8Array; privateKey: Uint8Array };
  /** Record size (default 4096). */
  recordSize?: number;
}

/**
 * Encrypt a push message for a subscription (RFC 8291 §3.4, single record).
 * @param uaPublic subscription `keys.p256dh` (65 bytes)
 * @param authSecret subscription `keys.auth` (16 bytes)
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Bytes> {
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length + 17 > rs) throw new Error('push payload too large');
  const salt = opts.salt ? copy(opts.salt) : crypto.getRandomValues(new Uint8Array(16));

  let asPrivate: CryptoKey;
  let asPublic: Bytes;
  if (opts.serverKey) {
    asPublic = copy(opts.serverKey.publicKey);
    asPrivate = await crypto.subtle.importKey(
      'jwk',
      p256Jwk(opts.serverKey.publicKey, opts.serverKey.privateKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  }
  const uaKey = await crypto.subtle.importKey(
    'raw',
    copy(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256),
  );

  // RFC 8291 §3.3: combine ECDH secret with the auth secret.
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));

  // RFC 8188 §2.2/2.3: content-encryption key and nonce.
  const prk = await hmac(salt, ikm);
  const one = new Uint8Array([1]);
  const cekInfo = concat(enc.encode('Content-Encoding: aes128gcm\0'), one);
  const nonceInfo = concat(enc.encode('Content-Encoding: nonce\0'), one);
  const cek = (await hmac(prk, cekInfo)).slice(0, 16);
  const nonce = (await hmac(prk, nonceInfo)).slice(0, 12);

  // Single (last) record: plaintext || 0x02 delimiter, no extra padding.
  const padded = concat(plaintext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  return concat(header, asPublic, ct);
}

// ───────────────────────────── VAPID ─────────────────────────────

export interface VapidKeys {
  /** base64url 65-byte uncompressed public key (the PWA's applicationServerKey). */
  publicKey: string;
  privateJwk: JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64urlEncode(raw), privateJwk };
}

/** ES256 JWT for VAPID (RFC 8292 §2). */
export async function vapidJwt(
  keys: VapidKeys,
  audience: string,
  subject: string,
  expiresAt: number,
): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    enc.encode(JSON.stringify({ aud: audience, exp: expiresAt, sub: subject })),
  );
  const input = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'jwk',
    keys.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // WebCrypto ECDSA returns IEEE P1363 r||s (64 bytes), which is exactly JWS ES256.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input)),
  );
  return `${input}.${b64urlEncode(sig)}`;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushRequestOptions {
  ttl: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  /** Unix seconds; JWT expiry is now + 12 h. */
  now: number;
  subject: string;
}

/** Build the HTTP request that delivers `payload` to a push subscription. */
export async function buildPushRequest(
  sub: PushSubscriptionData,
  payload: Uint8Array,
  keys: VapidKeys,
  opts: PushRequestOptions,
): Promise<{ url: string; init: RequestInit }> {
  const body = await encryptPushPayload(
    payload,
    b64urlDecode(sub.keys.p256dh),
    b64urlDecode(sub.keys.auth),
  );
  const aud = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt(keys, aud, opts.subject, opts.now + 12 * 3600);
  const headers: Record<string, string> = {
    TTL: String(opts.ttl),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
  };
  if (opts.urgency) headers.Urgency = opts.urgency;
  if (opts.topic) headers.Topic = opts.topic;
  return { url: sub.endpoint, init: { method: 'POST', headers, body } };
}
