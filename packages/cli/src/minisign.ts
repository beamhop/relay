// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minisign (https://jedisct1.github.io/minisign/) signature verification for
 * release downloads, on Ed25519 from @noble/curves.
 *
 * Public key: base64 of `"Ed" || key id (8 bytes) || Ed25519 public key (32)`,
 * optionally inside a key file (`untrusted comment:` line first).
 *
 * Signature file (`.minisig`):
 *   untrusted comment: <text>
 *   base64("Ed" | "ED" || key id (8) || signature (64))
 *   trusted comment: <text>
 *   base64(global signature (64))
 * `Ed` signs the file bytes; `ED` (minisign's default since 0.10) signs
 * BLAKE2b-512(file). The global signature covers `signature || trusted comment`.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2b';

export interface MinisignPublicKey {
  keyId: Uint8Array;
  key: Uint8Array;
}

export interface MinisignSignature {
  algorithm: 'Ed' | 'ED';
  keyId: Uint8Array;
  signature: Uint8Array;
  trustedComment: string;
  globalSignature: Uint8Array;
}

export type MinisignResult = { ok: true; trustedComment: string } | { ok: false; reason: string };

const enc = new TextEncoder();

function b64(s: string): Uint8Array {
  return Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Key id as minisign prints it (little-endian 64-bit, uppercase hex). */
export function keyIdHex(id: Uint8Array): string {
  return hex(Uint8Array.from(id).reverse()).toUpperCase();
}

/** Parse a public key (the base64 line, or a whole `minisign.pub` file). */
export function parsePublicKey(text: string): MinisignPublicKey {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('untrusted comment:'));
  const raw = b64(lines[0] ?? '');
  if (raw.length !== 42 || raw[0] !== 0x45 || raw[1] !== 0x64)
    throw new Error('not a minisign Ed25519 public key');
  return { keyId: raw.slice(2, 10), key: raw.slice(10, 42) };
}

/** Parse a `.minisig` file (also accepted: the same text base64-encoded as one line). */
export function parseSignature(text: string): MinisignSignature {
  let t = text.trim();
  if (!t.includes('\n') && !t.startsWith('untrusted comment:')) {
    try {
      const decoded = new TextDecoder().decode(b64(t));
      if (decoded.includes('trusted comment:')) t = decoded.trim();
    } catch {
      // not base64
    }
  }
  const lines = t.split(/\r?\n/).map((l) => l.trimEnd());
  const sigLine = lines.find((l, i) => i > 0 && l && !l.includes(':')) ?? lines[1] ?? '';
  const tcIdx = lines.findIndex((l) => l.startsWith('trusted comment: '));
  if (tcIdx < 0) throw new Error('the signature has no trusted comment');
  const raw = b64(sigLine);
  if (raw.length !== 74) throw new Error('the signature has the wrong length');
  const alg = String.fromCharCode(raw[0] as number, raw[1] as number);
  if (alg !== 'Ed' && alg !== 'ED') throw new Error(`unsupported signature algorithm ${alg}`);
  const global = b64(lines[tcIdx + 1] ?? '');
  if (global.length !== 64) throw new Error('the global signature has the wrong length');
  return {
    algorithm: alg,
    keyId: raw.slice(2, 10),
    signature: raw.slice(10, 74),
    trustedComment: (lines[tcIdx] as string).slice('trusted comment: '.length),
    globalSignature: global,
  };
}

/** Verify `data` against a minisign signature and public key. Never throws. */
export function verifyMinisign(
  data: Uint8Array,
  signatureText: string,
  publicKeyText: string,
): MinisignResult {
  let pk: MinisignPublicKey;
  let sig: MinisignSignature;
  try {
    pk = parsePublicKey(publicKeyText);
    sig = parseSignature(signatureText);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!eq(pk.keyId, sig.keyId))
    return {
      ok: false,
      reason: `signed with key ${keyIdHex(sig.keyId)}, expected ${keyIdHex(pk.keyId)}`,
    };
  const message = sig.algorithm === 'ED' ? blake2b(data, { dkLen: 64 }) : data;
  try {
    if (!ed25519.verify(sig.signature, message, pk.key))
      return { ok: false, reason: 'the signature does not match the file' };
    const global = new Uint8Array(64 + enc.encode(sig.trustedComment).length);
    global.set(sig.signature, 0);
    global.set(enc.encode(sig.trustedComment), 64);
    if (!ed25519.verify(sig.globalSignature, global, pk.key))
      return { ok: false, reason: 'the trusted comment was tampered with' };
  } catch (err) {
    return { ok: false, reason: `invalid signature: ${(err as Error).message}` };
  }
  return { ok: true, trustedComment: sig.trustedComment };
}

/** Sign like `minisign -S` (prehashed `ED`); used by tests and release tooling. */
export function signMinisign(
  data: Uint8Array,
  secretKey: Uint8Array,
  keyId: Uint8Array,
  trustedComment = `timestamp:${Math.floor(Date.now() / 1000)}`,
  untrustedComment = 'signature from beamhop release key',
): string {
  const sig = ed25519.sign(blake2b(data, { dkLen: 64 }), secretKey);
  const head = new Uint8Array(74);
  head.set(enc.encode('ED'), 0);
  head.set(keyId, 2);
  head.set(sig, 10);
  const tc = enc.encode(trustedComment);
  const global = new Uint8Array(64 + tc.length);
  global.set(sig, 0);
  global.set(tc, 64);
  const gsig = ed25519.sign(global, secretKey);
  const b = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return `untrusted comment: ${untrustedComment}\n${b(head)}\ntrusted comment: ${trustedComment}\n${b(gsig)}\n`;
}

/** Public key line (`RW…`) for a secret key + key id. */
export function publicKeyLine(secretKey: Uint8Array, keyId: Uint8Array): string {
  const raw = new Uint8Array(42);
  raw.set(enc.encode('Ed'), 0);
  raw.set(keyId, 2);
  raw.set(ed25519.getPublicKey(secretKey), 10);
  return btoa(String.fromCharCode(...raw));
}
