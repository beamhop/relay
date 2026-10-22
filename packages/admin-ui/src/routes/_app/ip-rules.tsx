import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, ShieldBan, Trash2 } from "lucide-react";
import type { IpRule } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { ToneBadge } from "@/components/badges";
import { SwipeRow } from "@/components/swipe-row";
import { useConfirm } from "@/components/confirm";
import { useIpRuleActions, useIpRules } from "@/queries/misc";
import { timeAgo } from "@/lib/format";

export const Route = createFileRoute("/_app/ip-rules")({ component: IpRulesPage });

const IP_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:3[0-2]|[12]?\d))?|[0-9a-fA-F:]*:[0-9a-fA-F:.]*(?:\/(?:12[0-8]|1[01]\d|\d{1,2}))?)$/;

function IpRulesPage() {
  const { data, isLoading, error, refetch } = useIpRules();
  const { remove } = useIpRuleActions();
  const confirm = useConfirm();
  const [adding, setAdding] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const doRemove = async (r: IpRule) => {
    if (!(await confirm({ title: `Remove rule for ${r.cidr}?`, destructive: true, confirmText: "Remove" }))) return false;
    await remove.mutateAsync(r.cidr);
  };
  const items = (data ?? []).filter((r) => !filter || r.cidr.includes(filter) || r.reason.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-4">
      <PageHeader
        title="IP rules"
        description="Block or always-allow IP addresses and CIDR ranges"
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add rule
          </Button>
        }
      />
      {(data?.length ?? 0) > 5 && <Input placeholder="Filter by IP or reason…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : !items.length ? (
        <EmptyState icon={ShieldBan} title="No IP rules" description="Connections from all IPs are subject to normal policies." />
      ) : (
        <Card className="gap-0 py-0">
          {items.map((r) => (
            <SwipeRow key={r.cidr} className="border-b last:border-0" left={{ label: "Remove", icon: Trash2, className: "bg-red-600 text-white", onTrigger: () => doRemove(r) }}>
              <div className="flex items-center gap-3 bg-card p-4">
                <ToneBadge t={r.action === "block" ? "red" : "green"}>{r.action}</ToneBadge>
                <div className="min-w-0 flex-1">
                  <code className="font-mono text-sm">{r.cidr}</code>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.reason || "no reason"} · {timeAgo(r.createdAt)}
                  </p>
                </div>
                <Button variant="ghost" size="icon-sm" className="hidden text-destructive md:inline-flex" onClick={() => doRemove(r)} aria-label="Remove">
                  <Trash2 />
                </Button>
              </div>
            </SwipeRow>
          ))}
        </Card>
      )}
      <AddRule open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function AddRule({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { add } = useIpRuleActions();
  const [cidr, setCidr] = React.useState("");
  const [action, setAction] = React.useState<"block" | "allow">("block");
  const [reason, setReason] = React.useState("");
  const valid = IP_RE.test(cidr.trim());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    await add.mutateAsync({ cidr: cidr.trim(), action, reason });
    setCidr("");
    setReason("");
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add IP rule"
      footer={
        <Button type="submit" form="add-ip" disabled={!valid || add.isPending}>
          Add rule
        </Button>
      }
    >
      <form id="add-ip" onSubmit={submit} className="space-y-4 pb-2">
        <div className="space-y-2">
          <Label htmlFor="ip-cidr">IP or CIDR</Label>
          <Input id="ip-cidr" value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="203.0.113.0/24 or 2001:db8::/32" aria-invalid={!!cidr && !valid} autoCapitalize="off" />
        </div>
        <div className="space-y-2">
          <Label>Action</Label>
          <ToggleGroup type="single" variant="outline" value={action} onValueChange={(v) => v && setAction(v as "block" | "allow")} className="w-full">
            <ToggleGroupItem value="block" className="flex-1">Block</ToggleGroupItem>
            <ToggleGroupItem value="allow" className="flex-1">Allow</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="space-y-2">
          <Label htmlFor="ip-reason">Reason</Label>
          <Input id="ip-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="spam bot" />
        </div>
      </form>
    </ResponsiveDialog>
  );
}
