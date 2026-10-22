import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Ticket, Trash2 } from "lucide-react";
import type { InviteView } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { CopyButton, copyText } from "@/components/copy-button";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { ToneBadge } from "@/components/badges";
import { SwipeRow } from "@/components/swipe-row";
import { UserChip } from "@/components/user-chip";
import { useConfirm } from "@/components/confirm";
import { useInviteActions, useInvites } from "@/queries/misc";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatDate, nowSec, timeAgo } from "@/lib/format";

export const Route = createFileRoute("/_app/invites")({ component: InvitesPage });

function inviteState(i: InviteView): { t: "green" | "gray" | "amber"; label: string } {
  if (i.expiresAt && i.expiresAt < nowSec()) return { t: "gray", label: "expired" };
  if (i.maxUses > 0 && i.uses >= i.maxUses) return { t: "amber", label: "used up" };
  return { t: "green", label: "active" };
}

function InvitesPage() {
  const { data, isLoading, error, refetch } = useInvites();
  const { revoke } = useInviteActions();
  const confirm = useConfirm();
  const mobile = useIsMobile();
  const [creating, setCreating] = React.useState(false);
  const doRevoke = async (code: string) => {
    if (!(await confirm({ title: "Revoke invite?", description: "The link will stop working immediately.", destructive: true, confirmText: "Revoke" }))) return false;
    await revoke.mutateAsync(code);
  };
  const items = [...(data ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Invites"
        description="Invite links let new users join when access mode is invite-only"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> Create invites
          </Button>
        }
      />
      {isLoading ? (
        <ListSkeleton rows={4} />
      ) : error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : !items.length ? (
        <EmptyState icon={Ticket} title="No invites yet" action={<Button onClick={() => setCreating(true)}>Create invites</Button>} />
      ) : mobile ? (
        <div className="space-y-2">
          {items.map((i) => {
            const st = inviteState(i);
            return (
              <SwipeRow key={i.code} left={{ label: "Revoke", icon: Trash2, className: "bg-red-600 text-white", onTrigger: () => doRevoke(i.code) }}>
                <div className="space-y-2 rounded-xl border bg-card p-3" onClick={() => copyText(i.url, "Invite link copied")}>
                  <div className="flex items-center gap-2">
                    <code className="truncate font-mono text-sm">{i.code}</code>
                    <ToneBadge t={st.t}>{st.label}</ToneBadge>
                    <span className="ml-auto text-xs text-muted-foreground">{timeAgo(i.createdAt)}</span>
                  </div>
                  {i.note && <p className="text-sm text-muted-foreground">{i.note}</p>}
                  <Uses i={i} />
                </div>
              </SwipeRow>
            );
          })}
        </div>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => {
                const st = inviteState(i);
                return (
                  <TableRow key={i.code}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-sm">{i.code}</code>
                        <ToneBadge t={st.t}>{st.label}</ToneBadge>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">{i.note || "—"}</TableCell>
                    <TableCell className="w-40">
                      <Uses i={i} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{i.expiresAt ? formatDate(i.expiresAt, "PP") : "never"}</TableCell>
                    <TableCell>
                      <UserChip pubkey={i.createdBy} size={24} />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <CopyButton value={i.url} label="Invite link copied" />
                        <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => doRevoke(i.code)} aria-label="Revoke">
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      <CreateInvites open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function Uses({ i }: { i: InviteView }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground tabular-nums">
        {i.uses} / {i.maxUses > 0 ? i.maxUses : "∞"} used
      </div>
      {i.maxUses > 0 && <Progress value={(i.uses / i.maxUses) * 100} className="h-1.5" />}
    </div>
  );
}

function CreateInvites({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { create } = useInviteActions();
  const [count, setCount] = React.useState("1");
  const [maxUses, setMaxUses] = React.useState("1");
  const [days, setDays] = React.useState("");
  const [note, setNote] = React.useState("");
  const [created, setCreated] = React.useState<InviteView[] | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await create.mutateAsync({
      count: Math.max(1, Math.min(500, Number(count) || 1)),
      maxUses: Number(maxUses) || 0,
      expiresAt: days ? nowSec() + Number(days) * 86400 : null,
      note: note || undefined,
    });
    setCreated(r.items ?? []);
  };
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setTimeout(() => setCreated(null), 300);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={close}
      title={created ? `${created.length} invite(s) created` : "Create invites"}
      description={created ? "Share these links with the people you want to invite." : "Generate one or many invite links at once."}
      footer={
        created ? (
          <>
            <Button variant="outline" onClick={() => copyText(created.map((c) => c.url).join("\n"), "All links copied")}>
              Copy all
            </Button>
            <Button onClick={() => close(false)}>Done</Button>
          </>
        ) : (
          <Button type="submit" form="create-invites" disabled={create.isPending}>
            Create
          </Button>
        )
      }
    >
      {created ? (
        <ul className="space-y-1 pb-2">
          {created.map((c) => (
            <li key={c.code} className="flex items-center gap-2 rounded-md border px-2 py-1">
              <code className="flex-1 truncate text-xs">{c.url}</code>
              <CopyButton value={c.url} />
            </li>
          ))}
        </ul>
      ) : (
        <form id="create-invites" onSubmit={submit} className="grid gap-4 pb-2 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="inv-count">How many</Label>
            <Input id="inv-count" type="number" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inv-uses">Uses each</Label>
            <Input id="inv-uses" type="number" min={0} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            <p className="text-xs text-muted-foreground">0 = unlimited</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="inv-days">Expires in (days)</Label>
            <Input id="inv-days" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} placeholder="never" />
          </div>
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="inv-note">Note</Label>
            <Input id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. conference attendees" />
          </div>
        </form>
      )}
    </ResponsiveDialog>
  );
}
