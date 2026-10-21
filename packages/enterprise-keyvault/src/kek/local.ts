// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Local master key KEK: a 32-byte random key (env/file), expanded with HKDF-SHA256
 * into an AES-256-GCM wrapping key. No password stretching: the input must already
 * be a high-entropy key, and weak-looking keys are refused.
 */
import { buf, concat, fromB64, fromHex, sha256, toHex, utf8, zeroize } from '../bytes.ts';
import type { KekProvider } from './types.ts';

const SALT = utf8.encode('beamhop-keyvault/kek/v1');
const AAD = utf8.encode('beamhop-keyvault/kek-wrap/v1');
const IV_LEN = 12;

export class WeakKeyError extends Error {}

/** Parse a 32-byte key from base64 or hex and refuse obviously weak material. */
export function parseMasterKey(input: string): Uint8Array {
  const s = input.trim();
  let raw: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(s)) raw = fromHex(s);
  else {
    try {
      raw = fromB64(s.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      throw new WeakKeyError('The master key must be 32 random bytes (base64 or hex)');
    }
  }
  assertStrong(raw);
  return raw;
}

export function assertStrong(raw: Uint8Array): void {
  if (raw.length !== 32)
    throw new WeakKeyError(`The master key must be exactly 32 bytes (got ${raw.length})`);
  const distinct = new Set(raw).size;
  // 32 random bytes have ~30 distinct values; < 16 means patterns, repeats or text.
  if (distinct < 16) throw new WeakKeyError('The master key looks weak: generate a random one');
  let printable = 0;
  for (const b of raw) if (b >= 0x20 && b < 0x7f) printable++;
  if (printable === raw.length)
    throw new WeakKeyError('The master key looks like text: use 32 random bytes instead');
  let ascending = true;
  for (let i = 1; i < raw.length; i++)
    if (raw[i] !== ((raw[i - 1] as number) + 1) % 256) ascending = false;
  if (ascending) throw new WeakKeyError('The master key looks weak: generate a random one');
}

export class LocalMasterKeyWrapper implements KekProvider {
  readonly provider = 'local';
  private constructor(
    readonly id: string,
    private readonly key: CryptoKey,
  ) {}

  /** `raw` is zeroized after derivation. */
  static async create(raw: Uint8Array): Promise<LocalMasterKeyWrapper> {
    assertStrong(raw);
    try {
      const ikm = await crypto.subtle.importKey('raw', buf(raw), 'HKDF', false, [
        'deriveKey',
        'deriveBits',
      ]);
      const key = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: buf(SALT), info: buf(utf8.encode('wrap')) },
        ikm,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const idBits = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'HKDF', hash: 'SHA-256', salt: buf(SALT), info: buf(utf8.encode('id')) },
          ikm,
          256,
        ),
      );
      const id = `local:${toHex((await sha256(idBits)).subarray(0, 8))}`;
      return new LocalMasterKeyWrapper(id, key);
    } finally {
      zeroize(raw);
    }
  }

  static fromString(s: string): Promise<LocalMasterKeyWrapper> {
    return LocalMasterKeyWrapper.create(parseMasterKey(s));
  }

  async wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: buf(AAD) },
        this.key,
        buf(plaintext),
      ),
    );
    return concat(iv, ct);
  }

  async unwrap(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (ciphertext.length < IV_LEN + 16) throw new Error('wrapped key is truncated');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(ciphertext.subarray(0, IV_LEN)), additionalData: buf(AAD) },
      this.key,
      buf(ciphertext.subarray(IV_LEN)),
    );
    return new Uint8Array(pt);
  }
}
