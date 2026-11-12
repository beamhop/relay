import { parseIpv6 } from "@beamhop/sdk/net";

/** The address checks live in @beamhop/sdk/net (shared with Blossom's mirror guard and metrics). */
export { isForbiddenDestination, isOwnAddress, isPrivateAddress as isPrivateIp, setOwnAddressesForTest } from "@beamhop/sdk/net";

/** Expands an IPv6 address to 8 hextets (embedded dotted IPv4 tail allowed); null if it doesn't parse. */
export const ipv6Groups = (ip: string): number[] | null => parseIpv6(ip) ?? null;

/**
 * One spelling per IP rule: IPv6 lowercased and compressed (`2001:DB8:0::1` → `2001:db8::1`), the prefix without leading
 * zeros, a full-width prefix dropped (`1.2.3.4/32` → `1.2.3.4`, `2001:db8::1/128` → `2001:db8::1`) and host bits below
 * the prefix cleared (`10.1.2.3/8` → `10.0.0.0/8`). Rules are stored, listed, removed and matched against connection
 * addresses by this string, so two spellings of one address must not make two rules (or a block that can't be lifted by
 * the other spelling). Mapped IPv4 tails (`::ffff:1.2.3.4`) keep their dotted form. Expects a valid rule (isValidCidr).
 */
export function canonicalCidr(cidr: string): string {
  const [ip, rawPrefix] = cidr.trim().split("/");
  let addr = ip.toLowerCase();
  const dotted = addr.includes(".");
  const v6 = addr.includes(":");
  const width = v6 ? 128 : 32;
  let prefix = rawPrefix === undefined ? undefined : Number(rawPrefix);
  if (prefix === width) prefix = undefined;
  if (!v6) {
    if (prefix !== undefined) {
      const n = addr.split(".").reduce((a, o) => a * 256 + Number(o), 0);
      const masked = prefix === 0 ? 0 : n - (n % 2 ** (32 - prefix));
      addr = [24, 16, 8, 0].map((s) => Math.floor(masked / 2 ** s) % 256).join(".");
    }
  } else if (!dotted) {
    const groups = prefix === undefined ? null : parseIpv6(addr);
    if (groups && prefix !== undefined) {
      addr = groups
        .map((g, i) => {
          const keep = Math.max(0, Math.min(16, prefix - i * 16));
          return keep === 16 ? g : keep === 0 ? 0 : g & (0xffff << (16 - keep)) & 0xffff;
        })
        .map((g) => g.toString(16))
        .join(":");
    }
    try {
      addr = new URL(`http://[${addr}]`).hostname.slice(1, -1);
    } catch {
      /* left as is */
    }
  }
  return prefix === undefined ? addr : `${addr}/${prefix}`;
}
