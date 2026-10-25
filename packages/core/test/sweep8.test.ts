import { describe, expect, test } from "bun:test";
import { REGEX_FILTER_MAX_INPUT, unsafeRegexReason } from "@beamhop/sdk/regex-safety";
import { ContentPolicy } from "../src/pipeline/content-policy";
import { FakeSettings, keypair, setup, sign, silentLogger } from "./fakes";

const filter = (pattern: string, isRegex = true) => ({ id: "f", pattern, isRegex, kinds: [], action: "reject" as const, enabled: true });

describe("word filter regex safety (ReDoS)", () => {
  test("static checker refuses catastrophic patterns and keeps ordinary ones", () => {
    for (const p of ["^(\\w+\\s?)+$", "(a+)+", "(a|a)*", "((ab)+)+", "(a*)*", "(a+){2,5}", "(a)\\1", "\\w+\\s?\\w+!"]) expect(unsafeRegexReason(p)).toBeDefined();
    for (const p of ["free\\s+bitcoin", "https?://\\S+\\.xyz", "(?:viagra|cialis)", "[a-z]+@[a-z]+\\.com", "\\p{L}{3,}", "(foo|bar)?", "(\\d{1,3}){1,4}"])
      expect(unsafeRegexReason(p)).toBeUndefined();
  });

  test("stored unsafe patterns are skipped instead of run on every event", () => {
    const settings = new FakeSettings({ moderation: { wordFilters: [filter("^(\\w+\\s?)+$")] } });
    const warns: unknown[] = [];
    const policy = new ContentPolicy(settings, { ...silentLogger, warn: (...a: unknown[]) => warns.push(a) } as typeof silentLogger);
    const ev = sign(keypair(), { content: "a".repeat(48) + "!" });
    const t0 = performance.now();
    expect(policy.evaluate(ev).action).toBe("pass");
    expect(performance.now() - t0).toBeLessThan(50);
    expect(warns.length).toBe(1);
  });

  test("regex filters look past the first REGEX_FILTER_MAX_INPUT characters (in windows)", () => {
    const settings = new FakeSettings({ moderation: { wordFilters: [filter("spamword")] } });
    const policy = new ContentPolicy(settings, silentLogger);
    expect(policy.evaluate(sign(keypair(), { content: "x spamword" })).action).toBe("reject");
    expect(policy.evaluate(sign(keypair(), { content: "x".repeat(REGEX_FILTER_MAX_INPUT) + " spamword" })).action).toBe("reject");
  });
});

describe("relay HTTP CORS / NIP-98", () => {
  test("preflight allows the Authorization header", async () => {
    const { relay } = await setup();
    for (const path of ["/", "/invite/redeem"]) {
      const res = await relay.http.request(path, { method: "OPTIONS" });
      expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    }
  });

  test("/invite/redeem is rate limited per address", async () => {
    const { relay } = await setup({ settings: { access: { mode: "invite" } } });
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await relay.http.fetch(new Request("https://relay.example.com/invite/redeem", { method: "POST", body: "{}" }), { ip: "203.0.113.9" });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses[0]).toBe(401);
  });
});
