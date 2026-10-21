// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import {
  b64urlDecode,
  b64urlEncode,
  buildPushRequest,
  concat,
  encryptPushPayload,
  generateVapidKeys,
  vapidJwt,
} from '../src/webpush.ts';

// RFC 8291 §5 test vector.
const V = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(data)));
}

/** Reference user-agent side decryption (RFC 8291 §3.4 reversed). */
async function decrypt(
  body: Uint8Array,
  uaPublic: Uint8Array,
  uaPrivate: Uint8Array,
  auth: Uint8Array,
): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const enc = new TextEncoder();
  const priv = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: b64urlEncode(uaPrivate),
      x: b64urlEncode(uaPublic.slice(1, 33)),
      y: b64urlEncode(uaPublic.slice(33)),
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const pub = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(asPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256),
  );
  const prkKey = await hmac(auth, secret);
  const ikm = await hmac(
    prkKey,
    concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])),
  );
  const prk = await hmac(salt, ikm);
  const cek = (
    await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))
  ).slice(0, 16);
  const nonce = (
    await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))
  ).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, new Uint8Array(ct)),
  );
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return padded.slice(0, end);
}

describe('RFC 8291 web push encryption', () => {
  test('matches the RFC 8291 §5 test vector byte for byte', async () => {
    const out = await encryptPushPayload(
      b64urlDecode(V.plaintext),
      b64urlDecode(V.uaPublic),
      b64urlDecode(V.auth),
      {
        salt: b64urlDecode(V.salt),
        serverKey: { publicKey: b64urlDecode(V.asPublic), privateKey: b64urlDecode(V.asPrivate) },
      },
    );
    expect(b64urlEncode(out)).toBe(V.message);
  });

  test('random-key messages decrypt with the subscriber key', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', ua.privateKey);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const msg = new TextEncoder().encode(JSON.stringify({ title: 'Disk is filling up' }));
    const body = await encryptPushPayload(msg, uaPub, auth);
    const plain = await decrypt(body, uaPub, b64urlDecode(jwk.d!), auth);
    expect(new TextDecoder().decode(plain)).toBe('{"title":"Disk is filling up"}');
  });
});

describe('VAPID (RFC 8292)', () => {
  test('JWT verifies with the advertised public key and request carries headers', async () => {
    const keys = await generateVapidKeys();
    const jwt = await vapidJwt(keys, 'https://push.example.net', 'mailto:ops@example.com', 1000);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c)))).toEqual({
      aud: 'https://push.example.net',
      exp: 1000,
      sub: 'mailto:ops@example.com',
    });
    const pub = await crypto.subtle.importKey(
      'raw',
      b64urlDecode(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);

    const req = await buildPushRequest(
      { endpoint: 'https://push.example.net/send/abc', keys: { p256dh: V.uaPublic, auth: V.auth } },
      new TextEncoder().encode('hi'),
      keys,
      { ttl: 60, urgency: 'high', now: 0, subject: 'mailto:ops@example.com' },
    );
    const headers = req.init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe('60');
    expect(headers.Urgency).toBe('high');
    expect(headers.Authorization).toStartWith('vapid t=');
    expect(headers.Authorization).toEndWith(`, k=${keys.publicKey}`);
  });
});
