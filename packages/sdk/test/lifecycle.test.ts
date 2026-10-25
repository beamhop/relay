import { describe, expect, test } from "bun:test";
import { EventBus, settleBy, stopContext, subContext, TaskTracker } from "../src";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recorder() {
  const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, data?: Record<string, unknown>) => void lines.push({ level, msg, data });
  return { lines, logger: { warn: at("warn"), error: at("error"), debug: at("debug") } };
}

describe("TaskTracker", () => {
  test("idle() waits for tracked work, including work started while it waits", async () => {
    const tasks = new TaskTracker();
    expect(await tasks.idle()).toBe(true);
    let done = 0;
    tasks.track("a", sleep(10).then(() => done++));
    const idle = tasks.idle();
    tasks.track("b", sleep(20).then(() => done++));
    expect(await idle).toBe(true);
    expect(done).toBe(2);
    expect(tasks.size).toBe(0);
  });

  test("track() hands back the caller's promise; run() logs failures and resolves undefined", async () => {
    const { lines, logger } = recorder();
    const tasks = new TaskTracker({ logger });
    const p = Promise.reject(new Error("mine"));
    expect(tasks.track("x", p)).toBe(p);
    await p.catch(() => {});
    expect(await tasks.run("boom", () => Promise.reject(new Error("nope")))).toBeUndefined();
    expect(await tasks.run("sync-throw", () => {
      throw new Error("sync");
    })).toBeUndefined();
    expect(await tasks.run("ok", () => 42)).toBe(42);
    expect(lines.filter((l) => l.level === "error").map((l) => l.msg)).toEqual(["task boom failed", "task sync-throw failed"]);
    expect(await tasks.idle()).toBe(true);
  });

  test("idle(signal) gives up at the deadline, logging what still runs (counted per label)", async () => {
    const { lines, logger } = recorder();
    const tasks = new TaskTracker({ logger });
    tasks.track("push", new Promise(() => {}));
    tasks.track("push", new Promise(() => {}));
    tasks.track("prune", new Promise(() => {}));
    const sc = stopContext("test", 20);
    expect(await tasks.idle(sc.signal)).toBe(false);
    expect(lines).toEqual([{ level: "warn", msg: "background tasks still running at the shutdown deadline", data: { tasks: ["push ×2", "prune"] } }]);
  });

  test("close() aborts the signal given to running tasks and refuses new ones", async () => {
    const tasks = new TaskTracker();
    let seen: AbortSignal | undefined;
    const running = tasks.run("long", async (signal) => {
      seen = signal;
      while (!signal.aborted) await sleep(2);
      return "stopped";
    });
    tasks.close();
    expect(await running).toBe("stopped");
    expect(seen?.aborted).toBe(true);
    let started = false;
    expect(await tasks.run("late", () => void (started = true))).toBeUndefined();
    expect(started).toBe(false);
  });
});

describe("stop contexts", () => {
  test("a sub-context never outlives its parent's deadline (injected clock)", () => {
    let t = 1_000;
    const now = () => t;
    const root = stopContext("shutdown", 10_000, { now });
    expect(root.deadline).toBe(11_000);
    const drain = subContext(root, 5_000, now);
    expect(drain.deadline).toBe(6_000);
    t = 9_000;
    const late = subContext(root, 5_000, now);
    expect(late.deadline).toBe(11_000);
    expect(late.reason).toBe("shutdown");
    for (const c of [root, drain, late]) c.dispose();
  });

  test("the signal fires at the deadline, and with the parent", async () => {
    const root = stopContext("x", 10_000);
    const step = subContext(root, 15);
    const other = subContext(root, 10_000);
    await sleep(30);
    expect(step.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    root.dispose();
    const aborted = new AbortController();
    const parent = { reason: "p", deadline: Date.now() + 10_000, signal: aborted.signal };
    const child = subContext(parent, 10_000);
    aborted.abort();
    expect(child.signal.aborted).toBe(true);
    expect(subContext(parent, 10_000).signal.aborted).toBe(true);
    other.dispose();
  });

  test("settleBy reports done, error or timeout and never rejects", async () => {
    const live = new AbortController().signal;
    expect(await settleBy(live, Promise.resolve(1))).toEqual({ status: "done" });
    const err = new Error("x");
    expect(await settleBy(live, () => Promise.reject(err))).toEqual({ status: "error", error: err });
    expect(
      await settleBy(live, () => {
        throw err;
      }),
    ).toEqual({ status: "error", error: err });
    expect(await settleBy(stopContext("t", 10).signal, new Promise(() => {}))).toEqual({ status: "timeout" });
  });
});

describe("EventBus background handlers", () => {
  test("async handlers are tracked until they settle", async () => {
    const tasks = new TaskTracker();
    const bus = new EventBus({ tasks, logger: { error() {} } });
    let done = false;
    bus.on("alert", async () => {
      await sleep(10);
      done = true;
    });
    bus.on("alert", async () => {
      throw new Error("handled by the bus");
    });
    bus.emit("alert", { level: "info", title: "t", message: "m" });
    expect(tasks.labels()).toEqual(["bus alert", "bus alert"]);
    expect(await tasks.idle()).toBe(true);
    expect(done).toBe(true);
  });
});
