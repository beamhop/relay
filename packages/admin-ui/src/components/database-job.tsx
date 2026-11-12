import { AlertTriangle, Check, CircleX, Loader2, PauseCircle } from "lucide-react";
import type { DatabaseSwitchJobView, DatabaseSwitchPhase } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { DRIVER_LABEL, overallPercent, PAUSED_PHASES, stepIndex, SWITCH_STEPS, tablePercent, targetLocation } from "@/lib/database";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Live view of a database switch: phase stepper, per-table progress, pause timer, cancel, and the outcome. */
export function DatabaseJobProgress({
  job, lastPhase, onCancel, cancelling,
}: {
  job: DatabaseSwitchJobView;
  /** the last running phase seen while polling: marks where a failed or cancelled job stopped */
  lastPhase?: DatabaseSwitchPhase;
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const ended = job.phase === "failed" || job.phase === "cancelled";
  const failedAt = ended && lastPhase ? stepIndex(lastPhase) : -1;
  const at = ended ? failedAt : stepIndex(job.phase);
  const paused = PAUSED_PHASES.has(job.phase);
  const tables = [...job.tables].sort((a, b) => Number(a.done) - Number(b.done) || b.total - a.total);
  return (
    <div className="space-y-4">
      <p className="min-w-0 text-sm text-muted-foreground">
        {DRIVER_LABEL[job.from.driver]} → {DRIVER_LABEL[job.to.driver]}{" "}
        <code className="break-all text-xs">{targetLocation(job.to)}</code>
      </p>
      <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4" aria-label="Switch steps">
        {SWITCH_STEPS.map((s, i) => {
          const state = i === failedAt ? "failed" : i < at || job.phase === "done" ? "done" : i === at ? "active" : "pending";
          return (
            <li
              key={s.phase}
              data-step={state}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs",
                state === "done" && "border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                state === "active" && "border-primary/50 bg-primary/5 font-medium",
                state === "failed" && "border-transparent bg-destructive/10 text-destructive",
                state === "pending" && "text-muted-foreground",
              )}
            >
              {state === "done" ? <Check className="size-3.5" /> : state === "active" ? <Loader2 className="size-3.5 animate-spin" /> : state === "failed" ? <CircleX className="size-3.5" /> : <span className="size-3.5 text-center">{i + 1}</span>}
              <span className="truncate">{s.label}</span>
            </li>
          );
        })}
      </ol>

      {job.pausedMs !== undefined && (
        <p className={cn("flex items-center gap-1.5 text-sm", paused ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
          <PauseCircle className="size-4" />
          {paused ? "Writes paused for " : "Writes were paused for "}
          <span className="tabular-nums">{(job.pausedMs / 1000).toFixed(1)} s</span>
        </p>
      )}

      {tables.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{tables.filter((t) => t.done).length} of {tables.length} tables copied</span>
            <span className="tabular-nums">{overallPercent(tables)}%</span>
          </div>
          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {tables.map((t) => (
              <li key={t.table} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <code className="min-w-0 truncate">{t.table}</code>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatNumber(t.copied)} / {formatNumber(t.total)}
                  </span>
                </div>
                <Progress value={tablePercent(t)} aria-label={`${t.table} copied`} className="h-1.5" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {job.phase === "done" && !job.error && (
        <p className="flex gap-2 rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
          <Check className="mt-0.5 size-4 shrink-0" /> The relay now runs on {DRIVER_LABEL[job.to.driver]}. The old database is kept as a rollback point below.
        </p>
      )}
      {job.phase === "done" && job.error && (
        <p className="flex gap-2 rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> <span className="min-w-0 break-words">Switched, with a warning: {job.error.replace(/^done with warning:\s*/, "")}</span>
        </p>
      )}
      {job.phase === "failed" && (
        <p className="flex gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <CircleX className="mt-0.5 size-4 shrink-0" /> <span className="min-w-0 break-words">{job.error ?? "The switch failed."} The relay keeps running on the current database.</span>
        </p>
      )}
      {job.phase === "cancelled" && <p className="text-sm text-muted-foreground">Cancelled. The relay keeps running on the current database.</p>}

      {job.cancellable && onCancel && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={onCancel} disabled={cancelling}>
            Cancel switch
          </Button>
        </div>
      )}
    </div>
  );
}
