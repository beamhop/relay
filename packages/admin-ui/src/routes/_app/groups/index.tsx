import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Lock, Search, UsersRound } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { ToneBadge } from "@/components/badges";
import { useGroups } from "@/queries/misc";
import { formatNumber, timeAgo } from "@/lib/format";
import { GroupAvatar } from "@/components/group-avatar";

export const Route = createFileRoute("/_app/groups/")({ component: GroupsPage });

function GroupsPage() {
  const { data, isLoading, error, refetch } = useGroups();
  const [q, setQ] = React.useState("");
  const items = (data ?? [])
    .filter((g) => !q || `${g.name} ${g.id} ${g.about}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.members - a.members);
  return (
    <div className="space-y-4">
      <PageHeader title="Groups" description={data ? `${formatNumber(data.length)} NIP-29 groups hosted on this relay` : "NIP-29 relay-based groups"} />
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search groups…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <PullToRefresh onRefresh={() => refetch()}>
        {isLoading ? (
          <ListSkeleton />
        ) : error ? (
          <ErrorState error={error} retry={() => refetch()} />
        ) : !items.length ? (
          <EmptyState icon={UsersRound} title="No groups" description={q ? "No group matches your search." : "Groups created by users will appear here."} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((g) => (
              <Link key={g.id} to="/groups/$id" params={{ id: g.id }}>
                <Card className="h-full gap-3 p-4 transition-colors hover:bg-muted/40">
                  <div className="flex items-center gap-3">
                    <GroupAvatar picture={g.picture} name={g.name || g.id} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{g.name || g.id}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{g.id}</p>
                    </div>
                  </div>
                  {g.about && <p className="line-clamp-2 text-sm text-muted-foreground">{g.about}</p>}
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {g.private && (
                      <ToneBadge t="violet">
                        <Lock className="size-3" /> private
                      </ToneBadge>
                    )}
                    {g.closed && <ToneBadge t="amber">closed</ToneBadge>}
                    <span>{formatNumber(g.members)} members</span>
                    <span className="ml-auto">{timeAgo(g.createdAt)}</span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </PullToRefresh>
    </div>
  );
}
