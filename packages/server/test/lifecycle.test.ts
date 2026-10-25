import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, definePlugin, type Logger } from "@beamhop/sdk";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { createBeamhop } from "../src/app";
import { loadConfig } from "../src/config";
import { Lifecycle, runShutdown, shutdownBudgets, type LifecyclePhase } from "../src/lifecycle";
import { serve } from "../src/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recordingLogger() {
  const lines: { level: string; msg: string }[] = [];
  const logger: Logger = {
    debug: (msg) => void lines.push({ level: "debug", msg }),
    info: (msg) => void lines.push({ level: "info", msg }),
    warn: (msg) => void lines.push({ level: "warn", msg }),
    error: (msg) => void lines.push({ level: "error", msg }),
    child: () => logger,
  };
  return { lines, logger };
}

describe("shutdown orchestrator", () => {
  test("steps run in order, the parts of a step in parallel, each phase entered with its step", async () => {
    const order: string[] = [];
    const lifecycle = new Lifecycle();
    const phases: LifecyclePhase[] = [];
    const part = (name: string, ms = 0) => async () => {
      phases.push(lifecycle.phase);
      order.push(`${name}:start`);
      await sleep(ms);
      order.push(`${name}:end`);
    };
    await runShutdown({
      reason: "test",
      totalMs: 2_000,
      logger: createLogger("error"),
      lifecycle,
      steps: [
        { name: "drain", phase: "draining", ms: 500, run: { a: part("a", 20), b: part("b", 5), skipped: undefined } },
        { name: "relay", phase: "stopping", run: { relay: part("relay") } },
        { name: "db", run: { db: part("db") } },
      ],
    });
    expect(order).toEqual(["a:start", "b:start", "b:end", "a:end", "relay:start", "relay:end", "db:start", "db:end"]);
    expect(phases).toEqual(["draining", "draining", "stopping", "stopping"]);
    expect(lifecycle.phase).toBe("stopped");
  });

  test("a step overrunning its budget or failing is logged and the next steps still run, the database close included", async () => {
    const { lines, logger } = recordingLogger();
    const order: string[] = [];
    const t0 = Date.now();
    await runShutdown({
      reason: "test",
      totalMs: 1_000,
      logger,
      steps: [
        { name: "drain", ms: 30, run: { stuck: () => new Promise(() => {}), fine: () => void order.push("fine") } },
        { name: "plugins", run: { plugins: () => Promise.reject(new Error("teardown bug")) } },
        { name: "db", run: { db: () => void order.push("db") } },
      ],
    });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(order).toEqual(["fine", "db"]);
    expect(lines).toEqual([
      { level: "warn", msg: "shutdown: drain/stuck did not finish within 30 ms, moving on" },
      { level: "error", msg: "shutdown: plugins failed" },
    ]);
  });

  test("once the overall budget is spent, the remaining steps are still started (db.close is never skipped)", async () => {
    let t = 0;
    const closed: string[] = [];
    await runShutdown({
      reason: "test",
      totalMs: 20,
      now: () => t,
      logger: createLogger("error"),
      steps: [
        {
          name: "drain",
          run: {
            slow: async () => {
              t = 1_000; // the injected clock jumps past the overall deadline
              await sleep(40);
            },
          },
        },
        { name: "db", run: { db: () => void closed.push("db") } },
      ],
    });
    expect(closed).toEqual(["db"]);
  });

  test("budgets: drain at most 5 s or half, close handshakes at most 1 s", () => {
    expect(shutdownBudgets(10_000)).toEqual({ drain: 5_000, relay: 1_000, plugins: 2_000, services: 1_000 });
    expect(shutdownBudgets(30_000).drain).toBe(5_000);
    expect(shutdownBudgets(2_000)).toMatchObject({ drain: 1_000, relay: 200 });
  });
});

describe("in-flight HTTP requests", () => {
  test("counted until the response; while shutting down only probes and /metrics are served", async () => {
    const lc = new Lifecycle();
    let release!: () => void;
    const slow = lc.handle(new Request("http://x/slow"), () => new Promise<Response>((r) => (release = () => r(new Response("ok")))));
    expect(lc.requestsInFlight).toBe(1);
    lc.phase = "draining";
    let idle = false;
    const waiting = lc.idle().then((v) => (idle = v));
    const refused = await lc.handle(new Request("http://x/admin/"), () => new Response("served"));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("connection")).toBe("close");
    expect(refused.headers.get("retry-after")).toBe("5");
    for (const path of ["/health", "/health/live", "/metrics"]) expect(await (await lc.handle(new Request(`http://x${path}`), () => new Response("served"))).text()).toBe("served");
    await sleep(5);
    expect(idle).toBe(false);
    release();
    expect(await (await slow).text()).toBe("ok");
    await waiting;
    expect(idle).toBe(true);
    const ac = new AbortController();
    void lc.handle(new Request("http://x/health"), () => new Promise<Response>(() => {}));
    const gaveUp = lc.idle(ac.signal);
    ac.abort();
    expect(await gaveUp).toBe(false);
  });
});

