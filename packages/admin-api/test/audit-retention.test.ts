import { describe, expect, test } from "bun:test";
import { stopContext } from "@beamhop/sdk";
import { createHarness } from "./fakes";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("audit log retention (settings retention.auditLogDays)", () => {
  test("entries older than the configured days are pruned periodically; newer ones stay", async () => {
    const h = await createHarness({ apiOptions: { auditPruneIntervalMs: 20 } });
    const now = Math.floor(h.clock.now / 1000);
    await h.audit.record({ actor: "a", action: "old", target: null, details: {}, ip: null, at: now - 3 * 86400 });
    await h.audit.record({ actor: "a", action: "recent", target: null, details: {}, ip: null, at: now - 3600 });
    await h.settings.update({ retention: { auditLogDays: 2 } }, "test");
    for (let i = 0; i < 50 && h.audit.entries.some((e) => e.action === "old"); i++) await sleep(10);
    expect(h.audit.entries.map((e) => e.action)).toContain("recent");
    expect(h.audit.entries.map((e) => e.action)).not.toContain("old");
    await h.api.stop!(stopContext("test", 1_000));
  });

  test("off by default (0 days), and no longer runs once the admin API drained", async () => {
    const h = await createHarness({ apiOptions: { auditPruneIntervalMs: 10 } });
    const old = Math.floor(h.clock.now / 1000) - 400 * 86400;
    await h.audit.record({ actor: "a", action: "ancient", target: null, details: {}, ip: null, at: old });
    await sleep(60);
    expect(h.audit.entries.some((e) => e.action === "ancient")).toBe(true);
    await h.api.drain!(stopContext("test", 1_000));
    await h.settings.update({ retention: { auditLogDays: 1 } }, "test");
    await sleep(60);
    expect(h.audit.entries.some((e) => e.action === "ancient")).toBe(true);
  });
});
