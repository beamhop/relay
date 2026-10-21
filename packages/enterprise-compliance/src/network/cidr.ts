// SPDX-License-Identifier: AGPL-3.0-or-later
/** IPv4 + IPv6 address / CIDR parsing and matching (no dependencies). */

export interface ParsedIp {
  v: 4 | 6;
  bytes: Uint8Array;
}

export interface Cidr {
  v: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
}

function parseV4(s: string): Uint8Array | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith('0')) return null; // no octal-looking parts
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(input: string): Uint8Array | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  let tail: Uint8Array | null = null;
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    tail = parseV4(last);
    if (!tail) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return null;
  let head: string[];
  let rest: string[];
  if (dbl >= 0) {
    head = s.slice(0, dbl) ? s.slice(0, dbl).split(':') : [];
    rest = s.slice(dbl + 2) ? s.slice(dbl + 2).split(':') : [];
    if (head.length + rest.length > 7) return null;
  } else {
    head = s.split(':');
    rest = [];
    if (head.length !== 8) return null;
  }
  const groups = [...head, ...new Array(8 - head.length - rest.length).fill('0'), ...rest];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = Number.parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

/** Parse an address; tolerates `[v6]`, `[v6]:port`, `v4:port` and zone ids. */
export function parseIp(raw: string): ParsedIp | null {
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return null;
    s = s.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    s = s.slice(0, s.lastIndexOf(':'));
  }
  const v4 = parseV4(s);
  if (v4) return { v: 4, bytes: v4 };
  const v6 = parseV6(s);
  if (!v6) return null;
  // IPv4-mapped (::ffff:a.b.c.d) → treat as IPv4 so v4 allowlists apply.
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    return { v: 4, bytes: v6.slice(12) };
  }
  return { v: 6, bytes: v6 };
}

export function parseCidr(raw: string): Cidr | null {
  const s = raw.trim();
  const slash = s.indexOf('/');
  const addr = slash >= 0 ? s.slice(0, slash) : s;
  const ip = parseIp(addr);
  if (!ip) return null;
  // `::ffff:10.0.0.0/104` style: keep it IPv6-mapped semantics by converting the prefix.
  const mapped = ip.v === 4 && addr.includes(':');
  const max = ip.v === 4 ? 32 : 128;
  let prefix = max;
  if (slash >= 0) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    if (mapped) {
      if (prefix < 96 || prefix > 128) return null;
      prefix -= 96;
    } else if (prefix > max) return null;
  }
  // Normalise host bits to zero.
  const bytes = new Uint8Array(ip.bytes);
  for (let bit = prefix; bit < max; bit++) {
    const i = bit >> 3;
    bytes[i] = (bytes[i] ?? 0) & ~(0x80 >> (bit & 7));
  }
  return { v: ip.v, bytes, prefix };
}

export function cidrContains(c: Cidr, ip: ParsedIp): boolean {
  if (c.v !== ip.v) return false;
  const full = c.prefix >> 3;
  for (let i = 0; i < full; i++) if (c.bytes[i] !== ip.bytes[i]) return false;
  const rem = c.prefix & 7;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return ((c.bytes[full] ?? 0) & mask) === ((ip.bytes[full] ?? 0) & mask);
}

/** A compiled allowlist. Empty list = no restriction. */
export class IpAllowlist {
  readonly cidrs: Cidr[];
  constructor(entries: string[]) {
    this.cidrs = [];
    for (const e of entries) {
      const c = parseCidr(e);
      if (!c) throw new Error(`not an IP address or range: ${e}`);
      this.cidrs.push(c);
    }
  }
  get empty(): boolean {
    return this.cidrs.length === 0;
  }
  allows(ip: string | undefined): boolean {
    if (this.empty) return true;
    if (!ip) return false;
    const p = parseIp(ip);
    if (!p) return false;
    return this.cidrs.some((c) => cidrContains(c, p));
  }
}

export function isValidCidr(s: string): boolean {
  return parseCidr(s) !== null;
}
