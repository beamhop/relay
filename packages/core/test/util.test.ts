import { describe, expect, test } from "bun:test";
import { ipInCidr, parseIp } from "../src/util/cidr";
import { matchFilter } from "../src/util/filter";
import { checkPow, countLeadingZeroBits } from "../src/pipeline/pow";
import { RateLimiter } from "../src/util/rate-limit";
import { sameRelayUrl, toWsUrl } from "../src/util/url";
import { parseClientMessage } from "../src/protocol/messages";
import { keypair, sign } from "./fakes";

describe("cidr", () => {
  test("ipv4", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("192.168.1.5", "192.168.1.5")).toBe(true);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });
  test("ipv6", () => {
    expect(ipInCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("::1", "::1/128")).toBe(true);
    expect(ipInCidr("fe80::1%eth0", "fe80::/10")).toBe(true);
  });
  test("v4-mapped v6 normalizes to v4", () => {
    expect(parseIp("::ffff:10.0.0.1")?.v).toBe(4);
    expect(ipInCidr("::ffff:10.0.0.1", "10.0.0.0/24")).toBe(true);
    expect(ipInCidr("10.0.0.1", "2001:db8::/32")).toBe(false);
  });
  test("invalid input", () => {
    expect(parseIp("999.1.1.1")).toBeUndefined();
    expect(parseIp("1:2:3")).toBeUndefined();
    expect(ipInCidr("1.2.3.4", "1.2.3.0/33")).toBe(false);
  });
});

describe("filters", () => {
  const kp = keypair();
  const e = sign(kp, { kind: 1, tags: [["t", "nostr"], ["p", "ab"]], content: "Hello World", created_at: 1000 });
  test("matches", () => {
    expect(matchFilter({ kinds: [1], authors: [kp.pk] }, e)).toBe(true);
    expect(matchFilter({ "#t": ["nostr"], since: 1000, until: 1000 }, e)).toBe(true);
    expect(matchFilter({ "#t": ["other"] }, e)).toBe(false);
    expect(matchFilter({ since: 1001 }, e)).toBe(false);
    expect(matchFilter({ search: "hello" }, e)).toBe(true);
    expect(matchFilter({ search: "bye" }, e)).toBe(false);
  });
});

describe("pow", () => {
  test("leading zero bits", () => {
    expect(countLeadingZeroBits("000f" + "f".repeat(60))).toBe(12);
    expect(countLeadingZeroBits("8" + "0".repeat(63))).toBe(0);
    expect(countLeadingZeroBits("1" + "0".repeat(63))).toBe(3);
  });
  test("committed target", () => {
    const ev = { id: "0000" + "f".repeat(60), tags: [["nonce", "1", "8"]] } as never;
    expect(checkPow(ev, 16)).toMatch(/^pow: committed target/);
    expect(checkPow(ev, 8)).toBeUndefined();
    expect(checkPow({ id: "f".repeat(64), tags: [] } as never, 1)).toMatch(/^pow:/);
  });
});

describe("rate limiter", () => {
  test("token bucket refills", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 60; i++) expect(rl.take("k", 60)).toBe(true);
    expect(rl.take("k", 60)).toBe(false);
    t += 1000;
    expect(rl.take("k", 60)).toBe(true);
    expect(rl.take("k", 60)).toBe(false);
  });
});

describe("urls", () => {
  test("relay url comparisons", () => {
    expect(toWsUrl("https://relay.example.com/")).toBe("wss://relay.example.com");
    expect(sameRelayUrl("wss://Relay.Example.com/", "wss://relay.example.com")).toBe(true);
    expect(sameRelayUrl("wss://relay.example.com:443", "wss://relay.example.com")).toBe(true);
    expect(sameRelayUrl("wss://evil.com", "wss://relay.example.com")).toBe(false);
  });
});

describe("message parsing", () => {
  const p = (s: unknown) => parseClientMessage(JSON.stringify(s), { maxFilters: 2 });
  test("strict shapes", () => {
    expect(parseClientMessage("not json", { maxFilters: 2 }).ok).toBe(false);
    expect(p({}).ok).toBe(false);
    expect(p(["REQ", "s"]).ok).toBe(false);
    expect(p(["REQ", "s", {}, {}, {}])).toMatchObject({ ok: false, subId: "s" });
    expect(p(["REQ", "s", { kinds: ["1"] }]).ok).toBe(false);
    expect(p(["REQ", "s", { authors: ["abc"] }]).ok).toBe(false);
    expect(p(["REQ", "s", { foo: 1 }]).ok).toBe(false);
    expect(p(["REQ", "s", { "#e": ["x"], kinds: [1], limit: 5 }]).ok).toBe(true);
    expect(p(["REQ", "x".repeat(65), {}]).ok).toBe(false);
    expect(p(["EVENT", { id: "zz" }])).toMatchObject({ ok: false, type: "EVENT" });
    expect(p(["CLOSE", "s"]).ok).toBe(true);
    expect(p(["NEG-OPEN", "s", {}, "61"]).ok).toBe(true);
    expect(p(["NEG-OPEN", "s", {}, "6"]).ok).toBe(false);
    expect(p(["WHAT"]).ok).toBe(false);
  });
});
