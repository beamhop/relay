import type { DatabaseSwitchPhase, DatabaseTarget, TableProgress } from "@beamhop/sdk/admin-contract";

export type Driver = DatabaseTarget["driver"];

export const DRIVER_LABEL: Record<Driver, string> = { sqlite: "SQLite", postgres: "PostgreSQL" };

/** the phases a successful switch walks through, in order */
export const SWITCH_STEPS: { phase: DatabaseSwitchPhase; label: string }[] = [
  { phase: "preflight", label: "Checks" },
  { phase: "schema", label: "Schema" },
  { phase: "bulk_copy", label: "Copy" },
  { phase: "pausing", label: "Pause writes" },
  { phase: "final_copy", label: "Final copy" },
  { phase: "verify", label: "Verify" },
  { phase: "switching", label: "Switch" },
  { phase: "persist", label: "Save" },
];

/** phases during which writes are paused */
export const PAUSED_PHASES: ReadonlySet<DatabaseSwitchPhase> = new Set(["pausing", "final_copy", "verify", "switching", "persist"]);

/** index of the step a job is at (done: past the last one) */
export function stepIndex(phase: DatabaseSwitchPhase): number {
  if (phase === "done") return SWITCH_STEPS.length;
  return SWITCH_STEPS.findIndex((s) => s.phase === phase);
}

/** where a target lives, for display */
export const targetLocation = (t: DatabaseTarget) => (t.driver === "postgres" ? (t.postgresUrl ?? "") : (t.sqlitePath ?? ""));

/**
 * The target the API is sent. A postgres URL left as the (redacted) prefill becomes "env": the server then uses the
 * configured URL, password included.
 */
export function buildTarget(driver: Driver, value: string, envPrefill?: string): DatabaseTarget {
  const v = value.trim();
  if (driver === "sqlite") return { driver, sqlitePath: v };
  return { driver, postgresUrl: envPrefill && v === envPrefill ? "env" : v };
}

/** Client-side check matching the server's validation; returns a message or undefined. */
export function targetProblem(driver: Driver, value: string): string | undefined {
  const v = value.trim();
  if (!v) return driver === "sqlite" ? "Enter a file path" : "Enter a connection URL";
  if (driver === "postgres") return /^postgres(ql)?:\/\//i.test(v) ? undefined : "The URL must start with postgres:// or postgresql://";
  return v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) ? undefined : "The path must be absolute";
}

export function tablePercent(t: TableProgress): number {
  if (t.done) return 100;
  if (!t.total) return 0;
  return Math.min(100, Math.round((t.copied / t.total) * 100));
}

export function overallPercent(tables: TableProgress[]): number {
  const total = tables.reduce((n, t) => n + Math.max(t.total, t.copied), 0);
  if (!total) return tables.length && tables.every((t) => t.done) ? 100 : 0;
  return Math.min(100, Math.round((tables.reduce((n, t) => n + (t.done ? Math.max(t.total, t.copied) : t.copied), 0) / total) * 100));
}
