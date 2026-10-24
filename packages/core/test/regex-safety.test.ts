import { describe, expect, test } from "bun:test";
import { REGEX_FILTER_MAX_INPUT, REGEX_FILTER_MIN_INPUT, analyzeRegexFilter, regexFilterInputLimit, unsafeRegexReason } from "@beamhop/sdk";
import { ContentPolicy } from "../src/pipeline/content-policy";
import { FakeSettings, keypair, sign, silentLogger } from "./fakes";

const filter = (pattern: string) => ({ id: "f", pattern, isRegex: true, kinds: [], action: "reject" as const, enabled: true });

describe("word filter regex cost model", () => {
  test("refuses patterns that slipped past the old checker", () => {
    // overlapping unbounded repeats (cubic), bounded repeats of alternatives / repeats (exponential)
    for (const p of ["\\w+\\.?\\w+\\.(?:xyz|top|click)", "\\w+\\s?\\w+!", "(a|a){1,26}b", "(?:\\w|\\d){1,40}", "(?:\\w{1,30}){1,30}", "\\w{1,100}\\w{1,100}x", ".*.*x"])
      expect(unsafeRegexReason(p)).toBeDefined();
  });

  test("repeats separated by a character they can't match stay acceptable", () => {
    for (const p of ["[a-z]+@[a-z]+\\.com", "a+b+c+d", "\\d+\\.\\d+x", "[0-9]+[a-z]+!"]) expect(regexFilterInputLimit(p)).toBeGreaterThanOrEqual(REGEX_FILTER_MIN_INPUT);
  });

  test("character classes are compared case-insensitively and with escapes resolved", () => {
    // filters compile with the i flag, so [A-Z] and [a-z] overlap
    expect(unsafeRegexReason("[A-Z]+[a-z]+!")).toBeDefined();
    expect(unsafeRegexReason("[\\x61-\\x7a]+[a-z]+!")).toBeDefined();
    expect(unsafeRegexReason("[a-\\u00ff]+[q]+!")).toBeDefined();
  });

  test("cheap patterns see the whole window, costlier ones less", () => {
    expect(regexFilterInputLimit("(?:viagra|cialis|casino)")).toBe(REGEX_FILTER_MAX_INPUT);
    const limit = regexFilterInputLimit("\\w+x");
    expect(limit).toBeGreaterThanOrEqual(REGEX_FILTER_MIN_INPUT);
    expect(limit).toBeLessThan(REGEX_FILTER_MAX_INPUT);
    expect(analyzeRegexFilter("(a+)+")).toHaveProperty("reason");
  });

  test("an accepted quadratic pattern stays fast on hostile content and scans it all in windows", () => {
    const settings = new FakeSettings({ moderation: { wordFilters: [filter("\\w+x")] } });
    const policy = new ContentPolicy(settings, silentLogger);
    const t0 = performance.now();
    expect(policy.evaluate(sign(keypair(), { content: "a".repeat(REGEX_FILTER_MAX_INPUT * 4) })).action).toBe("pass");
    expect(performance.now() - t0).toBeLessThan(100);
    expect(policy.evaluate(sign(keypair(), { content: "aax" })).action).toBe("reject");
    // past the pattern's input limit too (previously only the leading window was looked at)
    expect(policy.evaluate(sign(keypair(), { content: " ".repeat(regexFilterInputLimit("\\w+x")) + "ax" })).action).toBe("reject");
  });
});
