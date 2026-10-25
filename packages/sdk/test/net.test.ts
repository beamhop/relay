import { afterEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { ipKey, isForbiddenDestination, isOwnAddress, isPrivateAddress, normalizeIp, parseCidr, parseIp, parseIpv6, setOwnAddressesForTest } from "../src/net";

afterEach(() => setOwnAddressesForTest(null));

/** One answer for every outbound guard (Blossom mirror, push endpoints) and GeoIP. */
const PRIVATE: [string, boolean][] = [
  ["::8.8.8.8", true], // IPv4-compatible: all of ::/96 is private
  ["64:ff9b:2::1", true], // NAT64 outside the well-known /96
  ["64:ff9b:1::1", true], // local-use NAT64
  ["192.0.2.1", true], // TEST-NET-1
  ["198.18.0.1", true], // benchmarking
  ["198.51.100.1", true], // TEST-NET-2
  ["203.0.113.1", true], // TEST-NET-3
  ["192.0.0.1", true], // IETF protocol assignments
  ["2001:db8::1", true], // documentation
  ["2002:0a00:0001::", true], // 6to4 of 10.0.0.1
  ["64:ff9b::a00:1", true], // NAT64 of 10.0.0.1
  ["::ffff:0:a00:1", true], // IPv4-translated 10.0.0.1
  ["fec0::1", true], // site-local
  ["::ffff:a00:1", true], // mapped 10.0.0.1, hex spelling
  ["::ffff:10.0.0.1", true],
  ["fe80::1%eth0", true],
  ["[::1]", true],
  ["127.0.0.1", true],
  ["0.0.0.0", true],
  ["not-an-ip", true],
  ["1.2.3", true],
  ["8.8.8.8", false],
  ["::ffff:8.8.8.8", false],
  ["::ffff:808:808", false],
  ["64:ff9b::808:808", false],
  ["2002:808:808::1", false],
  ["2606:4700:4700::1111", false],
];

describe("isPrivateAddress", () => {
  test.each(PRIVATE)("%s → %p", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  test("is pure: the host's own public address is isOwnAddress / isForbiddenDestination", () => {
    setOwnAddressesForTest(["93.184.216.34"]);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isOwnAddress("::ffff:5db8:d822")).toBe(true);
    expect(isForbiddenDestination("93.184.216.34")).toBe(true);
  });

  test("the host's own interface addresses are forbidden destinations", () => {
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) expect([a.address, isForbiddenDestination(a.address)]).toEqual([a.address, true]);
  });
});

describe("parsing", () => {
  test("one IPv6 parser behind parseIp and parseIpv6", () => {
    expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIpv6("1::2::3")).toBeUndefined();
    expect(parseIp("::ffff:1.2.3.4")).toEqual({ v: 4, value: 0x01020304n });
    expect(parseIp("[2001:DB8::1]")).toEqual({ v: 6, value: (0x2001n << 112n) | (0xdb8n << 96n) | 1n });
    expect(parseIp("1:2:3")).toBeUndefined();
    expect(parseCidr("::ffff:10.0.0.0/104")).toEqual({ v: 4, network: 0x0a000000n, mask: 0xff000000n });
    expect(ipKey("2001:db8:1:2:3:4:5:6")).toBe("6:20010db800010002/64");
  });

  test("normalizeIp strips brackets, IPv4 ports and the mapped prefix", () => {
    expect(normalizeIp("[::1]:443")).toBe("::1");
    expect(normalizeIp("1.2.3.4:80")).toBe("1.2.3.4");
    expect(normalizeIp("::FFFF:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp(undefined)).toBe("unknown");
  });
});
