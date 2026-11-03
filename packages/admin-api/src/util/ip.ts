import { parseIpv6 } from "@beamhop/sdk/net";

/** The address checks live in @beamhop/sdk/net (shared with Blossom's mirror guard and metrics). */
export { isForbiddenDestination, isOwnAddress, isPrivateAddress as isPrivateIp, setOwnAddressesForTest } from "@beamhop/sdk/net";

/** Expands an IPv6 address to 8 hextets (embedded dotted IPv4 tail allowed); null if it doesn't parse. */
export const ipv6Groups = (ip: string): number[] | null => parseIpv6(ip) ?? null;

/**
 * One spelling per IP rule: IPv6 lowercased and compressed (`2001:DB8:0::1` → `2001:db8::1`), the prefix without leading
 * zeros. Rules are stored, listed, removed and matched against connection addresses by this string, so two spellings of
 * one address must not make two rules (or a block that can't be lifted by the other spelling). Mapped IPv4 tails
 * (`::ffff:1.2.3.4`) keep their dotted form. Expects a valid rule (isValidCidr).
 */
export function canonicalCidr(cidr: string): string {
  const [ip, prefix] = cidr.trim().split("/");
  let addr = ip.toLowerCase();
  if (addr.includes(":") && !addr.includes(".")) {
    try {
      addr = new URL(`http://[${addr}]`).hostname.slice(1, -1);
    } catch {
      /* left as is */
    }
  }
  return prefix === undefined ? addr : `${addr}/${Number(prefix)}`;
}
