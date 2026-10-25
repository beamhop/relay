import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { EventBus, HookRegistry, type BusEvents, type ConnectionHandle, type Logger } from "@beamhop/sdk";
import { createBeamhop, hookIncidentReporter, type Beamhop } from "../src/app";
import { closeReason } from "../src/runtime/common";
import { installProcessHandlers, serve, type RunningServer } from "../src/server";
import { stubFactories, stubMetrics, testConfig } from "./stubs";

function recordingLogger() {
  const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, data?: Record<string, unknown>) => void lines.push({ level, msg, data });
  const logger: Logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => logger };
  return { logger, lines };
}

function guard(over: { max?: number } = {}) {
  const proc = new EventEmitter();
  const bus = new EventBus();
  const alerts: BusEvents["alert"][] = [];
  bus.on("alert", (a) => void alerts.push(a));
  const { logger, lines } = recordingLogger();
  const exits: number[] = [];
  const shutdowns: string[] = [];
  let t = 1_000_000;
  const metrics = stubMetrics();
  const uninstall = installProcessHandlers({
    logger, bus, metrics, proc: proc as never, exit: (c) => void exits.push(c), now: () => t, maxRejectionsPerMinute: over.max,
    shutdown: async (reason) => void shutdowns.push(reason),
  });
  return { proc, alerts, lines, exits, shutdowns, metrics, uninstall, advance: (ms: number) => (t += ms) };
}

describe("process handlers", () => {
  test("unhandledRejection: logged with stack, counted, one alert a minute, keeps running", async () => {
    const g = guard();
    for (let i = 0; i < 5; i++) g.proc.emit("unhandledRejection", new Error(`oops ${i}`));
    expect(g.lines.filter((l) => l.level === "error")).toHaveLength(5);
    expect((g.lines[0].data!.error as Error).stack).toContain("oops 0");
    expect(g.metrics.counters.process_unhandled_rejections_total).toBe(5);
    expect(g.alerts).toHaveLength(1);
    g.advance(61_000);
    g.proc.emit("unhandledRejection", "plain reason");
    expect(g.alerts).toHaveLength(2);
    expect(g.alerts[1].message).toContain("4 more");
    await Bun.sleep(1);
    expect(g.shutdowns).toEqual([]);
    expect(g.exits).toEqual([]);
  });

  test("unhandledRejection: more than the limit within a minute escalates to shutdown + exit(1)", async () => {
    const g = guard({ max: 3 });
    for (let i = 0; i < 4; i++) g.proc.emit("unhandledRejection", new Error("loop"));
    await Bun.sleep(1);
    expect(g.shutdowns).toEqual(["too many unhandled promise rejections"]);
    expect(g.exits).toEqual([1]);
  });

  test("uncaughtException: graceful shutdown then exit(1), once", async () => {
    const g = guard();
    g.proc.emit("uncaughtException", new Error("bad state"));
    g.proc.emit("uncaughtException", new Error("again"));
    await Bun.sleep(1);
    expect(g.shutdowns).toEqual(["uncaught exception"]);
    expect(g.exits).toEqual([1]);
  });

  test("uninstall removes both listeners", () => {
    const g = guard();
    g.uninstall();
    expect(g.proc.listenerCount("unhandledRejection")).toBe(0);
    expect(g.proc.listenerCount("uncaughtException")).toBe(0);
  });
});

describe("hook incident reporting", () => {
  test("timeouts raise at most one alert per owner per minute; every incident is counted", async () => {
    const bus = new EventBus();
    const alerts: BusEvents["alert"][] = [];
    bus.on("alert", (a) => void alerts.push(a));
    const metrics = stubMetrics();
    const { logger, lines } = recordingLogger();
    let t = 0;
    const hooks = new HookRegistry({ timeouts: { write: 5 } });
    hooks.onIncident(hookIncidentReporter({ bus, metrics, logger, now: () => t }));
    hooks.onWrite(() => new Promise(() => {}), "plugin:slow");
    for (let i = 0; i < 3; i++) await hooks.runWrite({ id: "x" } as never, { source: "ws" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("plugin:slow");
    expect(alerts[0].message).toContain("without its verdict");
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(metrics.counters.hook_incidents_total).toBe(3);
    t += 60_000;
    await hooks.runWrite({ id: "x" } as never, { source: "ws" });
    expect(alerts).toHaveLength(2);
    expect(alerts[1].message).toContain("2 more");
  });
});

describe("close reason guard", () => {
  test("cuts to 123 UTF-8 bytes without splitting a character", () => {
    expect(closeReason("short")).toBe("short");
    expect(Buffer.byteLength(closeReason("x".repeat(300))!)).toBe(123);
    const cut = closeReason("é".repeat(100))!;
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(123);
    expect(cut).toBe("é".repeat(61));
  });
});

function wsSession(url: string, send: string): Promise<{ code: number; reason: string; messages: string[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: string[] = [];
    const t = setTimeout(() => reject(new Error("timeout")), 3000);
    ws.onopen = () => ws.send(send);
    ws.onmessage = (m) => void messages.push(String(m.data));
    ws.onclose = (e) => {
      clearTimeout(t);
      resolve({ code: e.code, reason: e.reason, messages });
    };
  });
}

// @hono/node-server swaps in its own global Request/Response; Bun.serve in later test files needs the native ones
const { Request: NativeRequest, Response: NativeResponse } = globalThis;
afterAll(() => {
  Object.defineProperty(globalThis, "Request", { value: NativeRequest });
  Object.defineProperty(globalThis, "Response", { value: NativeResponse });
});

for (const runtime of ["bun", "node"] as const) {
  describe(`${runtime} adapter contains handler exceptions`, () => {
    let bh: Beamhop;
    let server: RunningServer;
    let url: string;
    beforeAll(async () => {
      bh = await createBeamhop(testConfig({ server: { host: "127.0.0.1", port: 0 } }), { factories: stubFactories() });
      // a relay whose handlers throw
      bh.relay.handleConnection = (socket): ConnectionHandle => ({
        id: "1",
        onMessage(d) {
          if (d === "throw") throw new Error("handler bug");
          if (d === "long-close") socket.close(1008, "x".repeat(500));
        },
        onClose() {
          throw new Error("close bug");
        },
      });
      await bh.start();
      server = await serve(bh, { runtime, port: 0, host: "127.0.0.1" });
      url = `ws://127.0.0.1:${server.port}/`;
    });
    afterAll(async () => {
      server.stopAccepting();
      await bh.stop();
      await server.stop();
    });

    test("a throwing onMessage closes that connection with 1011 and the server keeps serving", async () => {
      const r = await wsSession(url, "throw");
      expect(r.code).toBe(1011);
      const again = await wsSession(url, "throw");
      expect(again.code).toBe(1011);
    });

    test("an over-long close reason is truncated instead of throwing", async () => {
      const r = await wsSession(url, "long-close");
      expect(r.code).toBe(1008);
      expect(r.reason).toBe("x".repeat(123));
    });
  });
}
