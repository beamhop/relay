import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus, createLogger, safeStringify } from "../src/index";

describe("safeStringify", () => {
  test("Errors keep message and stack, BigInt becomes a string, cycles become [Circular]", () => {
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    const out = JSON.parse(safeStringify({ err: new Error("boom"), n: 10n, circ }));
    expect(out.err.message).toBe("boom");
    expect(out.err.stack).toContain("boom");
    expect(out.n).toBe("10");
    expect(out.circ).toEqual({ a: 1, self: "[Circular]" });
  });

  test("a throwing toJSON does not throw", () => {
    expect(() => safeStringify({ x: { toJSON() { throw new Error("no"); } } })).not.toThrow();
  });
});

describe("logger and bus never throw", () => {
  const original = console.error;
  let lines: unknown[][] = [];
  beforeEach(() => {
    lines = [];
    console.error = (...a: unknown[]) => void lines.push(a);
  });
  afterEach(() => {
    console.error = original;
  });

  test("logging data that JSON.stringify can't handle", () => {
    const circ: Record<string, unknown> = {};
    circ.circ = circ;
    const log = createLogger("debug");
    expect(() => log.error("x", { n: 1n, circ })).not.toThrow();
    expect(String(lines[0][0])).toContain('"n":"1"');
  });

  test("json format: one parseable object per line, scope carried to children, data can't shadow the fixed fields", () => {
    const log = createLogger("info", "beamhop", "json").child("db");
    log.debug("hidden");
    log.error("boom", { err: new Error("e"), level: "spoofed", msg: "spoofed", n: 1 });
    expect(lines).toHaveLength(1);
    const o = JSON.parse(String(lines[0][0]));
    expect(Object.keys(o).slice(0, 4)).toEqual(["time", "level", "scope", "msg"]);
    expect(o).toMatchObject({ level: "error", scope: "beamhop:db", msg: "boom", n: 1, err: { name: "Error", message: "e" } });
    expect(Number.isNaN(Date.parse(o.time))).toBe(false);
  });

  test("a failing bus handler is logged once per minute per (event, handler), through the logger", () => {
    const logged: { msg: string; data?: Record<string, unknown> }[] = [];
    const bus = new EventBus({ logger: { error: (msg, data) => void logged.push({ msg, data }) } });
    bus.on("alert", function noisy() {
      throw new Error("handler bug");
    });
    for (let i = 0; i < 100; i++) bus.emit("alert", { level: "info", title: "t", message: "m" });
    expect(logged).toHaveLength(1);
    expect(logged[0].msg).toContain("noisy");
    expect(logged[0].msg).toContain("alert");
    expect(lines).toHaveLength(0);
  });
});
