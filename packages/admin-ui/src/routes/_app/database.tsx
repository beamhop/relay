import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRightLeft, Database, History, Lock, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  DELETE_ROLLBACK_CONFIRM_PHRASE,
  WIPE_CONFIRM_PHRASE,
  type DatabaseStatusResponse,
  type DatabaseSwitchJobView,
  type DatabaseSwitchPhase,
  type DatabaseTestResult,
} from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { ToneBadge } from "@/components/badges";
import { ReauthDialog, useReauthAction } from "@/components/reauth";
import { DatabaseJobProgress } from "@/components/database-job";
import { useMe } from "@/queries/auth";
import { DATABASE_KEY, databaseApi, isTerminal, useDatabaseStatus, useSwitchJob } from "@/queries/database";
import { buildTarget, DRIVER_LABEL, targetLocation, targetProblem, type Driver } from "@/lib/database";
import { errorMessage, HttpError } from "@/lib/api";
import { formatBytes, formatDate, formatNumber, timeAgo } from "@/lib/format";

export const Route = createFileRoute("/_app/database")({ component: DatabasePage });

function DatabasePage() {
  const { data: status, isLoading, error, refetch } = useDatabaseStatus();
  const [jobId, setJobId] = React.useState<string>();
  const [started, setStarted] = React.useState<DatabaseSwitchJobView>();
  const [dismissed, setDismissed] = React.useState<string>();
  const id = jobId ?? status?.job?.id;
  const { data: polled } = useSwitchJob(id, started ?? status?.job);
  const job = polled ?? (status?.job?.id === id ? status?.job : undefined);
  const qc = useQueryClient();

  // remember the last running phase, so a failed job can show where it stopped
  const lastPhase = React.useRef<DatabaseSwitchPhase | undefined>(undefined);
  if (job && !isTerminal(job.phase)) lastPhase.current = job.phase;
  // once a job ends, the current database / rollback points may have changed
  const ended = job ? isTerminal(job.phase) : false;
  React.useEffect(() => {
    if (ended) qc.invalidateQueries({ queryKey: DATABASE_KEY, exact: true });
  }, [ended, qc]);

  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  if (error instanceof HttpError && error.code === "db_switch_unavailable")
    return (
      <div className="space-y-4">
        <PageHeader title="Database" description="Where the relay stores its data" />
        <EmptyState icon={Database} title="Database switching isn't available" description="This server was started without runtime database switching." />
      </div>
    );
  if (error || !status) return <ErrorState error={error ?? "Unavailable"} retry={() => refetch()} />;

  const running = !!job && !isTerminal(job.phase);
  return (
    <div className="space-y-4">
      <PageHeader title="Database" description="Where the relay stores its data, and switching between SQLite and PostgreSQL while it runs" />
      {status.blockedReason && !running && (
        <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{status.blockedReason}</span>
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <CurrentCard status={status} />
        {job && job.id !== dismissed && (
          <JobCard job={job} lastPhase={lastPhase.current} canCancel={status.canSwitch} onDismiss={running ? undefined : () => setDismissed(job.id)} />
        )}
        {!running && (
          <SwitchCard
            // starts over (target defaults included) once the current database changed
            key={`${status.current.driver}:${targetLocation(status.current)}`}
            status={status}
            onStarted={(j) => {
              lastPhase.current = undefined;
              setStarted(j);
              setJobId(j.id);
            }}
          />
        )}
      </div>
      <RollbacksCard status={status} />
    </div>
  );
}

function CurrentCard({ status }: { status: DatabaseStatusResponse }) {
  const cur = status.current;
  const rows = status.tables.reduce((n, t) => n + t.rows, 0);
  const tables = [...status.tables].sort((a, b) => b.rows - a.rows);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4" /> Current database
        </CardTitle>
        <CardDescription>What the relay reads and writes right now</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="divide-y text-sm">
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="text-muted-foreground">Driver</dt>
            <dd>
              <ToneBadge t={cur.driver === "postgres" ? "sky" : "violet"}>{DRIVER_LABEL[cur.driver]}</ToneBadge>
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 py-2">
            <dt className="shrink-0 text-muted-foreground">{cur.driver === "postgres" ? "URL" : "File"}</dt>
            <dd className="min-w-0 text-right">
              <code className="break-all text-xs">{targetLocation(cur)}</code>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="text-muted-foreground">Size</dt>
            <dd className="tabular-nums">{status.sizeBytes !== undefined ? formatBytes(status.sizeBytes) : "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="text-muted-foreground">Rows</dt>
            <dd className="tabular-nums">
              {formatNumber(rows)} in {status.tables.length} tables
            </dd>
          </div>
          {status.instances.length > 1 && (
            <div className="flex items-center justify-between gap-4 py-2">
              <dt className="text-muted-foreground">Instances</dt>
              <dd>{status.instances.map((i) => i.host ?? i.id.slice(0, 8)).join(", ")}</dd>
            </div>
          )}
        </dl>
        {tables.length > 0 && (
          <details className="group rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Row counts per table</summary>
            <ul className="max-h-64 divide-y overflow-y-auto border-t text-xs">
              {tables.map((t) => (
                <li key={t.name} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <code className="min-w-0 truncate">{t.name}</code>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(t.rows)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function JobCard({ job, lastPhase, canCancel, onDismiss }: { job: DatabaseSwitchJobView; lastPhase?: DatabaseSwitchPhase; canCancel: boolean; onDismiss?: () => void }) {
  const qc = useQueryClient();
  const [cancelling, setCancelling] = React.useState(false);
  const cancel = async () => {
    setCancelling(true);
    try {
      const r = await databaseApi.cancel(job.id);
      if (!r.cancelled) toast.error("Too late to cancel: writes are already paused");
      qc.invalidateQueries({ queryKey: ["database", "job", job.id] });
    } catch (err) {
      toast.error("Could not cancel", { description: errorMessage(err) });
    } finally {
      setCancelling(false);
    }
  };
  const running = !isTerminal(job.phase);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="size-4" /> {running ? "Switching database" : "Last switch"}
        </CardTitle>
        <CardDescription>
          Started {timeAgo(job.startedAt)}
          {job.finishedAt ? ` · finished ${formatDate(job.finishedAt)}` : ""}
          {running ? " · the relay keeps serving; writes pause for a few seconds at the end" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DatabaseJobProgress job={job} lastPhase={lastPhase} onCancel={canCancel ? cancel : undefined} cancelling={cancelling} />
      </CardContent>
      {onDismiss && (
        <CardFooter className="justify-end">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function SwitchCard({ status, onStarted }: { status: DatabaseStatusResponse; onStarted: (j: DatabaseSwitchJobView) => void }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const other: Driver = status.current.driver === "sqlite" ? "postgres" : "sqlite";
  const [driver, setDriver] = React.useState<Driver>(other);
  const [pgUrl, setPgUrl] = React.useState(status.envPostgresUrl ?? "");
  const [sqlitePath, setSqlitePath] = React.useState(status.defaultSqlitePath);
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<DatabaseTestResult>();
  const [typed, setTyped] = React.useState("");
  const value = driver === "postgres" ? pgUrl : sqlitePath;
  const problem = targetProblem(driver, value);
  const disabled = !status.canSwitch || !!status.blockedReason;

  // a changed target needs a new test
  React.useEffect(() => {
    setResult(undefined);
    setTyped("");
  }, [driver, value]);

  const target = buildTarget(driver, value, status.envPostgresUrl);
  const test = async () => {
    setTesting(true);
    try {
      setResult(await databaseApi.test(target));
    } catch (err) {
      toast.error("Test failed", { description: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const needsWipe = !!result && result.ok && !result.empty;
  const start = useReauthAction<void>(
    async (_, currentPassword) => {
      const j = await databaseApi.start({ target, ...(needsWipe ? { wipeConfirm: typed.trim() } : {}), ...(currentPassword ? { currentPassword } : {}) });
      toast.success("Database switch started");
      qc.invalidateQueries({ queryKey: DATABASE_KEY, exact: true });
      onStarted(j);
    },
    { hasPassword: !!me?.hasPassword, onError: (err) => toast.error("Could not start the switch", { description: errorMessage(err) }) },
  );
  const canStart = !!result?.ok && (!needsWipe || typed.trim() === WIPE_CONFIRM_PHRASE) && !start.busy;
  const prefilled = driver === "postgres" && !!status.envPostgresUrl && pgUrl === status.envPostgresUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="size-4" /> Switch database
        </CardTitle>
        <CardDescription>
          Copies everything to the new database while the relay runs, verifies it, then switches over. The current database is kept untouched as a rollback point.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem && !disabled) test();
          }}
        >
          <fieldset disabled={disabled} className="space-y-4">
            <div className="space-y-2">
              <Label>Target</Label>
              <ToggleGroup type="single" variant="outline" value={driver} onValueChange={(v) => v && setDriver(v as Driver)} className="w-full">
                {(["postgres", "sqlite"] as const).map((d) => (
                  <ToggleGroupItem key={d} value={d} className="flex-1">
                    {DRIVER_LABEL[d]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {driver === "postgres" ? (
              <div className="space-y-2">
                <Label htmlFor="db-pg-url">Connection URL</Label>
                <Input
                  id="db-pg-url"
                  value={pgUrl}
                  onChange={(e) => setPgUrl(e.target.value)}
                  placeholder="postgres://user:password@host:5432/beamhop"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                />
                <p className="text-xs text-muted-foreground">
                  {prefilled
                    ? "From the server's configuration (password hidden). Leave it as is to use it, or type the full URL including the password."
                    : "The database must exist. It should be empty; otherwise you'll be asked to confirm erasing it."}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="db-sqlite-path">File path</Label>
                <Input id="db-sqlite-path" value={sqlitePath} onChange={(e) => setSqlitePath(e.target.value)} autoComplete="off" spellCheck={false} />
                <p className="text-xs text-muted-foreground">An absolute path on the server. The file is created if it doesn't exist.</p>
              </div>
            )}
            {value.trim() && problem && <p className="text-xs text-destructive">{problem}</p>}
          </fieldset>

          {result && <TestResult result={result} />}

          {needsWipe && (
            <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <p className="flex gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> This database is not empty
              </p>
              <ul className="max-h-40 overflow-y-auto text-xs">
                {result!.existingTables.map((t) => (
                  <li key={t.name} className="flex justify-between gap-2 py-0.5">
                    <code className="min-w-0 truncate">{t.name}</code>
                    <span className="tabular-nums text-muted-foreground">{formatNumber(t.rows)} rows</span>
                  </li>
                ))}
              </ul>
              <Label htmlFor="db-wipe-confirm" className="block text-sm leading-normal font-normal">
                Everything in it will be erased. Type <span className="font-mono font-semibold">{WIPE_CONFIRM_PHRASE}</span> to continue.
              </Label>
              <Input id="db-wipe-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="submit" variant={result?.ok ? "outline" : "default"} disabled={disabled || !!problem || testing}>
              {testing ? "Testing…" : result ? "Test again" : "Test connection"}
            </Button>
            {result?.ok && (
              <Button type="button" variant={needsWipe ? "destructive" : "default"} disabled={!canStart || disabled} onClick={() => start.run(undefined)}>
                {start.busy ? "Starting…" : `Switch to ${DRIVER_LABEL[driver]}`}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
      <ReauthDialog reauth={start.reauth} action="switch the database" busy={start.busy} onCancel={start.cancel} onSubmit={start.retry} />
    </Card>
  );
}

function TestResult({ result }: { result: DatabaseTestResult }) {
  if (!result.ok)
    return (
      <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <p className="font-medium text-destructive">{result.reachable ? "This database can't be used" : "Could not connect"}</p>
        {result.errors.map((e, i) => (
          <p key={i} className="break-words text-muted-foreground">
            {e}
          </p>
        ))}
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
      <ToneBadge t="green">Connected</ToneBadge>
      {result.serverVersion && <span className="text-muted-foreground">{result.serverVersion}</span>}
      {result.empty ? <ToneBadge t="gray">empty</ToneBadge> : <ToneBadge t="amber">{result.existingTables.length} tables</ToneBadge>}
    </div>
  );
}

function RollbacksCard({ status }: { status: DatabaseStatusResponse }) {
  const [deleting, setDeleting] = React.useState<DatabaseStatusResponse["rollbacks"][number]>();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" /> Rollback points
        </CardTitle>
        <CardDescription>
          Databases left behind by earlier switches. They are no longer written to. Switching back to one is a fresh full copy; delete them once you no longer need them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {status.rollbacks.length === 0 && <p className="text-sm text-muted-foreground">No rollback points.</p>}
        {status.rollbacks.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-lg border p-3">
            <Database className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {DRIVER_LABEL[r.target.driver]}
                <span className="text-xs font-normal text-muted-foreground">
                  replaced by {DRIVER_LABEL[r.replacedBy]} {timeAgo(r.frozenAt)}
                </span>
              </p>
              <code className="block break-all text-xs text-muted-foreground">{targetLocation(r.target)}</code>
            </div>
            {status.canSwitch && (
              <Button variant="ghost" size="icon-sm" className="shrink-0 text-destructive" aria-label="Delete old database" onClick={() => setDeleting(r)}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </CardContent>
      <DeleteRollbackDialog point={deleting} onClose={() => setDeleting(undefined)} />
    </Card>
  );
}

function DeleteRollbackDialog({ point, onClose }: { point?: DatabaseStatusResponse["rollbacks"][number]; onClose: () => void }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [typed, setTyped] = React.useState("");
  const [pw, setPw] = React.useState("");
  const removal = useReauthAction<string>(
    async (id, currentPassword) => {
      await databaseApi.deleteRollback(id, { confirm: typed.trim(), ...(currentPassword ? { currentPassword } : {}) });
      toast.success("Old database deleted");
      qc.invalidateQueries({ queryKey: DATABASE_KEY, exact: true });
      close();
    },
    { hasPassword: !!me?.hasPassword, onError: (err) => toast.error("Could not delete the old database", { description: errorMessage(err) }) },
  );
  function close() {
    setTyped("");
    setPw("");
    removal.cancel();
    onClose();
  }
  const ok = typed.trim() === DELETE_ROLLBACK_CONFIRM_PHRASE && (removal.reauth !== "password" || !!pw) && removal.reauth !== "signin";
  return (
    <ResponsiveDialog
      open={!!point}
      onOpenChange={(o) => !o && close()}
      title="Delete old database?"
      description={point ? `${DRIVER_LABEL[point.target.driver]}, frozen ${formatDate(point.frozenAt)}` : undefined}
      footer={
        <Button type="submit" form="db-rollback-delete" variant="destructive" disabled={!ok || removal.busy}>
          {removal.busy ? "Deleting…" : "Delete permanently"}
        </Button>
      }
    >
      <form
        id="db-rollback-delete"
        className="space-y-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (point && ok) removal.run(point.id, pw || undefined);
        }}
      >
        {point && <code className="block break-all rounded-md bg-muted p-2 text-xs">{targetLocation(point.target)}</code>}
        <p className="text-sm text-muted-foreground">
          {point?.target.driver === "sqlite" ? "The file and its WAL/SHM files are removed." : "Every table in that database is dropped."} This can't be undone.
        </p>
        <div className="space-y-2">
          <Label htmlFor="db-rollback-confirm" className="block leading-normal">
            Type <span className="font-mono font-semibold">{DELETE_ROLLBACK_CONFIRM_PHRASE}</span> to confirm
          </Label>
          <Input id="db-rollback-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        {removal.reauth === "password" && (
          <div className="space-y-2">
            <Label htmlFor="db-rollback-pw">Current password</Label>
            <Input id="db-rollback-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            <p className="text-xs text-muted-foreground">Confirm your password to delete an old database, or sign in again.</p>
          </div>
        )}
        {removal.reauth === "signin" && (
          <p className="text-xs text-muted-foreground">For your security, sign out and sign in again, then delete the old database within 15 minutes.</p>
        )}
      </form>
    </ResponsiveDialog>
  );
}
