import { describe, expect, test } from "bun:test";
import { LatencyWindow, RateWindow } from "../src/window";
import { normalizeReason } from "../src/normalize";
import { isPrivateIp } from "../src/geo";
import { pickStep } from "../src/rollup";

describe("RateWindow", () => {
  test("per-second rate over a sliding 10s window", () => {
    const w = new RateWindow(0, 10);
    for (let s = 1; s <= 10; s++) {
      w.cur += 5;
      w.roll(s * 1000);
    }
    expect(w.rate()).toBe(5);
    for (let s = 11; s <= 15; s++) w.roll(s * 1000); // 5 empty seconds slide in
    expect(w.rate()).toBe(2.5);
    expect(w.lastRate()).toBe(0);
  });
  test("uses actual elapsed time before the window fills and under jitter", () => {
    const w = new RateWindow(0, 10);
    w.cur = 30;
    w.roll(2000);
    expect(w.rate()).toBe(15);
    expect(w.lastRate()).toBe(15);
  });
});

describe("LatencyWindow", () => {
  test("percentiles only consider samples in the window", () => {
    const l = new LatencyWindow(1000);
    for (let i = 1; i <= 100; i++) l.add(i, 100_000);
    l.add(10_000, 0); // too old
    expect(l.percentiles(120_000, 60_000, [50, 95, 99])).toEqual([50, 95, 99]);
    expect(l.percentiles(200_000, 60_000, [50])).toEqual([0]);
  });
  test("bounded capacity keeps the most recent samples", () => {
    const l = new LatencyWindow(4);
    for (let i = 1; i <= 10; i++) l.add(i, 0);
    expect(l.percentiles(0, 1000, [0, 100])).toEqual([7, 10]);
  });
});

test("normalizeReason strips variable parts and truncates", () => {
  expect(normalizeReason(`blocked: pubkey ${"ab".repeat(32)} is banned`)).toBe("pubkey <hex> is banned");
  expect(normalizeReason("rate-limited: 121 events in 60 seconds from 203.0.113.7")).toBe("<n> events in <n> seconds from <ip>");
  expect(normalizeReason('invalid: bad tag "foo"')).toBe("bad tag <str>");
  expect(normalizeReason("")).toBe("(none)");
  const long = normalizeReason("x".repeat(200));
  expect(long.length).toBeLessThanOrEqual(80);
});

test("isPrivateIp", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "unknown", ""])
    expect(isPrivateIp(ip)).toBe(true);
  for (const ip of ["8.8.8.8", "203.0.113.7", "172.32.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) expect(isPrivateIp(ip)).toBe(false);
});

test("pickStep", () => {
  expect(pickStep({ from: 0, to: 3600 })).toBe(60);
  expect(pickStep({ from: 0, to: 3600, stepSec: 90 })).toBe(120);
  expect(pickStep({ from: 0, to: 86400 })).toBe(240);
  expect(pickStep({ from: 0, to: 30 * 86400, stepSec: 60 })).toBe(540);
});
