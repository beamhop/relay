// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small runtime-agnostic helpers (Web APIs only). */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function b64encode(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const pad = clean.length % 4 === 0 ? '' : '='.repeat(4 - (clean.length % 4));
  const bin = atob(clean + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function buf(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return b as Uint8Array<ArrayBuffer>;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(bytes)));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(data));
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    buf(utf8(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, buf(utf8(data)))));
}

/** Deterministic JSON (sorted keys) for hashing and equality. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x ?? null)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function collect(
  data: Uint8Array | ReadableStream<Uint8Array>,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  const parts: Uint8Array[] = [];
  let n = 0;
  const reader = data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) {
      await reader.cancel();
      throw new Error('stream too large');
    }
    parts.push(value);
  }
  return concat(parts);
}

/** Zero-padded sortable key for sequence numbers / timestamps. */
export function padKey(n: number, width = 15): string {
  return String(Math.max(0, Math.floor(n))).padStart(width, '0');
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;
}

export function shortKey(pubkey: string): string {
  return pubkey.length > 12 ? `${pubkey.slice(0, 8)}…` : pubkey;
}

/** Remove obviously secret fields before data leaves the process (SIEM, approvals list). */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = /secret|password|token|privkey|private|nsec|apikey|api_key|credential/i.test(k)
      ? '[redacted]'
      : redact(val, depth + 1);
  }
  return out;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
