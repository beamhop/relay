import { afterEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { isForbiddenDestination, isOwnAddress, setOwnAddressesForTest } from "../src/util/ip";

afterEach(() => setOwnAddressesForTest(null));

/** where the web-push sender may connect (false) or must refuse (true); the x-8 table */
const TABLE: [string, boolean][] = [
  ["8.8.8.8", false],
  ["142.250.185.74", false],
  ["2606:4700:4700::1111", false],
  ["64:ff9b::808:808", false], // NAT64 of a public IPv4
  ["0.0.0.0", true],
  ["10.1.2.3", true],
  ["127.0.0.1", true],
  ["127.255.255.254", true],
  ["100.64.0.1", true], // CGNAT
  ["169.254.169.254", true], // cloud metadata
  ["172.16.0.1", true],
  ["172.31.255.255", true],
  ["192.168.1.1", true],
  ["192.0.0.8", true],
  ["198.18.0.1", true],
  ["224.0.0.1", true],
  ["255.255.255.255", true],
  ["::", true],
  ["::1", true],
  ["[::1]", true],
  ["::ffff:127.0.0.1", true],
  ["::ffff:7f00:1", true],
  ["::ffff:0:a00:1", true], // IPv4-translated 10.0.0.1
  ["::127.0.0.1", true], // IPv4-compatible
  ["64:ff9b::7f00:1", true], // NAT64 of loopback
  ["64:ff9b:1::1", true], // local-use NAT64
  ["2002:7f00:1::", true], // 6to4 of loopback
  ["2001::1", true], // Teredo
  ["2001:db8::1", true],
  ["100::1", true],
  ["fc00::1", true],
  ["fd12:3456::1", true],
  ["fe80::1%eth0", true],
  ["fec0::1", true],
  ["ff02::1", true],
  ["not-an-ip", true],
  ["1.2.3", true],
];

describe("push endpoint address guard", () => {
  test.each(TABLE)("%s → forbidden %p", (ip, forbidden) => {
    setOwnAddressesForTest([]);
    expect(isForbiddenDestination(ip)).toBe(forbidden);
  });

  test("the host's own public addresses are refused, in any spelling", () => {
    setOwnAddressesForTest(["93.184.216.34", "2a01:4f8::1234"]);
    expect(isForbiddenDestination("93.184.216.34")).toBe(true);
    expect(isForbiddenDestination("::ffff:93.184.216.34")).toBe(true);
    expect(isForbiddenDestination("::ffff:5db8:d822")).toBe(true);
    expect(isForbiddenDestination("2a01:04f8:0000::1234")).toBe(true);
    expect(isForbiddenDestination("[2A01:4F8::1234]")).toBe(true);
    expect(isForbiddenDestination("93.184.216.35")).toBe(false);
  });

  test("reads the real interface list by default", () => {
    const own = Object.values(networkInterfaces()).flatMap((l) => l ?? []).map((a) => a.address);
    for (const a of own) expect(isOwnAddress(a)).toBe(true);
  });
});
