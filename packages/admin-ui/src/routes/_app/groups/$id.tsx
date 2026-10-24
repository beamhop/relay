import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { tryMutate } from "@/queries/client";
import { ArrowLeft, Lock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { UserChip } from "@/components/user-chip";
import { ToneBadge } from "@/components/badges";
import { CopyButton } from "@/components/copy-button";
import { ErrorState } from "@/components/empty-state";
import { useConfirm } from "@/components/confirm";
import { useDeleteGroup, useGroup } from "@/queries/misc";
import { useCan } from "@/queries/auth";
import { formatDate, formatNumber } from "@/lib/format";
import { GroupAvatar } from "@/components/group-avatar";

export const Route = createFileRoute("/_app/groups/$id")({ component: GroupPage });

function GroupPage() {
  const { id } = Route.useParams();
  const { data: g, isLoading, error, refetch } = useGroup(id);
  const del = useDeleteGroup();
  const confirm = useConfirm();
  const can = useCan();
  const navigate = useNavigate();
  const remove = async () => {
    const r = await confirm({
      title: `Delete group “${g?.name || id}”?`,
      description: "The group metadata, membership and all group events will be removed from this relay.",
      destructive: true,
      confirmText: "Delete group",
    });
    if (!r) return;
    if (await tryMutate(del, id)) navigate({ to: "/groups" });
  };
  const members = g?.memberList ?? [];
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/groups">
          <ArrowLeft /> Groups
        </Link>
      </Button>
      {isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : error || !g ? (
        <ErrorState error={error ?? "Group not found"} retry={() => refetch()} />
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <GroupAvatar picture={g.picture} name={g.name || g.id} size={72} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-semibold">{g.name || g.id}</h1>
                  {g.private && (
                    <ToneBadge t="violet">
                      <Lock className="size-3" /> private
                    </ToneBadge>
                  )}
                  {g.closed && <ToneBadge t="amber">closed</ToneBadge>}
                </div>
                <div className="flex items-center gap-1">
                  <code className="text-xs text-muted-foreground">{g.id}</code>
                  <CopyButton value={g.id} size="icon-xs" />
                </div>
                {g.about && <p className="pt-1 text-sm whitespace-pre-wrap">{g.about}</p>}
                <p className="pt-1 text-xs text-muted-foreground">
                  {formatNumber(g.members)} members · created {formatDate(g.createdAt)}
                </p>
              </div>
              {can("groups.manage") && (
                <Button variant="destructive" onClick={remove} disabled={del.isPending}>
                  <Trash2 /> Delete group
                </Button>
              )}
            </CardContent>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Admins ({g.admins.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {g.admins.length ? g.admins.map((pk) => <UserChip key={pk} pubkey={pk} />) : <p className="text-sm text-muted-foreground">No admins</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Members ({formatNumber(members.length || g.members)})</CardTitle>
              </CardHeader>
              <CardContent className="max-h-[60dvh] space-y-3 overflow-y-auto">
                {members.length ? (
                  members.map((m) => (
                    <div key={m.pubkey} className="flex items-center gap-2">
                      <UserChip pubkey={m.pubkey} className="flex-1" />
                      {m.roles.map((r) => (
                        <Badge key={r} variant="secondary" className="font-normal">
                          {r}
                        </Badge>
                      ))}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">Member list not available.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
