import { describe, expect, test } from "bun:test";
import { stopContext, TaskTracker } from "@beamhop/sdk";
import { Scheduler } from "../src/jobs/scheduler";
import { keypair, setup, sign, silentLogger, tick } from "./fakes";

const SHUTTING_DOWN = "error: relay is shutting down";

describe("relay drain", () => {
  test("EVENTs queued before the drain are processed and answered; what arrives during it is refused with an answer", async () => {
    const { relay, hooks, connect } = await setup();
    hooks.onWrite(async () => {
      await tick(20);
      return { action: "next" };
    });
    await relay.start();
    const c = connect();
    const kp = keypair();
    const queued = [sign(kp, { content: "one" }), sign(kp, { content: "two" }), sign(kp, { content: "three" })];
    for (const e of queued) c.send(["EVENT", e]);
    const drained = relay.drain!(stopContext("test", 2_000));
    const late = sign(kp, { content: "late" });
    c.send(["EVENT", late]);
    c.send(["REQ", "s", { kinds: [1] }]);
    await drained;
    const oks = c.socket.of("OK");
    for (const e of queued) expect(oks).toContainEqual(["OK", e.id, true, ""]);
    expect(oks).toContainEqual(["OK", late.id, false, SHUTTING_DOWN]);
    expect(c.socket.of("CLOSED")).toContainEqual(["CLOSED", "s", SHUTTING_DOWN]);
    // and new connections are turned away
    const d = connect("5.6.7.8");
    expect(d.socket.of("NOTICE")).toContainEqual(["NOTICE", SHUTTING_DOWN]);
    expect(d.socket.closed?.code).toBe(1008);
    await relay.stop();
  });

  test("past the deadline, queued EVENTs are answered OK false; stop answers the one still processing before closing 1001", async () => {
    const { relay, hooks, connect } = await setup();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    hooks.onWrite(
      async () => {
        await held;
        return { action: "next" };
      },
      "test",
      { timeoutMs: 10_000 },
    );
    await relay.start();
    const c = connect();
    const kp = keypair();
    const evs = [sign(kp, { content: "a" }), sign(kp, { content: "b" }), sign(kp, { content: "c" })];
    for (const e of evs) c.send(["EVENT", e]);
    await relay.drain!(stopContext("test", 30));
    await relay.stop();
    const oks = c.socket.of("OK");
    for (const e of evs) expect(oks).toContainEqual(["OK", e.id, false, SHUTTING_DOWN]);
    expect(oks.length).toBe(3);
    expect(c.socket.closed?.code).toBe(1001);
    // the first event finishes processing later: no second answer on the closed connection
    release();
    await tick(20);
    expect(c.socket.of("OK").length).toBe(3);
  });

  test("relay.stop without a drain still answers every queued EVENT", async () => {
    const { relay, hooks, connect } = await setup();
    hooks.onWrite(async () => {
      await tick(50);
      return { action: "next" };
    });
    await relay.start();
    const c = connect();
    const kp = keypair();
    const evs = [sign(kp), sign(kp, { content: "x" })];
    for (const e of evs) c.send(["EVENT", e]);
    await relay.stop();
    for (const e of evs) expect(c.socket.of("OK")).toContainEqual(["OK", e.id, false, SHUTTING_DOWN]);
  });

  test("word-filter reports are filed as tracked background tasks", async () => {
    const tasks = new TaskTracker();
    const tracked: string[] = [];
    const track = tasks.track.bind(tasks);
    tasks.track = (label, work) => (tracked.push(label), track(label, work));
    const { relay, connect } = await setup({
      tasks,
      settings: { moderation: { wordFilters: [{ id: "w", pattern: "watch", isRegex: false, kinds: [], action: "report", enabled: true }] } },
    });
    const c = connect();
    expect((await c.publish(sign(keypair(), { content: "watch this" })))[2]).toBe(true);
    expect(tracked).toContain("word-filter report");
    expect(await tasks.idle()).toBe(true);
    await relay.stop();
  });
});

describe("Scheduler drain", () => {
  test("stops new runs, signals and awaits the running job", async () => {
    const s = new Scheduler(silentLogger);
    let seen: AbortSignal | undefined;
    let finished = false;
    const job = async (signal: AbortSignal) => {
      seen = signal;
      while (!signal.aborted) await tick(2);
      await tick(10);
      finished = true;
    };
    const run = s.runNow("job", job);
    await tick(5);
    expect(await s.drain(stopContext("test", 1_000).signal)).toBe(true);
    expect(seen?.aborted).toBe(true);
    expect(finished).toBe(true);
    await run;
    let again = false;
    await s.runNow("other", () => void (again = true));
    s.every("tick", 1, () => void (again = true));
    await tick(10);
    expect(again).toBe(false);
  });

  test("gives up at the deadline and names the jobs still running", async () => {
    const warnings: unknown[] = [];
    const s = new Scheduler({ ...silentLogger, warn: (_m: string, d?: Record<string, unknown>) => void warnings.push(d) });
    void s.runNow("stuck", () => new Promise(() => {}));
    const t0 = Date.now();
    expect(await s.drain(stopContext("test", 30).signal)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(warnings).toEqual([{ jobs: ["stuck"] }]);
  });

  test("resume() lets a restarted relay schedule again", async () => {
    const s = new Scheduler(silentLogger);
    await s.drain();
    s.resume();
    let ran = false;
    await s.runNow("job", (signal) => void (ran = !signal.aborted));
    expect(ran).toBe(true);
  });
});
