import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DatabaseSwitchJobView } from "@beamhop/sdk/admin-contract";
import { DatabaseJobProgress } from "../src/components/database-job";
import { buildTarget, overallPercent, stepIndex, tablePercent, targetProblem } from "../src/lib/database";

const job = (patch: Partial<DatabaseSwitchJobView> = {}): DatabaseSwitchJobView => ({
  id: "j",
  from: { driver: "sqlite", sqlitePath: "/data/beamhop.db" },
  to: { driver: "postgres", postgresUrl: "postgres://u:***@h/db" },
  phase: "bulk_copy",
  startedAt: 1_700_000_000,
  tables: [
    { table: "events", total: 200, copied: 50, done: false },
    { table: "kv", total: 4, copied: 4, done: true },
  ],
  cancellable: true,
  actor: "a".repeat(64),
  ...patch,
});

const states = (html: string) => [...html.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);

describe("database switch helpers", () => {
  test("the redacted prefill sent back unchanged means the configured URL", () => {
    const prefill = "postgres://u:***@h/db";
    expect(buildTarget("postgres", ` ${prefill} `, prefill)).toEqual({ driver: "postgres", postgresUrl: "env" });
    expect(buildTarget("postgres", "postgres://u:real@h/db", prefill)).toEqual({ driver: "postgres", postgresUrl: "postgres://u:real@h/db" });
    expect(buildTarget("sqlite", "/data/x.db")).toEqual({ driver: "sqlite", sqlitePath: "/data/x.db" });
  });

  test("targets are checked like the server does", () => {
    expect(targetProblem("postgres", "mysql://h/db")).toContain("postgres://");
    expect(targetProblem("postgres", "postgresql://h/db")).toBeUndefined();
    expect(targetProblem("sqlite", "data/x.db")).toContain("absolute");
    expect(targetProblem("sqlite", "/data/x.db")).toBeUndefined();
    expect(targetProblem("sqlite", " ")).toBeDefined();
  });

  test("progress", () => {
    expect(tablePercent({ table: "t", total: 0, copied: 0, done: false })).toBe(0);
    expect(tablePercent({ table: "t", total: 0, copied: 0, done: true })).toBe(100);
    expect(tablePercent({ table: "t", total: 10, copied: 25, done: false })).toBe(100);
    expect(overallPercent(job().tables)).toBe(26);
    expect(overallPercent([])).toBe(0);
    expect(stepIndex("done")).toBe(8);
    expect(stepIndex("preflight")).toBe(0);
  });
});

describe("DatabaseJobProgress", () => {
  test("bulk copy: steps, per-table bars, cancel button", () => {
    const html = renderToStaticMarkup(<DatabaseJobProgress job={job()} onCancel={() => {}} />);
    expect(states(html)).toEqual(["done", "done", "active", "pending", "pending", "pending", "pending", "pending"]);
    expect(html).toContain("1 of 2 tables copied");
    expect(html).toContain("events");
    expect(html).toContain("Cancel switch");
    expect(html).not.toContain("Writes paused");
  });

  test("paused: the timer shows and cancel is gone", () => {
    const html = renderToStaticMarkup(<DatabaseJobProgress job={job({ phase: "final_copy", cancellable: false, pausedMs: 2345 })} onCancel={() => {}} />);
    expect(html).toContain("Writes paused for");
    expect(html).toContain("2.3 s");
    expect(html).not.toContain("Cancel switch");
  });

  test("failed: marks the step it stopped at and shows the reason", () => {
    const html = renderToStaticMarkup(
      <DatabaseJobProgress job={job({ phase: "failed", cancellable: false, pausedMs: 15000, error: "too many changes during the final copy" })} lastPhase="final_copy" />,
    );
    expect(states(html)).toEqual(["done", "done", "done", "done", "failed", "pending", "pending", "pending"]);
    expect(html).toContain("too many changes during the final copy");
    expect(html).toContain("keeps running on the current database");
  });

  test("done with a warning", () => {
    const html = renderToStaticMarkup(<DatabaseJobProgress job={job({ phase: "done", cancellable: false, pausedMs: 900, error: "done with warning: state file not saved" })} />);
    expect(states(html).every((s) => s === "done")).toBe(true);
    expect(html).toContain("Switched, with a warning: state file not saved");
  });
});
