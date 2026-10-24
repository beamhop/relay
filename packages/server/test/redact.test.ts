import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../src/plugins/redact";

describe("plugin settings redaction", () => {
  test("uses the shared matcher: names the old regex missed, credential-bearing values, harmless names", () => {
    const out = redactSecrets({
      privkey: "deadbeef",
      smtpPass: "hunter2",
      openaiKey: "sk-123",
      databaseUrl: "postgres://u:p@db/x",
      nested: { list: ["wss://relay.damus.io", `nsec1${"q".repeat(58)}`] },
      maxTokens: 100,
      tokenBucketSize: 5,
      privateRelay: true,
      relayPubkey: "ab".repeat(32),
    }) as Record<string, unknown>;
    expect(out.privkey).toBe("[redacted]");
    expect(out.smtpPass).toBe("[redacted]");
    expect(out.openaiKey).toBe("[redacted]");
    expect(out.databaseUrl).toBe("[redacted]");
    expect(out.nested).toEqual({ list: ["wss://relay.damus.io", "[redacted]"] });
    expect(out.maxTokens).toBe(100);
    expect(out.tokenBucketSize).toBe(5);
    expect(out.privateRelay).toBe(true);
    expect(out.relayPubkey).toBe("ab".repeat(32));
  });
});
