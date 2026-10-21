// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SSRF guard: refuse outbound requests to loopback, private, link-local and
 * other non-public addresses unless explicitly allowed. Runtime-agnostic: DNS
 * resolution is injected (Bun wires `node:dns`); without it only literal IPs
 * and well-known internal names are checked.
 */

export type ResolveHost = (hostname: string) => Promise<string[]>;

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function inV4Block(n: number, base: string, bits: number): boolean {
  const b = v4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) >>> 0 === (b & mask) >>> 0;
}

/** Expand an IPv6 literal to 8 hextets, or null. */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1).
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const n = v4ToInt(tail);
    if (n === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill('0'), ...rest];
  if (all.length !== 8) return null;
  const out: number[] = [];
  for (const h of all) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    out.push(Number.parseInt(h, 16));
  }
  return out;
}

/** True for any address that is not publicly routable. */
export function isPrivateAddress(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n !== null) {
    if (n === 0xffffffff) return true;
    return V4_BLOCKS.some(([b, bits]) => inV4Block(n, b, bits));
  }
  const h = v6Hextets(ip);
  if (!h) return false;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible / NAT64 (64:ff9b::/96).
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0);
  if (mapped || nat64) {
    const v4 = `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
    return isPrivateAddress(v4);
  }
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && h[1] === 0x0db8) return true; // documentation
  return false;
}

function isIpLiteral(host: string): boolean {
  return v4ToInt(host) !== null || v6Hextets(host) !== null;
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** Hostnames that are internal by name alone. */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === 'metadata.google.internal') return true;
  if (!h.includes('.') && !isIpLiteral(h)) return true; // single-label names (intranet)
  return INTERNAL_SUFFIXES.some((s) => h.endsWith(s));
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Throw SsrfError when `url` targets a non-public host. Only http(s) URLs are
 * allowed. With `resolveHost`, every resolved address is checked too.
 */
export async function assertPublicUrl(
  url: string | URL,
  opts: { allowPrivate?: boolean; resolveHost?: ResolveHost } = {},
): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SsrfError('That is not a valid web address');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new SsrfError('Only http and https addresses are allowed');
  }
  if (u.username || u.password) throw new SsrfError('Addresses with passwords are not allowed');
  if (opts.allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host))
      throw new SsrfError('Private or local network addresses are blocked');
    return u;
  }
  if (isInternalHostname(host))
    throw new SsrfError('Private or local network addresses are blocked');
  if (opts.resolveHost) {
    let addrs: string[] = [];
    try {
      addrs = await opts.resolveHost(host);
    } catch {
      throw new SsrfError(`Could not look up ${host}`);
    }
    if (addrs.length === 0) throw new SsrfError(`Could not look up ${host}`);
    if (addrs.some(isPrivateAddress)) {
      throw new SsrfError('That address points into a private or local network');
    }
  }
  return u;
}
