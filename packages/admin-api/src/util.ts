// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small runtime-agnostic helpers (Web APIs only). */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const enc = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(digest));
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function b64urlEncode(b: Uint8Array): string {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time string comparison (for hashes/codes of equal length). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
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

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Zero-padded sortable key for sequence numbers. */
export function seqKey(n: number): string {
  return String(n).padStart(12, '0');
}

/** Human-friendly one-time code, e.g. `K7QX-2M9P-AB3D`. Unambiguous alphabet. */
export function humanCode(groups = 3): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(groups * 4));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  const out: string[] = [];
  for (let g = 0; g < groups; g++) out.push(chars.slice(g * 4, g * 4 + 4).join(''));
  return out.join('-');
}

/** Normalize a user-typed code (case, spaces, dashes) before hashing. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface ApiError {
  code: string;
  message: string;
  technical?: string;
  issues?: unknown;
}

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly technical?: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

export function errorBody(e: HttpError): { error: ApiError } {
  const error: ApiError = { code: e.code, message: e.message };
  if (e.technical) error.technical = e.technical;
  if (e.issues !== undefined) error.issues = e.issues;
  return { error };
}

export function fail(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  technical?: string,
): Response {
  return c.json(errorBody(new HttpError(status, code, message, technical)), status);
}

const SECRET_KEY = /secret|password|apikey|api_key|privatekey|nsec|bottoken|webhookurl|smtpurl/i;

/** Redact secret-looking fields before logging/auditing/streaming. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && x !== undefined && x !== null ? '•••' : redact(x, depth + 1);
  }
  return out;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Lowercase the first letter of a sentence fragment unless it looks like an acronym. */
export function lowerFirst(s: string): string {
  if (s.length < 2) return s.toLowerCase();
  if (s[1] && s[1] === s[1].toUpperCase() && /[A-Z]/.test(s[1])) return s;
  return s[0]!.toLowerCase() + s.slice(1);
}
