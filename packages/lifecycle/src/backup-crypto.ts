// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Backup archive protection.
 *
 * - **Encryption** (when `ports.keyWrapper` exists, e.g. the enterprise key
 *   vault): the gzip'd tar is sealed with a fresh AES-256-GCM data key; the
 *   data key is wrapped by the KeyWrapper and stored in a small header:
 *
 *     "BHBKENC1" | u32 BE header length | header JSON | ciphertext
 *     header = { v: 1, alg: "A256GCM", provider, iv, wrappedKey }  (base64)
 *
 *   The header bytes are the GCM additional data, so tampering with the
 *   header or the ciphertext fails decryption.
 * - **Secret masking** (no KeyWrapper): passwords, tokens, keys and URL
 *   credentials in the archived config are replaced by `MASK` unless
 *   `backups.includeSecrets` is on.
 */
import type { KeyWrapper } from '@beamhop/core';

export const ENC_MAGIC = new TextEncoder().encode('BHBKENC1');
export const MASK = '********';

export interface EncHeader {
  v: 1;
  alg: 'A256GCM';
  provider: string;
  iv: string;
  wrappedKey: string;
}

/** Copy into a plain ArrayBuffer-backed view (WebCrypto BufferSource typing). */
const own = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function isEncryptedArchive(bytes: Uint8Array): boolean {
  if (bytes.length < ENC_MAGIC.length + 4) return false;
  for (let i = 0; i < ENC_MAGIC.length; i++) if (bytes[i] !== ENC_MAGIC[i]) return false;
  return true;
}

export async function encryptArchive(plain: Uint8Array, wrapper: KeyWrapper): Promise<Uint8Array> {
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: EncHeader = {
    v: 1,
    alg: 'A256GCM',
    provider: wrapper.provider,
    iv: b64(iv),
    wrappedKey: b64(await wrapper.wrap(dataKey)),
  };
  const hdr = new TextEncoder().encode(JSON.stringify(header));
  const key = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['encrypt']);
  dataKey.fill(0);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: hdr }, key, own(plain)),
  );
  const out = new Uint8Array(ENC_MAGIC.length + 4 + hdr.length + ct.length);
  out.set(ENC_MAGIC, 0);
  new DataView(out.buffer).setUint32(ENC_MAGIC.length, hdr.length);
  out.set(hdr, ENC_MAGIC.length + 4);
  out.set(ct, ENC_MAGIC.length + 4 + hdr.length);
  return out;
}

export function readEncHeader(bytes: Uint8Array): {
  header: EncHeader;
  hdr: Uint8Array;
  body: Uint8Array;
} {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    ENC_MAGIC.length,
  );
  const start = ENC_MAGIC.length + 4;
  if (start + len > bytes.length) throw new Error('the encrypted backup header is damaged');
  const hdr = bytes.subarray(start, start + len);
  const header = JSON.parse(new TextDecoder().decode(hdr)) as EncHeader;
  if (header.v !== 1 || header.alg !== 'A256GCM')
    throw new Error(`unsupported backup encryption ${header.alg}@${header.v}`);
  return { header, hdr, body: bytes.subarray(start + len) };
}

export async function decryptArchive(
  bytes: Uint8Array,
  wrapper: KeyWrapper | undefined,
): Promise<Uint8Array> {
  const { header, hdr, body } = readEncHeader(bytes);
  if (!wrapper)
    throw new Error(
      `This backup is encrypted; the key service (${header.provider}) is needed to read it`,
    );
  const unwrapped = await wrapper.unwrap(unb64(header.wrappedKey));
  const dataKey = own(unwrapped);
  unwrapped.fill(0);
  const key = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['decrypt']);
  dataKey.fill(0);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(header.iv), additionalData: own(hdr) },
        key,
        own(body),
      ),
    );
  } catch {
    throw new Error('The encrypted backup could not be decrypted (wrong key or damaged file)');
  }
}

const SECRET_KEY =
  /(secret|password|passwd|passphrase|token|api[-_]?key|private[-_]?key|access[-_]?key|client[-_]?secret|credential|salt|webhook|signing[-_]?key|dsn)/i;

/** Mask credentials in a URL string (`scheme://user:pass@host` → `user:********@`). */
function maskUrl(s: string): string {
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@\s]*):[^/@\s]+@/i, `$1:${MASK}@`);
}

/** Deep copy of `value` with secret-looking fields and URL passwords masked. */
export function maskSecrets<T>(value: T): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') {
      if (key !== null && SECRET_KEY.test(key) && v !== '') return MASK;
      return maskUrl(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value, null) as T;
}
