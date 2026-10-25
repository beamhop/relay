/**
 * IP address handling shared by the relay, Blossom, the admin API and metrics: parsing (one IPv4 and one IPv6
 * parser), CIDR matching, the keys rate limits and connection caps are counted under, and the "is this address
 * public?" checks the outbound-request guards and GeoIP rely on.
 */
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

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

/**
 * Expands an IPv6 literal into 8 16-bit groups: brackets and a zone (`%eth0`) are dropped, an embedded dotted IPv4
 * tail (`::ffff:1.2.3.4`) is allowed. Undefined when it isn't one.
 */
export function parseIpv6(input: string): number[] | undefined {
  let v = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = v.indexOf("%");
  if (zone >= 0) v = v.slice(0, zone);
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v);
  if (dotted) {
    const p = dotted[2].split(".").map(Number);
    if (p.some((n) => n > 255)) return undefined;
    tail.push((p[0] << 8) | p[1], (p[2] << 8) | p[3]);
    v = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = v.split("::");
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === "" ? [] : s.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fixed = head.length + rest.length + tail.length;
  if ([...head, ...rest].some(Number.isNaN)) return undefined;
  if (halves.length === 1 && fixed !== 8) return undefined;
  if (halves.length === 2 && fixed > 7) return undefined;
  return [...head, ...new Array<number>(8 - fixed).fill(0), ...rest, ...tail];
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
  const g = parseIpv6(s);
  if (!g) return undefined;
  const v = g.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n);
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

/**
 * A client address as the server adapters and Blossom report it: brackets and an IPv4 port stripped, the
 * IPv4-mapped IPv6 prefix dropped. Empty input is "unknown".
 */
export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return "unknown";
  let s = ip.trim();
  if (s.startsWith("[")) s = s.slice(1, s.indexOf("]"));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  if (s.toLowerCase().startsWith("::ffff:") && s.includes(".")) s = s.slice(7);
  return s || "unknown";
}

/** Non-public IPv4 ranges (RFC 6890 special-purpose incl. documentation and benchmarking, multicast, reserved). */
function v4Private(hi: number, lo: number): boolean {
  const a = hi >> 8;
  const b = hi & 255;
  const c = lo >> 8;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
  );
}

/**
 * True for every address that isn't plainly public: loopback, private, CGNAT, link-local, multicast, documentation
 * and benchmarking ranges, IPv6 ULA / site-local / discard / Teredo, IPv4-embedding IPv6 (mapped, translated, 6to4,
 * NAT64 — judged by the embedded IPv4; all of ::/96 and the local-use NAT64 ranges count as private) and anything
 * that isn't an IP at all. Pure: this host's own public addresses are `isOwnAddress`.
 */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const fam = isIP(bare);
  if (fam === 4) {
    const v = Number(parseV4(bare));
    return v4Private(v >>> 16, v & 0xffff);
  }
  if (fam !== 6) return true;
  const g = parseIpv6(bare);
  if (!g) return true;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 6)) return true; // ::, ::1, IPv4-compatible ::a.b.c.d
  if (zero(0, 5) && g[5] === 0xffff) return v4Private(g[6], g[7]); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4Private(g[6], g[7]); // ::ffff:0:a.b.c.d (IPv4-translated)
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // well-known NAT64 prefix 64:ff9b::/96 (DNS64 networks): judge the embedded IPv4; local-use 64:ff9b:1::/48 and the rest stay private
    return zero(2, 6) ? v4Private(g[6], g[7]) : true;
  }
  if (g[0] === 0x2002) return v4Private(g[1], g[2]); // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  if (g[0] === 0x100 && zero(1, 4)) return true; // discard-only 100::/64
  // ULA fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

/** One spelling per address: IPv6 as its 8 hextets, an IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as the IPv4. */
function canonicalIp(ip: string): string {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(bare) !== 6) return bare;
  const g = parseIpv6(bare);
  if (!g) return bare;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return g.map((x) => x.toString(16)).join(":");
}

const OWN_ADDRESSES_TTL_MS = 60_000;
let ownAddresses: { at: number; set: Set<string> } | undefined;

/** for tests: the interface list to use instead of the host's (null: back to the host's) */
export function setOwnAddressesForTest(list: string[] | null): void {
  ownAddresses = list ? { at: Infinity, set: new Set(list.map(canonicalIp)) } : undefined;
}

/**
 * Addresses bound to this host's interfaces, in any spelling — including a public IP on a VPS, which no range check
 * catches but which reaches the host's own services over `lo`. Re-read once a minute.
 */
export function isOwnAddress(ip: string): boolean {
  if (!ownAddresses || Date.now() - ownAddresses.at > OWN_ADDRESSES_TTL_MS) {
    const set = new Set<string>();
    try {
      for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) set.add(canonicalIp(a.address));
    } catch {
      /* unavailable (sandbox): the range checks still apply */
    }
    ownAddresses = { at: Date.now(), set };
  }
  return ownAddresses.set.has(canonicalIp(ip));
}

/** Where the server must never send requests on a user's behalf: non-public ranges and this host's own addresses. */
export const isForbiddenDestination = (ip: string): boolean => isPrivateAddress(ip) || isOwnAddress(ip);
