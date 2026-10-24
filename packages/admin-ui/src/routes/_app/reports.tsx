import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Ban, CheckCheck, Flag, MoreHorizontal, ShieldX, Trash2, X } from "lucide-react";
import type { ReportStatus, ReportView, ResolveReportRequest } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-header";
import { UserChip } from "@/components/user-chip";
import { EventContent } from "@/components/event-card";
import { ToneBadge, KindBadge, type Tone } from "@/components/badges";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { SelectionBar } from "@/components/selection-bar";
import { SwipeRow } from "@/components/swipe-row";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { useConfirm } from "@/components/confirm";
import { useReport, useReports, useResolveReports } from "@/queries/content";
import { useCan } from "@/queries/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { displayName } from "@/lib/nostr";
import { formatDate, formatNumber, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { mediaUrl } from "@/lib/api";

interface ReportsSearch { status?: ReportStatus; type?: string; id?: string }
const STATUSES: ReportStatus[] = ["open", "resolved", "dismissed"];
const TYPES = ["nudity", "malware", "profanity", "illegal", "spam", "impersonation", "other"];
const TYPE_TONE: Record<string, Tone> = { illegal: "red", malware: "red", nudity: "amber", spam: "sky", impersonation: "violet", profanity: "amber" };

export const Route = createFileRoute("/_app/reports")({
  validateSearch: (s: Record<string, unknown>): ReportsSearch => ({
    status: STATUSES.includes(s.status as ReportStatus) ? (s.status as ReportStatus) : undefined,
    type: typeof s.type === "string" && s.type ? s.type : undefined,
    id: typeof s.id === "string" && /^[0-9a-f]{64}$/i.test(s.id) ? s.id.toLowerCase() : undefined,
  }),
  component: ReportsPage,
});

/**
 * `targetPubkey` is the reported content's author (the user a ban hits); `claimedPubkey` is set when the report's
 * `p` tag names someone else — the reporter's claim, never banned.
 */
type Report = ReportView;

type Action = ResolveReportRequest["action"];
const ACTION_LABEL: Record<Action, string> = {
  dismiss: "Dismiss",
  "delete-event": "Delete content",
  "ban-user": "Ban user",
  "delete-and-ban": "Delete & ban",
  "delete-media": "Delete media",
};
const DESTRUCTIVE: Action[] = ["delete-event", "ban-user", "delete-and-ban", "delete-media"];

function ReportsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const status = search.status ?? "open";
  const q = useReports(status, search.type);
  const linked = useReport(search.id);
  const items = React.useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total;
  const { one, bulk } = useResolveReports();
  const confirm = useConfirm();
  const can = useCan();
  const mobile = useIsMobile();
  const canResolve = can("reports.resolve") && status === "open";
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  React.useEffect(() => setSelected(new Set()), [status, search.type]);

  const resolve = async (ids: string[], action: Action, target?: Report) => {
    let note: string | undefined;
    if (DESTRUCTIVE.includes(action)) {
      const who = target ? displayName(target.targetPubkey, target.targetProfile) : `${ids.length} report target(s)`;
      const claimed = target?.claimedPubkey
        ? ` ${displayName(target.claimedPubkey, target.claimedProfile)}, whom the report names, is not the author and won't be banned.`
        : "";
      const r = await confirm({
        title: `${ACTION_LABEL[action]}?`,
        description:
          action === "ban-user" || action === "delete-and-ban"
            ? `${who} will be banned${action === "delete-and-ban" ? " and the reported content deleted" : ""}.${claimed}`
            : "The reported content will be permanently deleted.",
        destructive: true,
        confirmText: ACTION_LABEL[action],
        input: { label: "Resolution note (optional)" },
      });
      if (!r) return false;
      note = r.input || undefined;
    }
    if (ids.length === 1) await one.mutateAsync({ id: ids[0], action, note });
    else await bulk.mutateAsync({ ids, action, note });
    setSelected(new Set());
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Reports" description={total !== undefined ? `${formatNumber(total)} ${status} report${total === 1 ? "" : "s"}` : "NIP-56 moderation queue"} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Tabs value={status} onValueChange={(v) => navigate({ search: (p: ReportsSearch) => ({ ...p, status: v === "open" ? undefined : (v as ReportStatus) }) })}>
          <TabsList>
            {STATUSES.map((s) => (
              <TabsTrigger key={s} value={s} className="capitalize">
                {s}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select value={search.type ?? "__all"} onValueChange={(v) => navigate({ search: (p: ReportsSearch) => ({ ...p, type: v === "__all" ? undefined : v }) })}>
          <SelectTrigger className="sm:ml-auto sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All types</SelectItem>
            {TYPES.map((t) => (
              <SelectItem key={t} value={t} className="capitalize">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canResolve && items.length > 0 && !mobile && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={items.every((r) => selected.has(r.id))} onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((r) => r.id)) : new Set())} />
            Select all
          </label>
        )}
      </div>
      {search.id && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Linked report</h3>
            <Button size="sm" variant="ghost" onClick={() => navigate({ search: (p: ReportsSearch) => ({ ...p, id: undefined }) })}>
              <X /> Close
            </Button>
          </div>
          {linked.isLoading ? (
            <ListSkeleton rows={1} />
          ) : linked.isError ? (
            <ErrorState error={linked.error} retry={() => linked.refetch()} />
          ) : linked.data ? (
            <ReportCard
              r={linked.data}
              canResolve={can("reports.resolve") && linked.data.status === "open"}
              selected={false}
              onSelect={() => {}}
              onAction={(a) => resolve([linked.data!.id], a, linked.data)}
            />
          ) : null}
        </div>
      )}
      {mobile && canResolve && items.length > 0 && <p className="text-xs text-muted-foreground">Swipe right to dismiss, left to delete & ban.</p>}

      <PullToRefresh onRefresh={() => q.refetch()}>
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !items.length ? (
          <EmptyState icon={status === "open" ? CheckCheck : Flag} title={status === "open" ? "Inbox zero" : `No ${status} reports`} description={status === "open" ? "No reports waiting for review." : undefined} />
        ) : (
          <div className="space-y-3">
            {items.map((r) => {
              const card = (
                <ReportCard
                  r={r}
                  canResolve={canResolve}
                  selected={selected.has(r.id)}
                  onSelect={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(r.id); else n.delete(r.id); return n; })}
                  onAction={(a) => resolve([r.id], a, r)}
                />
              );
              return mobile && canResolve ? (
                <SwipeRow
                  key={r.id}
                  right={{ label: "Dismiss", icon: X, className: "bg-emerald-600 text-white", onTrigger: () => resolve([r.id], "dismiss", r) }}
                  left={{ label: "Delete & ban", icon: Ban, className: "bg-red-600 text-white", onTrigger: () => resolve([r.id], "delete-and-ban", r) }}
                >
                  {card}
                </SwipeRow>
              ) : (
                <React.Fragment key={r.id}>{card}</React.Fragment>
              );
            })}
          </div>
        )}
        <InfiniteSentinel hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onVisible={() => q.fetchNextPage()} />
      </PullToRefresh>

      <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="ghost" className="rounded-full" onClick={() => resolve([...selected], "dismiss")}>
          <X /> Dismiss
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full text-destructive" onClick={() => resolve([...selected], "delete-event")}>
          <Trash2 /> Delete
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full text-destructive" onClick={() => resolve([...selected], "delete-and-ban")}>
          <Ban /> Delete & ban
        </Button>
      </SelectionBar>
    </div>
  );
}

