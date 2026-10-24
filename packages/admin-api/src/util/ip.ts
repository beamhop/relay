import { isIP } from "node:net";

/** Expands an IPv6 address to 8 hextets (embedded dotted IPv4 tail allowed); null if it doesn't parse. */
export function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    s = `${s.slice(0, v4.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":") : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function ipv4Private(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
  );
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True for loopback, private, link-local, CGNAT, multicast, documentation and IPv4-embedding IPv6 ranges. */
export function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (fam === 4) return ipv4Private(ip);
  if (fam !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return ipv4Private(v4Of(g[6], g[7])); // ::ffff:a.b.c.d
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return ipv4Private(v4Of(g[6], g[7])); // ::ffff:0:a.b.c.d (IPv4-translated)
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // well-known NAT64 prefix 64:ff9b::/96 (DNS64 networks): judge the embedded IPv4; local-use 64:ff9b:1::/48 stays private
    return g.slice(2, 6).every((x) => x === 0) ? ipv4Private(v4Of(g[6], g[7])) : true;
  }
  if (g[0] === 0x2002) return ipv4Private(v4Of(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}
