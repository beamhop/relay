import { parseIpv6 } from "@beamhop/sdk/net";

/** The address checks live in @beamhop/sdk/net (shared with Blossom's mirror guard and metrics). */
export { isForbiddenDestination, isOwnAddress, isPrivateAddress as isPrivateIp, setOwnAddressesForTest } from "@beamhop/sdk/net";

/** Expands an IPv6 address to 8 hextets (embedded dotted IPv4 tail allowed); null if it doesn't parse. */
export const ipv6Groups = (ip: string): number[] | null => parseIpv6(ip) ?? null;
