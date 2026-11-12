import { describe, expect, test } from "bun:test";
import { DbSwitchingError, RuntimeSettingsSchema, stopContext, type Logger } from "@beamhop/sdk";
import { createMemoryDb } from "@beamhop/storage";
import type { ApiContext } from "../src/context";
import { startAuditRetention } from "../src/services/audit-retention";
import { FakeDbSwitch, pausableDb } from "../../core/test/db-switch-fake";
import { createHarness, nip98Header, PUBLIC_URL } from "./fakes";

async function harness(opts: Parameters<typeof createHarness>[0] = {}) {
  const sw = new FakeDbSwitch();
  const h = await createHarness({ ...opts, db: pausableDb(await createMemoryDb(), sw), dbSwitch: sw });
  return { ...h, sw };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("admin API during a database switch", () => {
  test("a write gets 503 db_switching with Retry-After; reads (and the session renewal they trigger) keep working", async () => {
    const h = await harness();
    const cookie = await h.login(h.owner);
    h.sw.retryAfterSec = 4;
    h.sw.pause();
    // past the renewal interval: the sliding-expiry write is refused and skipped, the read still answers
    h.clock.now += 120_000;
    const me = await h.withCookie(cookie, "/auth/me");
    expect(me.status).toBe(200);

    const res = await h.withCookie(cookie, "/auth/sessions/end-others", { method: "POST", body: {} });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("4");
    expect(await res.json()).toEqual({ error: "database switch in progress, try again shortly", code: "db_switching" });

    h.sw.resume();
    expect((await h.withCookie(cookie, "/auth/sessions/end-others", { method: "POST", body: {} })).status).toBe(200);
    await h.api.stop!(stopContext("test", 1_000));
  });

  test("NIP-86 answers 503 with Retry-After", async () => {
    const h = await harness();
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    h.sw.pause();
    const req = new Request(`${PUBLIC_URL}/`, {
      method: "POST",
      body,
      headers: { "content-type": "application/nostr+json+rpc", authorization: nip98Header(h.owner, `${PUBLIC_URL}/`, "POST", body) },
    });
    const res = await h.api.nip86(req);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(((await res.json()) as { error: string }).error).toMatch(/database switch in progress/);
    await h.api.stop!(stopContext("test", 1_000));
  });

  test("an import stops at the refused line with 503 and says how far it got", async () => {
    const h = await harness();
    let n = 0;
    h.relay.publish = async () => (++n >= 2 ? { ok: false, message: "error: database switch in progress, try again shortly" } : { ok: true, message: "" });
    const lines = ['{"id":"1"}', '{"id":"2"}', '{"id":"3"}'].map(() =>
      JSON.stringify({ id: "a".repeat(64), pubkey: "b".repeat(64), created_at: 1, kind: 1, tags: [], content: "", sig: "c".repeat(128) }),
    );
    const res = await h.asKey(h.owner, "/events/import", { method: "POST", body: lines.join("\n") + "\n", headers: { "content-type": "application/x-ndjson" } });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const j = (await res.json()) as { error: string; code: string };
    expect(j.code).toBe("db_switching");
    expect(j.error).toMatch(/stopped at line 2 \(1 imported/);
    expect(n).toBe(2);
    expect(h.audit.entries.find((e) => e.action === "event.import")?.details).toMatchObject({ imported: 1, stoppedAtLine: 2 });
    await h.api.stop!(stopContext("test", 1_000));
  });

  test("registers an onSwapped hook that reloads its caches; stop() removes it", async () => {
    const h = await harness();
    expect(h.sw.swapped.map((x) => x.name)).toContain("admin");
    await h.sw.runSwapped();
    await h.api.stop!(stopContext("test", 1_000));
    expect(h.sw.swapped.map((x) => x.name)).not.toContain("admin");
  });
});

describe("background jobs during a database switch", () => {
  test("audit retention refused by the pause is retried, logged at debug only", async () => {
    const levels: string[] = [];
    const logger: Logger = { debug: () => void levels.push("debug"), info() {}, warn: () => void levels.push("warn"), error: () => void levels.push("error"), child: () => logger };
    let calls = 0;
    const settings = RuntimeSettingsSchema.parse({ retention: { auditLogDays: 1 } });
    const ctx = {
      logger,
      nowSec: () => 1_000_000,
      deps: {
        settings: { get: () => settings },
        stores: {
          audit: {
            prune: async () => {
              if (++calls === 1) throw new DbSwitchingError();
              return 0;
            },
          },
        },
      },
    } as unknown as ApiContext;
    const { TaskTracker } = await import("@beamhop/sdk");
    const tasks = new TaskTracker({ logger });
    const stop = startAuditRetention(ctx, tasks, 30, 10);
    for (let i = 0; i < 100 && calls < 2; i++) await sleep(10);
    stop();
    expect(calls).toBe(2);
    expect(levels).toContain("debug");
    expect(levels).not.toContain("error");
    expect(levels).not.toContain("warn");
  });
});
