import * as React from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Ban, CheckCircle2, ExternalLink, FileText, Image as ImageIcon, MoreHorizontal, Save, Trash2, VolumeX, Volume2 } from "lucide-react";
import type { AdminRole, MediaItem, UserDetail, UserPatch } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/user-avatar";
import { CopyButton } from "@/components/copy-button";
import { RoleBadge, ToneBadge, UserStatusBadge, BlobStatusBadge } from "@/components/badges";
import { ListInput } from "@/components/list-input";
import { EventCard } from "@/components/event-card";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { PluginUserActionItems, useBanFlow } from "@/components/user-actions";
import { useUser, useUserEvents } from "@/queries/users";
import { useMedia, useDeleteEvents } from "@/queries/content";
import { useCan, useMe } from "@/queries/auth";
import { formatBytes, formatDate, formatNumber, timeAgo } from "@/lib/format";
import { mediaUrl } from "@/lib/api";
import { displayName, kindName, parsePubkey, toNpub } from "@/lib/nostr";
import { safeUrl } from "@/lib/utils";
import { autoMediaSrc } from "@/lib/media-policy";
import { useMediaPolicy } from "@/lib/prefs";
import { useConfirm } from "@/components/confirm";

export const Route = createFileRoute("/_app/users/$pubkey")({
  component: UserPage,
});

function UserPage() {
  const { pubkey: raw } = Route.useParams();
  const pubkey = parsePubkey(raw) ?? raw;
  const { data: u, isLoading, error, refetch } = useUser(pubkey);
  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <ListSkeleton rows={3} />
      </div>
    );
  if (error || !u) return <ErrorState error={error ?? "User not found"} retry={() => refetch()} />;
  return <UserView u={u} />;
}

