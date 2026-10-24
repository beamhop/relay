import * as React from "react";
import { tryMutate } from "@/queries/client";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Plus, ShieldBan, Trash2 } from "lucide-react";
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

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const V4 = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}(?:/(?:3[0-2]|[12]?\\d))?$`);
const isIpv6 = (s: string) => {
  const [addr, prefix, ...rest] = s.split("/");
  if (rest.length || (prefix !== undefined && !/^(?:12[0-8]|1[01]\d|[1-9]?\d)$/.test(prefix))) return false;
  try {
    return new URL(`http://[${addr}]/`).hostname.length > 2;
  } catch {
    return false;
  }
};
const IP_RE = { test: (s: string) => V4.test(s) || (s.includes(":") && isIpv6(s)) };

const BIG = [[1e18, "quintillion"], [1e15, "quadrillion"], [1e12, "trillion"], [1e9, "billion"], [1e6, "million"]] as const;
const approx = (n: number) => {
  for (const [v, word] of BIG) if (n >= v) return `about ${(n / v).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${word}`;
  return n.toLocaleString();
};

/** How many addresses a rule covers, in words (an IPv4-mapped IPv6 rule covers IPv4 addresses, as the relay matches it). */
function coverage(cidr: string): string {
  const [addr, prefix] = cidr.split("/");
  let v6 = addr.includes(":");
  let bits = prefix === undefined ? (v6 ? 128 : 32) : Number(prefix);
  if (v6 && /^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/i.test(new URL(`http://[${addr}]/`).hostname)) {
    v6 = false;
    bits -= 96;
  }
  if (bits <= 0) return v6 ? "every IPv6 address on the internet" : "every IPv4 address on the internet (about 4.3 billion)";
  if (!v6) return `${approx(2 ** (32 - bits))} IPv4 addresses`;
  // wide IPv6 ranges count in /64 networks: one is what a single home or server usually gets
  return bits < 64 ? `${approx(2 ** (64 - bits))} IPv6 networks of /64 (each typically one home or server)` : `${approx(2 ** (128 - bits))} IPv6 addresses`;
}

function IpRulesPage() {
  const { data, isLoading, error, refetch } = useIpRules();
  const { remove } = useIpRuleActions();
  const confirm = useConfirm();
  const [adding, setAdding] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const doRemove = async (r: IpRule) => {
    if (!(await confirm({ title: `Remove rule for ${r.cidr}?`, destructive: true, confirmText: "Remove" }))) return false;
    return !!(await tryMutate(remove, r.cidr));
  };
  const items = (data ?? []).filter((r) => !filter || r.cidr.includes(filter) || r.reason.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-4">
      <PageHeader
        title="IP rules"
        description="Block IP addresses and CIDR ranges, or exempt trusted ones from per-IP limits"
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add rule
          </Button>
        }
      />
      {/* also shown while a filter is set, so it can't stay applied with the box gone (after deleting rules) */}
      {((data?.length ?? 0) > 5 || filter) && <Input placeholder="Filter by IP or reason…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : !items.length && filter ? (
        <EmptyState icon={ShieldBan} title="No matching rules" description={`Nothing matches “${filter}”.`} action={<Button variant="outline" onClick={() => setFilter("")}>Clear filter</Button>} />
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
  const confirm = useConfirm();
  const [cidr, setCidr] = React.useState("");
  const [action, setAction] = React.useState<"block" | "allow">("block");
  const [reason, setReason] = React.useState("");
  const valid = IP_RE.test(cidr.trim());
  /** asked when the API refuses an allow rule wider than an IPv4 /16 or an IPv6 /48 */
  const confirmBroad = async (range: string) =>
    !!(await confirm({
      title: "Allow this whole range?",
      destructive: true,
      confirmText: "Add allow rule anyway",
      description: (
        <div className="space-y-2">
          <p>
            <code className="font-mono">{range}</code> covers {coverage(range)}.
          </p>
          <p>
            An allow rule doesn't decide who may connect: a public relay already accepts everyone. It <em>exempts</em> the addresses it
            matches from the per-IP connection and message limits, and it overrides every block rule.
          </p>
          <p>
            With a range this wide, anyone in it can open as many connections and send as many messages as they like, and you can't block
            them by IP. Only allow addresses you control, such as your own servers or a trusted proxy.
          </p>
        </div>
      ),
    }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const rule = { cidr: cidr.trim(), action, reason };
    // null: the broad-range warning was cancelled, keep the form as it is
    if (!(await tryMutate(add, { ...rule, confirmBroad: () => confirmBroad(rule.cidr) }))?.data) return;
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
          {!!cidr.trim() && !valid && <p className="text-xs text-destructive">Enter a valid IPv4/IPv6 address or CIDR range.</p>}
        </div>
        <div className="space-y-2">
          <Label>Action</Label>
          <ToggleGroup type="single" variant="outline" value={action} onValueChange={(v) => v && setAction(v as "block" | "allow")} className="w-full">
            <ToggleGroupItem value="block" className="flex-1">Block</ToggleGroupItem>
            <ToggleGroupItem value="allow" className="flex-1">Allow</ToggleGroupItem>
          </ToggleGroup>
          {action === "allow" ? (
            <p className="flex gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span>
                Allow rules are exemptions, not a whitelist: matching addresses skip the per-IP limits and override block rules. Everyone can
                already connect, so only allow addresses you trust, like your own servers.
              </span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Matching addresses can't connect (unless an allow rule also matches them).</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="ip-reason">Reason</Label>
          <Input id="ip-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="spam bot" />
        </div>
      </form>
    </ResponsiveDialog>
  );
}