function ReportCard({ r, canResolve, selected, onSelect, onAction }: { r: Report; canResolve: boolean; selected: boolean; onSelect: (v: boolean) => void; onAction: (a: Action) => void }) {
  const mobile = useIsMobile();
  return (
    <div className={cn("space-y-3 rounded-xl border bg-card p-3 sm:p-4", selected && "border-primary/60 bg-primary/5")}>
      <div className="flex items-start gap-3">
        {canResolve && !mobile && <Checkbox className="mt-1" checked={selected} onCheckedChange={(v) => onSelect(v === true)} aria-label="Select report" />}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <ToneBadge t={TYPE_TONE[r.type] ?? "gray"} className="capitalize">
              {r.type}
            </ToneBadge>
            {r.relatedCount > 1 && <ToneBadge t="red">{r.relatedCount} reports on target</ToneBadge>}
            {r.status !== "open" && <ToneBadge t={r.status === "resolved" ? "green" : "gray"}>{r.status}</ToneBadge>}
            <span className="ml-auto text-xs text-muted-foreground" title={formatDate(r.report.created_at)}>
              {timeAgo(r.report.created_at)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <UserChip pubkey={r.reporter} profile={r.reporterProfile} size={22} className="max-w-48" />
            <span>reported</span>
            {r.targetPubkey ? <UserChip pubkey={r.targetPubkey} profile={r.targetProfile} size={22} className="max-w-48" /> : <span>an unknown user</span>}
          </div>
        </div>
      </div>
      {r.claimedPubkey && (
        // the reporter's `p` tag points at someone who didn't post this content: show it, but bans go to the author
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>The report names</span>
          <UserChip pubkey={r.claimedPubkey} profile={r.claimedProfile} size={16} className="max-w-40" />
          <span>
            instead of the {r.targetEvent ? "content's author" : "media's uploader"}.{" "}
            {r.targetPubkey ? `A ban applies to the ${r.targetEvent ? "author" : "uploader"} shown above.` : "The media has several uploaders: ban them from their user pages."}
          </span>
        </div>
      )}
      {r.report.content && <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm italic">“{r.report.content}”</p>}
      {r.targetEvent ? (
        <div className="rounded-lg border p-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <KindBadge kind={r.targetEvent.kind} /> reported content · {timeAgo(r.targetEvent.created_at)}
          </div>
          <EventContent event={r.targetEvent} compact />
        </div>
      ) : r.targetEventId ? (
        <p className="text-xs text-muted-foreground">Reported event {r.targetEventId.slice(0, 12)}… is no longer stored, so its author can't be checked against the reported user.</p>
      ) : null}
      {r.targetBlob && (
        // admin media endpoint (session auth) — the public Blossom URL hides pending/blocked blobs, which reported media often is
        <a href={mediaUrl({ sha256: r.targetBlob })} target="_blank" rel="noreferrer" className="block w-fit overflow-hidden rounded-lg border">
          <img src={mediaUrl({ sha256: r.targetBlob })} alt="Reported media" className="max-h-48 max-w-full object-contain blur-md transition hover:blur-none" />
        </a>
      )}
      {r.resolution && (
        <p className="text-xs text-muted-foreground">
          {r.resolution.action} by <UserChip pubkey={r.resolution.by} size={16} className="inline-flex" /> {timeAgo(r.resolution.at)}
          {r.resolution.note ? ` — ${r.resolution.note}` : ""}
        </p>
      )}
      {canResolve && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onAction("dismiss")}>
            <X /> Dismiss
          </Button>
          {(r.targetEventId || r.targetEvent) && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => onAction("delete-event")}>
              <Trash2 /> Delete
            </Button>
          )}
          {r.targetPubkey && (
            <Button size="sm" variant="destructive" onClick={() => onAction("delete-and-ban")}>
              <Ban /> Delete & ban
            </Button>
          )}
          {(r.targetPubkey || r.targetBlob) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="More">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {r.targetPubkey && (
                  <DropdownMenuItem variant="destructive" onSelect={() => onAction("ban-user")}>
                    <ShieldX /> Ban user only
                  </DropdownMenuItem>
                )}
                {r.targetBlob && (
                  <>
                    {r.targetPubkey && <DropdownMenuSeparator />}
                    <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete-media")}>
                      <Trash2 /> Delete media
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}
