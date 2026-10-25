import { describe, expect, test } from "bun:test";
import { HookRegistry, HookTimeoutError, type HookIncident, type NostrEvent } from "../src/index";

const ev = { id: "x", pubkey: "p", created_at: 0, kind: 1, tags: [], content: "", sig: "s" } as NostrEvent;
const never = () => new Promise<never>(() => {});

describe("copy-on-write hook lists", () => {
  test("removing a hook while runWrite awaits it does not skip the next plugin's hook", async () => {
    const reg = new HookRegistry();
    let release!: () => void;
    const offA = reg.onWrite(async () => {
      await new Promise<void>((r) => (release = r));
      return undefined;
    }, "plugin:a", 10);
    let bRan = false;
    reg.onWrite(async () => {
      bRan = true;
      return { action: "reject", reason: "spam" };
    }, "plugin:spam", 50);
    const p = reg.runWrite(ev, { source: "ws" });
    await Bun.sleep(1);
    offA(); // plugin a disabled mid-flight
    release();
    const r = await p;
    expect(bRan).toBe(true);
    expect(r.result).toBe("reject");
    expect(reg.counts.write).toBe(1);
  });

  test("removeOwner mid-run leaves the running snapshot intact; later runs see the change", async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    let release!: () => void;
    reg.onQuery(async () => {
      order.push("a");
      await new Promise<void>((r) => (release = r));
    }, "plugin:a", 1);
    reg.onQuery(() => void order.push("b"), "plugin:b", 2);
    reg.onQuery(() => void order.push("c"), "plugin:c", 3);
    const p = reg.runQuery([{}], { source: "ws" });
    await Bun.sleep(1);
    reg.removeOwner("plugin:b");
    release();
    await p;
    expect(order).toEqual(["a", "b", "c"]);
    expect(reg.counts.query).toBe(2);
  });

  test("equal priorities keep registration order", async () => {
    const reg = new HookRegistry();
    const order: number[] = [];
    for (let i = 0; i < 5; i++) reg.onWrite(() => void order.push(i));
    await reg.runWrite(ev, { source: "ws" });
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("hook timeouts", () => {
  test("a hung write hook fails open, aborts its signal and reports the owner", async () => {
    const incidents: HookIncident[] = [];
    const reg = new HookRegistry({ timeouts: { write: 20 }, onIncident: (i) => incidents.push(i) });
    let signal: AbortSignal | undefined;
    reg.onWrite((_e, ctx) => {
      signal = ctx.signal;
      return never();
    }, "plugin:slow");
    let laterRan = false;
    reg.onWrite(() => {
      laterRan = true;
      return { action: "shadow" };
    }, "plugin:next");
    const r = await reg.runWrite(ev, { source: "ws" });
    expect(r.result).toBe("shadow");
    expect(laterRan).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(HookTimeoutError);
    expect(incidents).toEqual([{ kind: "write", owner: "plugin:slow", type: "timeout", timeoutMs: 20 }]);
  });

  test("a thrown write hook still fails closed and names its owner", async () => {
    const incidents: HookIncident[] = [];
    const reg = new HookRegistry({ onIncident: (i) => incidents.push(i) });
    reg.onWrite(async () => {
      throw new Error("db down");
    }, "plugin:bad");
    const r = await reg.runWrite(ev, { source: "ws" });
    expect(r).toMatchObject({ result: "reject", reason: "error: policy plugin:bad failed" });
    expect(incidents[0]).toMatchObject({ kind: "write", owner: "plugin:bad", type: "error" });
  });

  test("a query hook that never resolves fails closed with a reason naming the owner", async () => {
    const reg = new HookRegistry({ timeouts: { query: 20 } });
    reg.onQuery(never, "plugin:slow");
    expect(await reg.runQuery([{ kinds: [1] }], { source: "ws" })).toEqual({ reject: "error: query policy plugin:slow timed out" });
  });

  test("a throwing query hook is caught per hook (fail closed)", async () => {
    const reg = new HookRegistry();
    reg.onQuery(() => {
      throw new Error("x");
    }, "plugin:bad");
    expect(await reg.runQuery([{}], { source: "count" })).toEqual({ reject: "error: query policy plugin:bad failed" });
  });

  test("a blob hook timeout throws HookTimeoutError (fail closed); per-registration timeout overrides the default", async () => {
    const reg = new HookRegistry();
    let signal: AbortSignal | undefined;
    reg.onBlobUpload((info) => {
      signal = info.signal;
      return never();
    }, "plugin:scanner", { timeoutMs: 20 });
    const err = await reg.runBlobUpload({ sha256: "a", size: 1, type: "x", pubkey: "p" }, new Uint8Array(1)).catch((e) => e);
    expect(err).toBeInstanceOf(HookTimeoutError);
    expect(err.owner).toBe("plugin:scanner");
    expect(signal?.aborted).toBe(true);
  });

  test("a late rejection after a timeout is swallowed (no unhandled rejection)", async () => {
    const reg = new HookRegistry({ timeouts: { write: 10 } });
    let fail!: (e: Error) => void;
    reg.onWrite(() => new Promise((_, rej) => (fail = rej)), "plugin:late");
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect((await reg.runWrite(ev, { source: "ws" })).result).toBe("next");
      fail(new Error("too late"));
      await Bun.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("sync hooks don't arm timers and a zero budget means unlimited", async () => {
    const reg = new HookRegistry({ timeouts: { write: 0 } });
    reg.onWrite(async () => {
      await Bun.sleep(15);
      return { action: "reject", reason: "slow but wanted" };
    });
    expect((await reg.runWrite(ev, { source: "ws" })).reason).toBe("slow but wanted");
  });
});
