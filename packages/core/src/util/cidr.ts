/** IPv4/IPv6 parsing and CIDR matching using bigint arithmetic. */

export interface ParsedIp {
  v: 4 | 6;
  value: bigint;
}

function parseV4(s: string): bigint | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(s: string): bigint | undefined {
  let str = s;
  const zone = str.indexOf("%");
  if (zone >= 0) str = str.slice(0, zone);
  let tail: number[] = [];
  // embedded IPv4 suffix
  const lastColon = str.lastIndexOf(":");
  if (str.includes(".") && lastColon >= 0) {
    const v4 = parseV4(str.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    str = str.slice(0, lastColon) + ":0:0";
    tail.length = 2;
  }
  const dbl = str.split("::");
  if (dbl.length > 2) return undefined;
  const head = dbl[0] ? dbl[0].split(":") : [];
  const rest = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (dbl.length === 1 ? head.length !== 8 : fill < 1) return undefined;
  const groups = [...head, ...(dbl.length === 2 ? Array(fill).fill("0") : []), ...rest];
  if (groups.length !== 8) return undefined;
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    let n = parseInt(g, 16);
    if (tail.length && i >= 6) n = tail[i - 6];
    v = (v << 16n) | BigInt(n);
  }
  return v;
}

const V4_MAPPED_PREFIX = 0xffffn << 32n;

/** Parses an IP; IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalized to IPv4. */
export function parseIp(ip: string): ParsedIp | undefined {
  const s = ip.trim().replace(/^\[|\]$/g, "");
  if (!s) return undefined;
  if (!s.includes(":")) {
    const v = parseV4(s);
    return v === undefined ? undefined : { v: 4, value: v };
  }
  const v = parseV6(s);
  if (v === undefined) return undefined;
  if (v >> 32n === 0xffffn && (v & ~((1n << 32n) - 1n)) === V4_MAPPED_PREFIX) return { v: 4, value: v & 0xffffffffn };
  return { v: 6, value: v };
}

export interface Cidr {
  v: 4 | 6;
  network: bigint;
  mask: bigint;
}

export function parseCidr(cidr: string): Cidr | undefined {
  const [addr, bitsStr] = cidr.trim().split("/");
  const ip = parseIp(addr);
  if (!ip) return undefined;
  const width = ip.v === 4 ? 32 : 128;
  let bits = width;
  if (bitsStr !== undefined) {
    if (!/^\d{1,3}$/.test(bitsStr)) return undefined;
    bits = Number(bitsStr);
    // "::ffff:1.2.3.4/120" style: translate mapped prefix length into v4 length
    if (ip.v === 4 && addr.includes(":")) bits -= 96;
    if (bits < 0 || bits > width) return undefined;
  }
  const all = (1n << BigInt(width)) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(width - bits)) & all;
  return { v: ip.v, network: ip.value & mask, mask };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  return cidr.v === ip.v && (ip.value & cidr.mask) === cidr.network;
}

/** Convenience string-based matcher. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const p = parseIp(ip);
  const c = parseCidr(cidr);
  return !!p && !!c && cidrContains(c, p);
}

/**
 * Canonical key for an IP's network (used for per-IP rate limits and the per-network connection cap).
 * IPv4-mapped forms collapse to IPv4; IPv6 is aggregated to its /64, since a single client
 * typically controls a whole /64 and could otherwise rotate addresses for fresh buckets.
 */
export function ipKey(ip: string): string {
  const p = parseIp(ip);
  if (!p) return ip;
  return p.v === 4 ? `4:${p.value.toString(16)}` : `6:${(p.value >> 64n).toString(16)}/64`;
}

/** Key of an IPv6 address's /48 (typically one site or customer); undefined for IPv4 and unparsable input. */
export function ipSiteKey(ip: string): string | undefined {
  const p = parseIp(ip);
  return p?.v === 6 ? `6:${(p.value >> 80n).toString(16)}/48` : undefined;
}

/** Canonical key for one address (IPv4-mapped forms collapse to IPv4); unlike ipKey(), IPv6 is not aggregated. */
export function ipAddrKey(ip: string): string {
  const p = parseIp(ip);
  if (!p) return ip;
  return p.v === 4 ? `4:${p.value.toString(16)}` : `6:${p.value.toString(16)}`;
}
