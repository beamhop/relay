import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Shield, UserPlus } from "lucide-react";
import { ROLE_PERMISSIONS, type AdminRole } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { UserChip } from "@/components/user-chip";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { useConfirm } from "@/components/confirm";
import { useAdmins, useUserActions } from "@/queries/users";
import { useMe } from "@/queries/auth";
import { parsePubkey } from "@/lib/nostr";
import { timeAgo } from "@/lib/format";

export const Route = createFileRoute("/_app/admins")({ component: AdminsPage });

const ROLES: AdminRole[] = ["owner", "admin", "moderator", "viewer"];
const ROLE_DESC: Record<AdminRole, string> = {
  owner: "Full control including admin management",
  admin: "Everything except managing admins",
  moderator: "Users, content, reports and media moderation",
  viewer: "Read-only access",
};

function AdminsPage() {
  const { data, isLoading, error, refetch } = useAdmins();
  const { data: me } = useMe();
  const { setRole } = useUserActions();
  const confirm = useConfirm();
  const [adding, setAdding] = React.useState(false);

  const change = async (pubkey: string, v: string) => {
    const role = v === "none" ? null : (v as AdminRole);
    if (!role && !(await confirm({ title: "Remove admin access?", destructive: true, confirmText: "Remove" }))) return;
    setRole.mutate({ pubkey, role });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Admins"
        description="People with access to this panel and their roles"
        actions={
          <Button onClick={() => setAdding(true)}>
            <UserPlus /> Add admin
          </Button>
        }
      />
      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : !data?.length ? (
        <EmptyState icon={Shield} title="No admins" />
      ) : (
        <Card className="gap-0 py-0">
          {data.map((u) => (
            <div key={u.pubkey} className="flex flex-col gap-3 border-b p-4 last:border-0 sm:flex-row sm:items-center">
              <UserChip pubkey={u.pubkey} profile={u.profile} className="flex-1" sub={`last seen ${timeAgo(u.lastSeenAt)}`} />
              <Select value={u.role ?? "none"} onValueChange={(v) => change(u.pubkey, v)} disabled={u.pubkey === me?.pubkey}>
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r} className="capitalize">
                      {r}
                    </SelectItem>
                  ))}
                  <SelectItem value="none">Remove access</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Role permissions</CardTitle>
          <CardDescription>What each role is allowed to do</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {ROLES.map((r) => (
            <div key={r} className="space-y-2 rounded-lg border p-3">
              <div>
                <p className="font-medium capitalize">{r}</p>
                <p className="text-xs text-muted-foreground">{ROLE_DESC[r]}</p>
              </div>
              <div className="flex flex-wrap gap-1">
                {ROLE_PERMISSIONS[r].map((p) => (
                  <Badge key={p} variant="secondary" className="font-mono text-[11px] font-normal">
                    {p}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <AddAdmin open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function AddAdmin({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { setRole } = useUserActions();
  const [input, setInput] = React.useState("");
  const [role, setR] = React.useState<AdminRole>("moderator");
  const pubkey = parsePubkey(input.trim());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pubkey) return;
    await setRole.mutateAsync({ pubkey, role });
    setInput("");
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add admin"
      description="Grant a pubkey access to the admin panel."
      footer={
        <Button type="submit" form="add-admin" disabled={!pubkey || setRole.isPending}>
          Grant access
        </Button>
      }
    >
      <form id="add-admin" onSubmit={submit} className="space-y-4 pb-2">
        <div className="space-y-2">
          <Label htmlFor="adm-pk">npub or hex pubkey</Label>
          <Input id="adm-pk" value={input} onChange={(e) => setInput(e.target.value)} placeholder="npub1…" aria-invalid={!!input && !pubkey} />
        </div>
        <div className="space-y-2">
          <Label>Role</Label>
          <Select value={role} onValueChange={(v) => setR(v as AdminRole)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  <span className="capitalize">{r}</span> <span className="text-muted-foreground">— {ROLE_DESC[r]}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          They sign in with their Nostr key. You can also manage roles from a <Link to="/users" className="underline">user's page</Link>.
        </p>
      </form>
    </ResponsiveDialog>
  );
}