// ------------------------------------------------------------------ integration (real packages, both runtimes)

const root = join(import.meta.dir, "../..");
const realAvailable = ["storage", "core", "metrics"].every((p) => existsSync(join(root, p, "src/index.ts")));

/** write hook holding every EVENT for a while (so they queue), and a slow public route */
const slowpoke = definePlugin({
  name: "slowpoke",
  version: "1.0.0",
  setup(ctx) {
    ctx.hooks.onWrite(
      async () => {
        await sleep(120);
        return { action: "next" };
      },
      { timeoutMs: 10_000 },
    );
    ctx.http.get("/slow", async (c) => {
      await sleep(400);
      return c.text("slow done");
    });
  },
});

// @hono/node-server swaps in its own global Request/Response; Bun.serve in later test files needs the native ones
const { Request: NativeRequest, Response: NativeResponse } = globalThis;
afterAll(() => {
  Object.defineProperty(globalThis, "Request", { value: NativeRequest });
  Object.defineProperty(globalThis, "Response", { value: NativeResponse });
});

for (const runtime of ["bun", "node"] as const) {
  describe.skipIf(!realAvailable)(`graceful shutdown (${runtime} adapter)`, () => {
    test("queued EVENTs get their OKs before close 1001, a slow request completes, new requests get 503, db.close runs last", async () => {
      const dir = mkdtempSync(join(import.meta.dir, ".tmp-lifecycle-"));
      try {
        const { config } = loadConfig({
          cwd: dir,
          env: {},
          overrides: {
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0 },
            database: { driver: "sqlite", sqlitePath: join(dir, "db.sqlite") },
            blossom: { enabled: false },
            admin: { enabled: false },
            plugins: { dir: join(dir, "plugins") },
          },
        });
        const bh = await createBeamhop(config, { autoDiscoverNpm: false, plugins: [{ plugin: slowpoke }], extras: { pluginsEnabled: ["slowpoke"] } });
        await bh.start();
        const server = await serve(bh, { runtime, port: 0, host: "127.0.0.1" });
        const http = `http://127.0.0.1:${server.port}`;

        const steps: string[] = [];
        for (const [name, target] of [["relay.stop", bh.relay], ["plugins.stop", bh.plugins], ["metrics.stop", bh.metrics], ["db.close", bh.stores.db]] as const) {
          const key = name.endsWith("close") ? "close" : "stop";
          const original = (target as unknown as Record<string, () => Promise<void>>)[key].bind(target);
          (target as unknown as Record<string, unknown>)[key] = async (...a: unknown[]) => {
            steps.push(name);
            return (original as (...x: unknown[]) => Promise<void>)(...a);
          };
        }

        // a client with three EVENTs queued behind the slow write hook
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
        const inbox: unknown[][] = [];
        const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
        let closedAt = -1;
        void closed.then(() => (closedAt = inbox.length));
        ws.onmessage = (m) => void inbox.push(JSON.parse(String(m.data)));
        await new Promise((r) => (ws.onopen = r));
        const sk = generateSecretKey();
        const evs = [0, 1, 2].map((i) => finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: `queued ${i}` }, sk));
        for (const e of evs) ws.send(JSON.stringify(["EVENT", e]));
        const slow = fetch(`${http}/plugins/slowpoke/slow`).then(async (r) => [r.status, await r.text()] as const);
        await sleep(30);

        const stopping = bh.stop({ server, reason: "test", timeoutMs: 5_000 });
        expect(bh.lifecycle.phase).toBe("draining");

        const health = await fetch(`${http}/health`);
        expect(health.status).toBe(503);
        expect(await health.json()).toMatchObject({ status: "draining" });
        expect((await fetch(`${http}/health/live`)).status).toBe(200);
        const landing = await fetch(`${http}/`);
        expect(landing.status).toBe(503);
        expect(landing.headers.get("retry-after")).toBe("5");
        const late = await new Promise<string>((resolve) => {
          const w = new WebSocket(`ws://127.0.0.1:${server.port}/`);
          w.onopen = () => resolve("open");
          w.onerror = () => resolve("refused");
        });
        expect(late).toBe("refused");

        expect(await slow).toEqual([200, "slow done"]);
        expect(await closed).toBe(1001);
        await stopping;

        const oks = inbox.filter((m) => m[0] === "OK");
        expect(oks).toEqual(evs.map((e) => ["OK", e.id, true, ""]));
        expect(inbox.findLastIndex((m) => m[0] === "OK")).toBeLessThan(closedAt);
        expect(inbox).toContainEqual(["NOTICE", "error: relay is shutting down"]);
        expect(steps).toEqual(["relay.stop", "plugins.stop", "metrics.stop", "db.close"]);
        expect(bh.lifecycle.phase).toBe("stopped");
        await expect(fetch(`${http}/health/live`)).rejects.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  });
}
