// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small byte helpers (Web-standard only). */

export const utf8 = new TextEncoder();
export const fromUtf8 = new TextDecoder();

export function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64Url(u: Uint8Array): string {
  return toB64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromB64(b + '='.repeat((4 - (b.length % 4)) % 4));
}

export function toHex(u: Uint8Array): string {
  let s = '';
  for (const b of u) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Best-effort zeroization: overwrite key material once it is no longer needed. */
export function zeroize(...bufs: Array<Uint8Array | undefined | null>): void {
  for (const b of bufs) b?.fill(0);
}

/** Copy into a fresh ArrayBuffer-backed array (WebCrypto `BufferSource` typing). */
export function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(u.length));
  out.set(u);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(data)));
}

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}
