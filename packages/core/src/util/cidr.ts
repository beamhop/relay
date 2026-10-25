/** IP parsing, CIDR matching and rate-limit keys now live in @beamhop/sdk/net; re-exported for existing importers. */
export { cidrContains, ipAddrKey, ipInCidr, ipKey, ipSiteKey, parseCidr, parseIp, type Cidr, type ParsedIp } from "@beamhop/sdk/net";