function UserView({ u }: { u: UserDetail }) {
  const can = useCan();
  const flow = useBanFlow();
  const navigate = useNavigate();
  const npub = toNpub(u.pubkey);
  const name = displayName(u.pubkey, u.profile);
  const protectedUser = u.role === "owner";
  const banner = autoMediaSrc(u.profile?.banner, useMediaPolicy());
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/users">
          <ArrowLeft /> Users
        </Link>
      </Button>

      <Card className="overflow-hidden pt-0">
        <div
          className="h-28 bg-gradient-to-br from-primary/30 via-primary/10 to-transparent bg-cover bg-center sm:h-40"
          style={banner ? { backgroundImage: `url(${JSON.stringify(banner)})` } : undefined}
        />
        <CardContent className="-mt-12 space-y-3 sm:-mt-14">
          <div className="flex flex-wrap items-end gap-3">
            <UserAvatar pubkey={u.pubkey} profile={u.profile} size={88} className="ring-4 ring-card" />
            <div className="ml-auto flex flex-wrap gap-2">
              {can("users.ban") && !protectedUser && (
                // fieldset: one moderation action at a time (no double submit)
                <fieldset disabled={flow.ban.isPending || flow.unban.isPending || flow.mute.isPending || flow.unmute.isPending} className="contents">
                  {u.status === "banned" ? (
                    <Button variant="outline" onClick={() => flow.unban.mutate(u.pubkey)}>
                      <CheckCircle2 /> Unban
                    </Button>
                  ) : (
                    <Button variant="destructive" onClick={() => flow.banWithConfirm(u.pubkey, u.profile)}>
                      <Ban /> Ban
                    </Button>
                  )}
                  {u.status === "muted" ? (
                    <Button variant="outline" onClick={() => flow.unmute.mutate(u.pubkey)}>
                      <Volume2 /> Unmute
                    </Button>
                  ) : (
                    u.status !== "banned" && (
                      <Button variant="outline" onClick={() => flow.mute.mutate(u.pubkey)}>
                        <VolumeX /> Mute
                      </Button>
                    )
                  )}
                </fieldset>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link to="/content" search={{ f: JSON.stringify({ authors: [u.pubkey] }) }}>
                      <FileText /> Browse events
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={`https://njump.me/${npub}`} target="_blank" rel="noreferrer">
                      <ExternalLink /> Open on njump
                    </a>
                  </DropdownMenuItem>
                  <PluginUserActionItems pubkey={u.pubkey} />
                  {can("users.delete") && !protectedUser && (!u.role || can("admins.manage")) && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={async () => {
                          if (await flow.deleteWithConfirm(u.pubkey, u.profile)) navigate({ to: "/users" });
                        }}
                      >
                        <Trash2 /> Delete user
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{name}</h1>
              <UserStatusBadge status={u.status} />
              {u.role && <RoleBadge role={u.role} />}
              {u.allowed && <ToneBadge t="green">allowed</ToneBadge>}
              {u.denied && <ToneBadge t="red">denied</ToneBadge>}
            </div>
            {u.profile?.nip05 && <p className="text-sm text-muted-foreground">{u.profile.nip05}</p>}
            <div className="flex min-w-0 items-center gap-1">
              <code className="truncate text-xs text-muted-foreground">{npub}</code>
              <CopyButton value={npub} label="npub" />
              <CopyButton value={u.pubkey} label="hex pubkey" size="icon-xs" />
            </div>
            {u.banReason && u.status === "banned" && <p className="text-sm text-destructive">Ban reason: {u.banReason}</p>}
            {u.profile?.about && <p className="line-clamp-4 max-w-2xl pt-1 text-sm whitespace-pre-wrap">{u.profile.about}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Events" value={formatNumber(u.stats.eventCount)} />
            <Stat label="Media" value={`${formatNumber(u.stats.blobCount)} · ${formatBytes(u.stats.blobBytes)}`} />
            <Stat label="Reports against" value={formatNumber(u.stats.reportsAgainst)} tone={u.stats.reportsAgainst ? "text-destructive" : undefined} />
            <Stat label="Reports filed" value={formatNumber(u.stats.reportsFiled)} />
            <Stat label="First seen" value={timeAgo(u.firstSeenAt)} title={formatDate(u.firstSeenAt)} />
            <Stat label="Last seen" value={timeAgo(u.lastSeenAt)} title={formatDate(u.lastSeenAt)} />
          </div>
          {u.stats.kinds.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {u.stats.kinds.slice(0, 12).map((k) => (
                <span key={k.kind} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                  {kindName(k.kind)} <span className="text-muted-foreground tabular-nums">{formatNumber(k.count)}</span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="manage">
        <TabsList>
          <TabsTrigger value="manage">Manage</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
        </TabsList>
        <TabsContent value="manage" className="grid gap-4 pt-2 lg:grid-cols-2">
          {/* keyed so a save that completes after navigating to another user can't touch that user's form */}
          <EditCard key={u.pubkey} u={u} />
          <div className="space-y-4">
            {can("admins.manage") && <RoleCard u={u} />}
            <InfoCard u={u} />
          </div>
        </TabsContent>
        <TabsContent value="events" className="pt-2">
          <UserEvents pubkey={u.pubkey} />
        </TabsContent>
        <TabsContent value="media" className="pt-2">
          <UserMedia pubkey={u.pubkey} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: React.ReactNode; tone?: string; title?: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2.5" title={title}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`truncate text-sm font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

/** a per-user quota this large never runs out (per-user 0 means no uploads, so "unlimited" needs its own value) */
const UNLIMITED_QUOTA = Number.MAX_SAFE_INTEGER;
/** quota field (MB, "unlimited" or empty) → bytes, null for the relay default, undefined when invalid */
const quotaBytes = (v: string): number | null | undefined => {
  const t = v.trim().toLowerCase();
  if (t === "") return null;
  if (t === "unlimited") return UNLIMITED_QUOTA;
  const mb = Number(t);
  return mb >= 0 ? Math.round(mb * 1024 * 1024) : undefined;
};

type EditFields = Pick<UserDetail, "notes" | "tags" | "allowed" | "denied" | "nip05Name" | "blossomQuota" | "rateLimit">;
const formOf = (u: EditFields) => ({
  notes: u.notes,
  tags: u.tags,
  allowed: u.allowed,
  denied: u.denied,
  nip05Name: u.nip05Name ?? "",
  // empty = the relay default, 0 = no uploads: show small quotas with decimals so they don't read as 0
  quotaMb: u.blossomQuota == null ? "" : u.blossomQuota >= UNLIMITED_QUOTA ? "unlimited" : String(Number((u.blossomQuota / 1024 / 1024).toFixed(2))),
  epm: u.rateLimit?.eventsPerMinute?.toString() ?? "",
  rpm: u.rateLimit?.reqPerMinute?.toString() ?? "",
});

function EditCard({ u }: { u: UserDetail }) {
  const can = useCan();
  const { patch } = useBanFlow();
  const editable = can("users.edit");
  const init = React.useCallback(() => formOf(u), [u]);
  const [f, setF] = React.useState(init);
  // refetches (mute/ban/role changes, window focus) must not wipe unsaved edits: only fields the
  // admin hasn't touched follow the server; a different user resets the form entirely
  const baseline = React.useRef({ pubkey: u.pubkey, values: f });
  React.useEffect(() => {
    const next = init();
    const prev = baseline.current;
    baseline.current = { pubkey: u.pubkey, values: next };
    if (prev.pubkey !== u.pubkey) return setF(next);
    setF((cur) => {
      const merged = { ...cur };
      for (const k of Object.keys(next) as (keyof typeof next)[]) {
        if (JSON.stringify(cur[k]) === JSON.stringify(prev.values[k])) (merged as Record<string, unknown>)[k] = next[k];
      }
      return merged;
    });
  }, [init, u.pubkey]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

  const save = () => {
    const body: UserPatch = {};
    const o = baseline.current.values;
    if (f.notes !== o.notes) body.notes = f.notes;
    if (JSON.stringify(f.tags) !== JSON.stringify(o.tags)) body.tags = f.tags;
    if (f.allowed !== o.allowed) body.allowed = f.allowed;
    if (f.denied !== o.denied) body.denied = f.denied;
    if (f.nip05Name !== o.nip05Name) body.nip05Name = f.nip05Name.trim() || null;
    if (f.quotaMb !== o.quotaMb) body.blossomQuota = quotaBytes(f.quotaMb);
    if (f.epm !== o.epm || f.rpm !== o.rpm) {
      const rl = { eventsPerMinute: num(f.epm), reqPerMinute: num(f.rpm) };
      body.rateLimit = rl.eventsPerMinute === undefined && rl.reqPerMinute === undefined ? null : rl;
    }
    if (!Object.keys(body).length) return;
    patch.mutate(
      { pubkey: u.pubkey, ...body },
      {
        // the server normalises values (trimmed lower-case names, whole MB, plain numbers): show what it
        // stored and make that the new baseline, so the form isn't left dirty with the typed spelling
        onSuccess: (updated) => {
          if (updated.pubkey !== baseline.current.pubkey) return;
          const next = formOf(updated);
          baseline.current = { pubkey: u.pubkey, values: next };
          setF(next);
        },
      },
    );
  };
  const dirty = JSON.stringify(f) !== JSON.stringify(baseline.current.values);
  const invalidNum = [f.epm, f.rpm].some((v) => v.trim() !== "" && !(Number(v) >= 0)) || quotaBytes(f.quotaMb) === undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>Notes, tags, access lists and per-user limits</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={!editable} className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleRow label="Allow-listed" hint="Can write in whitelist mode" checked={f.allowed} onChange={(v) => set("allowed", v)} disabled={!editable} />
            <ToggleRow label="Deny-listed" hint="Always rejected" checked={f.denied} onChange={(v) => set("denied", v)} disabled={!editable} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="u-notes">Notes</Label>
            <Textarea id="u-notes" rows={3} value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Internal notes, visible to admins only" />
          </div>
          <div className="space-y-2">
            <Label>Tags</Label>
            <ListInput value={f.tags} onChange={(v) => set("tags", v)} placeholder="Add tag and press Enter" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="u-nip05">NIP-05 name</Label>
            <Input id="u-nip05" value={f.nip05Name} onChange={(e) => set("nip05Name", e.target.value)} placeholder="alice" />
            <p className="text-xs text-muted-foreground">Served at /.well-known/nostr.json as name@relay-domain</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="u-quota">Media quota (MB)</Label>
              <Input id="u-quota" inputMode="decimal" value={f.quotaMb} onChange={(e) => set("quotaMb", e.target.value)} placeholder="relay default" />
              <p className="text-xs text-muted-foreground">Empty = relay default · 0 = no uploads · "unlimited"</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-epm">Events / min</Label>
              <Input id="u-epm" inputMode="numeric" value={f.epm} onChange={(e) => set("epm", e.target.value)} placeholder="default" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-rpm">REQs / min</Label>
              <Input id="u-rpm" inputMode="numeric" value={f.rpm} onChange={(e) => set("rpm", e.target.value)} placeholder="default" />
            </div>
          </div>
          {editable && (
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button type="button" variant="ghost" onClick={() => setF(baseline.current.values)}>
                  Reset
                </Button>
              )}
              <Button type="button" onClick={save} disabled={!dirty || invalidNum || patch.isPending}>
                <Save /> Save changes
              </Button>
            </div>
          )}
        </fieldset>
      </CardContent>
    </Card>
  );
}

function ToggleRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = React.useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

function RoleCard({ u }: { u: UserDetail }) {
  const { setRole, confirm } = useBanFlow();
  const { data: me } = useMe();
  const self = me?.pubkey === u.pubkey;
  const change = async (v: string) => {
    const role = v === "none" ? null : (v as AdminRole);
    if (role === "owner" || (u.role && !role)) {
      const ok = await confirm({
        title: role === "owner" ? "Grant owner role?" : "Remove admin access?",
        description: role === "owner" ? "Owners have full control, including managing other admins." : "This user will lose access to the admin panel.",
        destructive: true,
      });
      if (!ok) return;
    }
    setRole.mutate({ pubkey: u.pubkey, role });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin role</CardTitle>
        <CardDescription>Grants access to this admin panel</CardDescription>
      </CardHeader>
      <CardContent>
        <Select value={u.role ?? "none"} onValueChange={change} disabled={self || setRole.isPending}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No admin access</SelectItem>
            <SelectItem value="viewer">Viewer — read only</SelectItem>
            <SelectItem value="moderator">Moderator — content &amp; reports</SelectItem>
            <SelectItem value="admin">Admin — everything but admins</SelectItem>
            <SelectItem value="owner">Owner — full control</SelectItem>
          </SelectContent>
        </Select>
        {self && <p className="mt-2 text-xs text-muted-foreground">You can't change your own role.</p>}
      </CardContent>
    </Card>
  );
}

function InfoCard({ u }: { u: UserDetail }) {
  const rows: [string, React.ReactNode][] = [
    ["Invited by", u.invitedBy ? <Link to="/users/$pubkey" params={{ pubkey: u.invitedBy }} className="font-mono text-primary hover:underline">{toNpub(u.invitedBy).slice(0, 16)}…</Link> : "—"],
    ["Website", u.profile?.website ? (safeUrl(u.profile.website) ? <a href={safeUrl(u.profile.website)} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">{u.profile.website}</a> : u.profile.website) : "—"],
    ["Lightning", u.profile?.lud16 ?? "—"],
    ["First seen", formatDate(u.firstSeenAt)],
    ["Last seen", formatDate(u.lastSeenAt)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 truncate text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function UserEvents({ pubkey }: { pubkey: string }) {
  const { data, isLoading, error, refetch } = useUserEvents(pubkey, 50);
  const can = useCan();
  const del = useDeleteEvents();
  const confirm = useConfirm();
  const deleteOne = async (id: string) => {
    const r = await confirm({
      title: "Delete this event?",
      description: "Deleted events are removed from the relay database. This cannot be undone.",
      destructive: true,
      confirmText: "Delete",
      input: { label: "Reason (optional)" },
    });
    if (r) del.mutate({ ids: [id], reason: r.input || undefined });
  };
  if (isLoading) return <ListSkeleton rows={4} />;
  if (error) return <ErrorState error={error} retry={() => refetch()} />;
  if (!data?.length) return <EmptyState icon={FileText} title="No events" description="This user hasn't published anything stored on this relay." />;
  return (
    <div className="space-y-2">
      {data.map((e) => (
        <EventCard key={e.id} event={e} compact onDelete={can("content.delete") ? () => deleteOne(e.id) : undefined} />
      ))}
      <div className="flex justify-center pt-2">
        <Button variant="outline" asChild>
          <Link to="/content" search={{ f: JSON.stringify({ authors: [pubkey] }) }}>Browse all events</Link>
        </Button>
      </div>
    </div>
  );
}

function UserMedia({ pubkey }: { pubkey: string }) {
  const q = useMedia({ pubkey });
  const items: MediaItem[] = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isLoading) return <ListSkeleton rows={2} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!items.length) return <EmptyState icon={ImageIcon} title="No media" description="No blobs uploaded by this user." />;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {items.map((b) => (
          <a key={b.sha256} href={mediaUrl(b)} target="_blank" rel="noreferrer" className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
            {b.type.startsWith("image/") || b.thumbnailUrl ? (
              <img src={mediaUrl(b, true)} alt="" loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
            ) : (
              <div className="flex size-full items-center justify-center text-xs text-muted-foreground">{b.type}</div>
            )}
            <div className="absolute top-1 left-1">
              <BlobStatusBadge status={b.status} />
            </div>
          </a>
        ))}
      </div>
      <div className="flex justify-center">
        <Button variant="outline" asChild>
          <Link to="/media" search={{ pubkey }}>Open in media manager</Link>
        </Button>
      </div>
    </div>
  );
}
