import * as React from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Ban, CheckCircle2, Filter, MoreHorizontal, Plus, Search, ShieldCheck, Tag, Trash2, UserX, Users, VolumeX, X } from "lucide-react";
import type { AdminRole, BulkUserRequest, UserStatus, UserView } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { UserChip } from "@/components/user-chip";
import { RoleBadge, ToneBadge, UserStatusBadge } from "@/components/badges";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { SelectionBar } from "@/components/selection-bar";
import { SwipeRow } from "@/components/swipe-row";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { PluginUserActionItems, useBanFlow } from "@/components/user-actions";
import { useUsers } from "@/queries/users";
import { useCan } from "@/queries/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatNumber, timeAgo } from "@/lib/format";
import { parsePubkey } from "@/lib/nostr";

interface UsersSearch { search?: string; status?: UserStatus; role?: AdminRole; tag?: string; allowed?: boolean; sort?: "lastSeen" | "firstSeen" | "eventCount" }
const STATUSES: UserStatus[] = ["active", "banned", "muted"];
const ROLES: AdminRole[] = ["owner", "admin", "moderator", "viewer"];
const SORTS = { lastSeen: "Last seen", firstSeen: "First seen", eventCount: "Event count" } as const;

export const Route = createFileRoute("/_app/users/")({
  validateSearch: (s: Record<string, unknown>): UsersSearch => ({
    search: typeof s.search === "string" && s.search ? s.search : undefined,
    status: STATUSES.includes(s.status as UserStatus) ? (s.status as UserStatus) : undefined,
    role: ROLES.includes(s.role as AdminRole) ? (s.role as AdminRole) : undefined,
    tag: typeof s.tag === "string" && s.tag ? s.tag : undefined,
    allowed: s.allowed === true || s.allowed === "true" ? true : s.allowed === false || s.allowed === "false" ? false : undefined,
    sort: typeof s.sort === "string" && s.sort in SORTS ? (s.sort as UsersSearch["sort"]) : undefined,
  }),
  component: UsersPage,
});

function UsersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/users/" });
  const setSearch = (patch: Partial<UsersSearch>) => navigate({ search: (prev: UsersSearch) => ({ ...prev, ...patch }), replace: true });
  const [draft, setDraft] = React.useState(search.search ?? "");
  React.useEffect(() => setDraft(search.search ?? ""), [search.search]);
  React.useEffect(() => {
    const t = setTimeout(() => {
      if ((draft || undefined) !== search.search) setSearch({ search: draft || undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const q = useUsers(search);
  const items = React.useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total;
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [adding, setAdding] = React.useState(false);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const mobile = useIsMobile();
  const can = useCan();
  const flow = useBanFlow();

  const toggle = (pk: string, v: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (v) n.add(pk);
      else n.delete(pk);
      return n;
    });
  const allSelected = items.length > 0 && items.every((u) => selected.has(u.pubkey));

  const runBulk = async (action: BulkUserRequest["action"], destructive = false) => {
    const pubkeys = [...selected];
    let reason: string | undefined;
    let tag: string | undefined;
    if (action === "add-tag" || action === "remove-tag") {
      const r = await flow.confirm({ title: action === "add-tag" ? "Add tag" : "Remove tag", description: `${pubkeys.length} user(s)`, input: { label: "Tag", placeholder: "e.g. vip" }, confirmText: "Apply" });
      if (!r || !r.input.trim()) return;
      tag = r.input.trim();
    } else if (destructive) {
      const r = await flow.confirm({
        title: action === "delete-events" ? `Delete all events of ${pubkeys.length} user(s)?` : `${action[0].toUpperCase()}${action.slice(1)} ${pubkeys.length} user(s)?`,
        destructive: true,
        confirmText: "Confirm",
        input: action === "ban" ? { label: "Reason (optional)" } : undefined,
      });
      if (!r) return;
      reason = r.input || undefined;
    }
    await flow.bulk.mutateAsync({ pubkeys, action, reason, tag });
    setSelected(new Set());
  };

  const activeFilters = [search.status, search.role, search.tag, search.allowed].filter((v) => v !== undefined).length;
  const filters = (
    <div className="grid gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center">
      <FilterSelect label="Status" value={search.status} options={STATUSES.map((s) => [s, s])} onChange={(v) => setSearch({ status: v as UserStatus | undefined })} />
      <FilterSelect label="Role" value={search.role} options={ROLES.map((s) => [s, s])} onChange={(v) => setSearch({ role: v as AdminRole | undefined })} />
      <FilterSelect
        label="Allow-list"
        value={search.allowed === undefined ? undefined : String(search.allowed)}
        options={[["true", "Allowed"], ["false", "Not allowed"]]}
        onChange={(v) => setSearch({ allowed: v === undefined ? undefined : v === "true" })}
      />
      <FilterSelect label="Sort" value={search.sort} options={Object.entries(SORTS)} onChange={(v) => setSearch({ sort: v as UsersSearch["sort"] })} placeholder="Last seen" />
      <Input className="lg:w-36" placeholder="Tag" defaultValue={search.tag} key={search.tag} onBlur={(e) => setSearch({ tag: e.target.value.trim() || undefined })} onKeyDown={(e) => e.key === "Enter" && setSearch({ tag: e.currentTarget.value.trim() || undefined })} />
      {activeFilters > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setSearch({ status: undefined, role: undefined, tag: undefined, allowed: undefined })}>
          <X /> Clear
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Users"
        description={total !== undefined ? `${formatNumber(total)} users` : "Everyone who has interacted with the relay"}
        actions={
          can("users.edit") && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add user
            </Button>
          )
        }
      />
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search npub, hex, name, nip05, notes…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </div>
        {mobile && (
          <Button variant="outline" size="icon" onClick={() => setFiltersOpen(true)} aria-label="Filters" className="relative">
            <Filter />
            {activeFilters > 0 && <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">{activeFilters}</span>}
          </Button>
        )}
      </div>
      {!mobile && filters}
      <ResponsiveDialog open={mobile && filtersOpen} onOpenChange={setFiltersOpen} title="Filters">
        <div className="pb-6">{filters}</div>
      </ResponsiveDialog>

      <PullToRefresh onRefresh={() => q.refetch()}>
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !items.length ? (
          <EmptyState icon={Users} title="No users found" description="Try a different search or clear the filters." />
        ) : mobile ? (
          <div className="space-y-2">
            {items.map((u) => (
              <SwipeRow
                key={u.pubkey}
                disabled={!can("users.ban") || u.role === "owner"}
                left={u.status !== "banned" ? { label: "Ban", icon: Ban, className: "bg-red-600 text-white", onTrigger: () => flow.banWithConfirm(u.pubkey, u.profile) } : undefined}
                right={
                  u.status === "banned"
                    ? { label: "Unban", icon: CheckCircle2, className: "bg-emerald-600 text-white", onTrigger: () => flow.unban.mutateAsync(u.pubkey) }
                    : !u.allowed
                      ? { label: "Allow", icon: ShieldCheck, className: "bg-emerald-600 text-white", onTrigger: () => flow.patch.mutateAsync({ pubkey: u.pubkey, allowed: true }) }
                      : undefined
                }
              >
                <UserCardRow u={u} selected={selected.has(u.pubkey)} onSelect={(v) => toggle(u.pubkey, v)} selecting={selected.size > 0} />
              </SwipeRow>
            ))}
          </div>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox checked={allSelected} onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((u) => u.pubkey)) : new Set())} aria-label="Select all" />
                  </TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead className="text-right">Last seen</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((u) => (
                  <TableRow key={u.pubkey} data-state={selected.has(u.pubkey) ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox checked={selected.has(u.pubkey)} onCheckedChange={(v) => toggle(u.pubkey, v === true)} aria-label="Select" />
                    </TableCell>
                    <TableCell className="max-w-72">
                      <UserChip pubkey={u.pubkey} profile={u.profile} />
                    </TableCell>
                    <TableCell>
                      <StatusBadges u={u} />
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-56 flex-wrap gap-1">
                        {u.tags.map((t) => (
                          <Badge key={t} variant="secondary" className="cursor-pointer font-normal" onClick={() => setSearch({ tag: t })}>
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(u.eventCount)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{timeAgo(u.lastSeenAt)}</TableCell>
                    <TableCell>
                      <RowMenu u={u} flow={flow} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
        <InfiniteSentinel hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onVisible={() => q.fetchNextPage()} />
      </PullToRefresh>

      <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        {can("users.ban") && (
          <>
            <Button size="sm" variant="ghost" className="rounded-full text-destructive" onClick={() => runBulk("ban", true)}><Ban /> Ban</Button>
            <Button size="sm" variant="ghost" className="rounded-full" onClick={() => runBulk("unban")}><CheckCircle2 /> Unban</Button>
            <Button size="sm" variant="ghost" className="rounded-full" onClick={() => runBulk("mute")}><VolumeX /> Mute</Button>
          </>
        )}
        {can("users.edit") && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="rounded-full"><MoreHorizontal /> More</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuItem onSelect={() => runBulk("allow")}><ShieldCheck /> Allow</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runBulk("disallow")}>Remove from allow-list</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runBulk("deny", true)}><UserX /> Deny</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runBulk("undeny")}>Remove from deny-list</DropdownMenuItem>
              {can("users.ban") && <DropdownMenuItem onSelect={() => runBulk("unmute")}>Unmute</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => runBulk("add-tag")}><Tag /> Add tag…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runBulk("remove-tag")}>Remove tag…</DropdownMenuItem>
              {can("content.delete") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => runBulk("delete-events", true)}><Trash2 /> Delete events</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </SelectionBar>
      <AddUserDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function FilterSelect({ label, value, options, onChange, placeholder }: { label: string; value?: string; options: [string, string][]; onChange: (v: string | undefined) => void; placeholder?: string }) {
  return (
    <div className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:gap-0">
      <Label className="text-xs text-muted-foreground lg:sr-only">{label}</Label>
      <Select value={value ?? "__all"} onValueChange={(v) => onChange(v === "__all" ? undefined : v)}>
        <SelectTrigger className="w-full lg:w-40" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">{placeholder ?? `Any ${label.toLowerCase()}`}</SelectItem>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v} className="capitalize">
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function StatusBadges({ u }: { u: UserView }) {
  return (
    <div className="flex flex-wrap gap-1">
      <UserStatusBadge status={u.status} />
      {u.role && <RoleBadge role={u.role} />}
      {u.allowed && <ToneBadge t="green">allowed</ToneBadge>}
      {u.denied && <ToneBadge t="red">denied</ToneBadge>}
    </div>
  );
}

function UserCardRow({ u, selected, onSelect, selecting }: { u: UserView; selected: boolean; onSelect: (v: boolean) => void; selecting: boolean }) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border bg-card p-3 ${selected ? "border-primary/60 bg-primary/5" : ""}`}>
      {selecting && <Checkbox checked={selected} onCheckedChange={(v) => onSelect(v === true)} aria-label="Select" />}
      <Link
        to="/users/$pubkey"
        params={{ pubkey: u.pubkey }}
        className="min-w-0 flex-1"
        onClick={(e) => {
          if (selecting) {
            e.preventDefault();
            onSelect(!selected);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onSelect(!selected);
        }}
      >
        <UserChip pubkey={u.pubkey} profile={u.profile} link={false} size={40} />
        <div className="mt-2 flex flex-wrap items-center gap-1 pl-[50px]">
          <StatusBadges u={u} />
          <span className="ml-auto text-xs text-muted-foreground">
            {formatNumber(u.eventCount)} events · {timeAgo(u.lastSeenAt)}
          </span>
        </div>
      </Link>
    </div>
  );
}

function RowMenu({ u, flow }: { u: UserView; flow: ReturnType<typeof useBanFlow> }) {
  const can = useCan();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Actions">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link to="/users/$pubkey" params={{ pubkey: u.pubkey }}>Open</Link>
        </DropdownMenuItem>
        {can("users.edit") && (
          <DropdownMenuItem onSelect={() => flow.patch.mutate({ pubkey: u.pubkey, allowed: !u.allowed })}>{u.allowed ? "Remove from allow-list" : "Allow"}</DropdownMenuItem>
        )}
        {can("users.ban") && u.role !== "owner" && (
          <>
            <DropdownMenuSeparator />
            {u.status === "muted" ? (
              <DropdownMenuItem onSelect={() => flow.unmute.mutate(u.pubkey)}>Unmute</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => flow.mute.mutate(u.pubkey)}>Mute</DropdownMenuItem>
            )}
            {u.status === "banned" ? (
              <DropdownMenuItem onSelect={() => flow.unban.mutate(u.pubkey)}>Unban</DropdownMenuItem>
            ) : (
              <DropdownMenuItem variant="destructive" onSelect={() => flow.banWithConfirm(u.pubkey, u.profile)}>
                Ban…
              </DropdownMenuItem>
            )}
          </>
        )}
        <PluginUserActionItems pubkey={u.pubkey} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { add } = useBanFlow();
  const [input, setInput] = React.useState("");
  const [allowed, setAllowed] = React.useState(true);
  const [notes, setNotes] = React.useState("");
  const pubkey = parsePubkey(input.trim());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pubkey) return;
    await add.mutateAsync({ pubkey, allowed, notes: notes || undefined });
    setInput("");
    setNotes("");
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add user"
      description="Add a pubkey manually, e.g. to the allow-list."
      footer={
        <Button type="submit" form="add-user" disabled={!pubkey || add.isPending}>
          Add user
        </Button>
      }
    >
      <form id="add-user" onSubmit={submit} className="space-y-4 pb-2">
        <div className="space-y-2">
          <Label htmlFor="add-pk">npub or hex pubkey</Label>
          <Input id="add-pk" value={input} onChange={(e) => setInput(e.target.value)} placeholder="npub1…" autoFocus aria-invalid={!!input && !pubkey} />
          {!!input && !pubkey && <p className="text-xs text-destructive">Not a valid npub or hex pubkey</p>}
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <Label htmlFor="add-allowed">Allow-listed</Label>
          <Switch id="add-allowed" checked={allowed} onCheckedChange={setAllowed} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="add-notes">Notes</Label>
          <Textarea id="add-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </div>
      </form>
    </ResponsiveDialog>
  );
}
