import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ScrollText, X } from "lucide-react";
import type { AuditView } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { UserChip } from "@/components/user-chip";
import { JsonView } from "@/components/json-view";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { ToneBadge, type Tone } from "@/components/badges";
import { useAudit, type AuditQuery } from "@/queries/misc";
import { formatDate, timeAgo } from "@/lib/format";
import { isHex64, parsePubkey } from "@/lib/nostr";

export const Route = createFileRoute("/_app/audit")({
  validateSearch: (s: Record<string, unknown>): AuditQuery => ({
    actor: typeof s.actor === "string" && s.actor ? s.actor : undefined,
    action: typeof s.action === "string" && s.action ? s.action : undefined,
    target: typeof s.target === "string" && s.target ? s.target : undefined,
  }),
  component: AuditPage,
});

const toneFor = (action: string): Tone =>
  /ban|delete|block|deny|revoke|remove/.test(action) ? "red" : /settings|plugin|role/.test(action) ? "violet" : /login|auth|password|passkey/.test(action) ? "sky" : "gray";

function AuditPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const q = useAudit(search);
  const items = React.useMemo(() => {
    const seen = new Set<number>();
    return (q.data?.pages.flat() ?? []).filter((e) => !seen.has(e.id) && seen.add(e.id));
  }, [q.data]);
  const [draft, setDraft] = React.useState(search);
  React.useEffect(() => setDraft(search), [search]);
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const actor = draft.actor?.trim();
    navigate({
      search: {
        actor: actor ? (parsePubkey(actor) ?? actor) : undefined,
        action: draft.action?.trim() || undefined,
        target: draft.target?.trim() || undefined,
      },
    });
  };
  const hasFilter = !!(search.actor || search.action || search.target);
  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" description="Every administrative action, newest first" />
      <form onSubmit={apply} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <Input placeholder="Actor (npub, hex, system, plugin:…)" value={draft.actor ?? ""} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} />
        <Input placeholder="Action (e.g. user.ban)" value={draft.action ?? ""} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
        <Input placeholder="Target" value={draft.target ?? ""} onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">Filter</Button>
          {hasFilter && (
            <Button type="button" variant="ghost" size="icon" onClick={() => navigate({ search: {} })} aria-label="Clear filters">
              <X />
            </Button>
          )}
        </div>
      </form>
      <PullToRefresh onRefresh={() => q.refetch()}>
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !items.length ? (
          <EmptyState icon={ScrollText} title="No audit entries" />
        ) : (
          <Card className="gap-0 py-0">
            {items.map((e) => (
              <AuditRow key={e.id} e={e} onFilter={(p) => navigate({ search: (prev: AuditQuery) => ({ ...prev, ...p }) })} />
            ))}
          </Card>
        )}
        <InfiniteSentinel hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} paused={q.isFetchNextPageError} onVisible={() => q.fetchNextPage()} />
      </PullToRefresh>
    </div>
  );
}

function AuditRow({ e, onFilter }: { e: AuditView; onFilter: (p: AuditQuery) => void }) {
  const [open, setOpen] = React.useState(false);
  const hasDetails = e.details && Object.keys(e.details).length > 0;
  return (
    <div className="border-b p-3 last:border-0 sm:px-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 sm:w-56">
          {isHex64(e.actor) ? <UserChip pubkey={e.actor} size={28} /> : <span className="font-mono text-sm">{e.actor}</span>}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <button onClick={() => onFilter({ action: e.action })}>
            <ToneBadge t={toneFor(e.action)} className="font-mono">
              {e.action}
            </ToneBadge>
          </button>
          {e.target && (
            <button onClick={() => onFilter({ target: e.target! })} className="max-w-full truncate font-mono text-xs text-muted-foreground hover:text-foreground">
              {e.target.length > 40 ? `${e.target.slice(0, 16)}…${e.target.slice(-8)}` : e.target}
            </button>
          )}
          {hasDetails && (
            <button onClick={() => setOpen((o) => !o)} className="text-xs text-primary hover:underline">
              {open ? "hide details" : "details"}
            </button>
          )}
        </div>
        <div className="shrink-0 text-xs text-muted-foreground sm:text-right" title={formatDate(e.at)}>
          {timeAgo(e.at)}
          {e.ip && <span className="ml-2 font-mono">{e.ip}</span>}
        </div>
      </div>
      {open && hasDetails && <JsonView value={e.details} className="mt-2" />}
    </div>
  );
}
