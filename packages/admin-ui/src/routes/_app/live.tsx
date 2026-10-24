import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Pause, Play, Plug, Trash2, Unplug } from "lucide-react";
import type { ConnectionView } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { ListInput } from "@/components/list-input";
import { JsonView } from "@/components/json-view";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { KindBadge, ToneBadge } from "@/components/badges";
import { UserAvatar } from "@/components/user-avatar";
import { EventContent } from "@/components/event-card";
import { useConfirm } from "@/components/confirm";
import { ListSkeleton } from "@/components/page-skeleton";
import { useLiveEvents, useLiveSnapshot, useLiveStatus, type LiveEvent } from "@/lib/live";
import { useConnections } from "@/queries/dashboard";
import { useApiMutation } from "@/queries/client";
import { useCan } from "@/queries/auth";
import { api, enc } from "@/lib/api";
import { countryFlag, formatDuration, formatNumber, formatRate, nowSec } from "@/lib/format";
import { kindName, shortHex, shortNpub } from "@/lib/nostr";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/live")({
  component: LivePage,
});

const MAX_EVENTS = 300;

function LivePage() {
  const snap = useLiveSnapshot();
  const can = useCan();
  // GET /connections requires connections.manage; don't show (or poll) a tab that can only 403
  const showConnections = can("connections.manage");
  return (
    <div className="space-y-4">
      <PageHeader
        title="Live"
        description={
          snap ? `${formatNumber(snap.connections)} connections · ${formatRate(snap.eventsInPerSec)} events/s in · ${formatRate(snap.rejectedPerSec)} rejected/s` : "Realtime relay activity"
        }
      />
      <Tabs defaultValue="events">
        <TabsList>
          <TabsTrigger value="events">Event stream</TabsTrigger>
          {showConnections && <TabsTrigger value="connections">Connections</TabsTrigger>}
        </TabsList>
        <TabsContent value="events" className="pt-2">
          <EventStream />
        </TabsContent>
        {showConnections && (
          <TabsContent value="connections" className="pt-2">
            <Connections />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function EventStream() {
  const [paused, setPaused] = React.useState(false);
  const [events, setEvents] = React.useState<(LiveEvent & { key: number })[]>([]);
  const [kinds, setKinds] = React.useState<number[]>([]);
  const [status, setStatus] = React.useState<"all" | "accepted" | "rejected">("all");
  const [selected, setSelected] = React.useState<LiveEvent | null>(null);
  const buffer = React.useRef<(LiveEvent & { key: number })[]>([]);
  const seq = React.useRef(0);
  const streamStatus = useLiveStatus();

  useLiveEvents((e) => {
    buffer.current.push({ ...e, key: seq.current++ });
    // only the newest MAX_EVENTS are ever shown, so don't let a paused stream grow without bound
    if (buffer.current.length > MAX_EVENTS * 2) buffer.current = buffer.current.slice(-MAX_EVENTS);
  });

  // flush in batches to keep rendering cheap under load
  React.useEffect(() => {
    const t = setInterval(() => {
      if (paused || !buffer.current.length) return;
      const batch = buffer.current.slice(-MAX_EVENTS).reverse();
      buffer.current = [];
      setEvents((prev) => [...batch, ...prev].slice(0, MAX_EVENTS));
    }, 400);
    return () => clearInterval(t);
  }, [paused]);

  const filtered = events.filter((e) => (status === "all" || e.status === status) && (!kinds.length || kinds.includes(e.event.kind)));

  return (
    <Card className="gap-3">
      <CardHeader className="gap-3">
        <CardTitle className="flex items-center gap-2">
          Event stream
          {!paused && streamStatus === "open" && <span className="size-2 animate-pulse rounded-full bg-emerald-500" />}
        </CardTitle>
        <CardDescription>Most recent {MAX_EVENTS} events, newest first</CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEvents([])} aria-label="Clear">
            <Trash2 />
          </Button>
        </CardAction>
        <div className="col-span-full flex flex-col gap-2 sm:flex-row sm:items-center">
          <ToggleGroup type="single" variant="outline" size="sm" value={status} onValueChange={(v) => v && setStatus(v as typeof status)}>
            <ToggleGroupItem value="all" className="px-3">All</ToggleGroupItem>
            <ToggleGroupItem value="accepted" className="px-3">Accepted</ToggleGroupItem>
            <ToggleGroupItem value="rejected" className="px-3">Rejected</ToggleGroupItem>
          </ToggleGroup>
          <div className="sm:w-72">
            <ListInput numeric value={kinds} onChange={setKinds} placeholder="Filter kinds (e.g. 1, 7)" format={(k) => `${kindName(k)} ${k}`} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {!filtered.length && events.length > 0 ? (
          <EmptyState title="No events match" description={`None of the last ${events.length} events match these filters.`} className="border-0" />
        ) : !filtered.length ? (
          <EmptyState title={paused ? "Paused" : "Waiting for events…"} description={paused ? "Resume to keep receiving events." : "Events appear here as clients publish them."} className="border-0" />
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {filtered.map((e) => (
              <li key={e.key}>
                <button className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 animate-in fade-in" onClick={() => setSelected(e)}>
                  <UserAvatar pubkey={e.event.pubkey} size={28} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-mono text-muted-foreground">{shortNpub(e.event.pubkey, 4)}</span>
                      <KindBadge kind={e.event.kind} className="text-[11px]" />
                      {e.status === "rejected" ? <ToneBadge t="red">rejected</ToneBadge> : <ToneBadge t="green">accepted</ToneBadge>}
                      {e.country && <span title={e.country}>{countryFlag(e.country)}</span>}
                      {e.ip && <span className="hidden font-mono text-muted-foreground sm:inline">{e.ip}</span>}
                      <span className="ml-auto text-muted-foreground tabular-nums">{new Date(e.receivedAt).toLocaleTimeString()}</span>
                    </div>
                    {e.reason && <p className="text-xs text-destructive">{e.reason}</p>}
                    <p className="line-clamp-2 text-sm break-all text-foreground/90">{e.event.content || <span className="text-muted-foreground italic">({e.event.tags.length} tags)</span>}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ResponsiveDialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)} title={selected ? `${kindName(selected.event.kind)} event` : ""} description={selected ? shortHex(selected.event.id, 12) : undefined} className="sm:max-w-2xl">
        {selected && (
          <div className="space-y-3 pb-4">
            {selected.reason && <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">Rejected: {selected.reason}</p>}
            <div className="rounded-lg border p-3">
              <EventContent event={selected.event} />
            </div>
            <JsonView value={selected.event} />
          </div>
        )}
      </ResponsiveDialog>
    </Card>
  );
}

function Connections() {
  const { data, isLoading, isError, error, refetch } = useConnections();
  const can = useCan();
  const confirm = useConfirm();
  const mobile = useIsMobile();
  const disconnect = useApiMutation({
    fn: (c: { id?: string; ip?: string; pubkey?: string }) => (c.id ? api.del(`/connections/${enc(c.id)}`) : api.post("/connections/disconnect", c)),
    invalidate: [["connections"]],
    success: "Disconnected",
  });
  const manage = can("connections.manage");
  const doDisconnect = async (c: ConnectionView, by: "id" | "ip") => {
    if (by === "ip" && !(await confirm({ title: `Disconnect all from ${c.ip}?`, destructive: true, confirmText: "Disconnect" }))) return;
    disconnect.mutate(by === "id" ? { id: c.id } : { ip: c.ip });
  };
  const rows = [...(data ?? [])].sort((a, b) => a.connectedAt - b.connectedAt);
  if (isLoading) return <ListSkeleton />;
  if (isError) return <ErrorState error={error} retry={() => refetch()} />;
  if (!rows.length) return <EmptyState icon={Plug} title="No active connections" />;
  if (mobile)
    return (
      <div className="space-y-2">
        {rows.map((c) => (
          <Card key={c.id} className="gap-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm">{c.geo ? `${countryFlag(c.geo.country)} ` : ""}{c.ip}</span>
              {manage && (
                <Button size="sm" variant="outline" onClick={() => doDisconnect(c, "id")}>
                  <Unplug /> Disconnect
                </Button>
              )}
            </div>
            <ConnMeta c={c} />
          </Card>
        ))}
      </div>
    );
  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Client</TableHead>
            <TableHead>Authed as</TableHead>
            <TableHead className="text-right">Subs</TableHead>
            <TableHead className="text-right">In / Out</TableHead>
            <TableHead className="text-right">Connected</TableHead>
            {manage && <TableHead className="w-0" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <div className="font-mono text-sm">{c.geo ? `${countryFlag(c.geo.country)} ` : ""}{c.ip}</div>
                <div className="max-w-xs truncate text-xs text-muted-foreground" title={c.userAgent}>
                  {c.geo?.city ? `${c.geo.city} · ` : ""}{c.userAgent ?? "unknown client"}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {c.authedPubkeys.length ? c.authedPubkeys.map((p) => <Badge key={p} variant="secondary" className="font-mono font-normal">{shortNpub(p, 4)}</Badge>) : <span className="text-xs text-muted-foreground">—</span>}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{c.subscriptions}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(c.messagesIn)} / {formatNumber(c.messagesOut)}</TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{formatDuration(nowSec() - c.connectedAt)}</TableCell>
              {manage && (
                <TableCell>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => doDisconnect(c, "id")}>Disconnect</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => doDisconnect(c, "ip")}>All from IP</Button>
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function ConnMeta({ c }: { c: ConnectionView }) {
  return (
    <div className={cn("grid grid-cols-3 gap-2 text-xs text-muted-foreground")}>
      <span>{c.subscriptions} subs</span>
      <span>
        {formatNumber(c.messagesIn)}↓ {formatNumber(c.messagesOut)}↑
      </span>
      <span className="text-right">{formatDuration(nowSec() - c.connectedAt)}</span>
      {c.authedPubkeys.length > 0 && <span className="col-span-3 truncate font-mono">auth: {c.authedPubkeys.map((p) => shortNpub(p, 4)).join(", ")}</span>}
      {c.userAgent && <span className="col-span-3 truncate">{c.userAgent}</span>}
    </div>
  );
}
