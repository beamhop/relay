import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import {
  Activity, ArrowDownToLine, ArrowUpFromLine, Cpu, Database, Gauge, Globe, HardDrive, Hourglass, MemoryStick, Plug, Send, ShieldX, Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { UserChip } from "@/components/user-chip";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ErrorBoundary } from "@/components/error-boundary";
import { useLiveHistory, useLiveSnapshot } from "@/lib/live";
import { useBoolPref, WORLD_MAP_TILE_HOST, worldMapPref } from "@/lib/prefs";
import { useSystem } from "@/queries/auth";
import { RANGES, useGeo, useKindStats, useRejections, useSeries, useSnapshot, useTopPubkeys, type RangeKey } from "@/queries/dashboard";
import { countryFlag, formatBytes, formatCompact, formatDate, formatDuration, formatMs, formatNumber, formatPercent, formatRate } from "@/lib/format";
import { kindName } from "@/lib/nostr";
import { usePluginRegistry } from "@/plugins/registry";
import { cn } from "@/lib/utils";

const WorldMap = React.lazy(() => import("@/components/world-map"));

export const Route = createFileRoute("/_app/")({
  component: Dashboard,
});

function Dashboard() {
  const [range, setRange] = React.useState<RangeKey>("24h");
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Dashboard"
        description="Live health and activity of your relay"
        actions={<RangeSelect value={range} onChange={setRange} />}
      />
      <Kpis />
      <div className="grid gap-4 xl:grid-cols-2">
        <TrafficChart range={range} />
        <ResourceChart range={range} />
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <GeoCard range={range} className="lg:col-span-3" />
        <KindsCard range={range} className="lg:col-span-2" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TopPubkeysCard range={range} />
        <RejectionsCard range={range} />
      </div>
      <PluginWidgets />
    </div>
  );
}

function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => v && onChange(v as RangeKey)}>
      {(Object.keys(RANGES) as RangeKey[]).map((r) => (
        <ToggleGroupItem key={r} value={r} className="px-3">
          {r}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Kpis() {
  const live = useLiveSnapshot();
  const fallback = useSnapshot();
  const s = live ?? fallback.data;
  const hist = useLiveHistory();
  const spark = (k: keyof NonNullable<typeof s>) => (hist.length > 2 ? hist.slice(-60).map((h) => Number(h[k]) || 0) : undefined);
  const loading = !s;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
      <KpiCard label="Connections" icon={Plug} loading={loading} value={formatNumber(s?.connections)} sub={`${formatNumber(s?.authedConnections)} authed · ${formatNumber(s?.subscriptions)} subs`} spark={spark("connections")} />
      <KpiCard label="Events in /s" icon={ArrowDownToLine} loading={loading} value={formatRate(s?.eventsInPerSec)} spark={spark("eventsInPerSec")} />
      <KpiCard label="Events out /s" icon={ArrowUpFromLine} loading={loading} value={formatRate(s?.eventsOutPerSec)} spark={spark("eventsOutPerSec")} />
      <KpiCard label="REQ /s" icon={Send} loading={loading} value={formatRate(s?.reqPerSec)} spark={spark("reqPerSec")} />
      <KpiCard label="Rejected /s" icon={ShieldX} loading={loading} value={formatRate(s?.rejectedPerSec)} tone={(s?.rejectedPerSec ?? 0) > 5 ? "warn" : "default"} spark={spark("rejectedPerSec")} />
      <KpiCard label="REQ latency p95" icon={Timer} loading={loading} value={formatMs(s?.reqLatencyP95)} sub={`p50 ${formatMs(s?.reqLatencyP50)} · p99 ${formatMs(s?.reqLatencyP99)}`} spark={spark("reqLatencyP95")} />
      <KpiCard label="Total events" icon={Database} loading={loading} value={formatCompact(s?.totalEvents)} sub={(s?.totalEvents ?? 0) >= 1000 ? formatNumber(s?.totalEvents) : undefined} />
      <KpiCard label="Database" icon={HardDrive} loading={loading} value={formatBytes(s?.dbBytes)} />
      <KpiCard label="Media" icon={HardDrive} loading={loading} value={formatBytes(s?.mediaBytes)} sub={`${formatNumber(s?.mediaCount)} blobs`} />
      <KpiCard label="CPU" icon={Cpu} loading={loading} value={formatPercent(s?.cpuPercent)} tone={(s?.cpuPercent ?? 0) > 85 ? "bad" : (s?.cpuPercent ?? 0) > 60 ? "warn" : "default"} spark={spark("cpuPercent")} />
      <KpiCard label="Memory (RSS)" icon={MemoryStick} loading={loading} value={formatBytes(s?.memoryRss)} sub={`heap ${formatBytes(s?.heapUsed)}`} spark={spark("memoryRss")} />
      <KpiCard
        label="Event loop lag"
        icon={Hourglass}
        loading={loading}
        value={formatMs(s?.loopLagMs)}
        tone={(s?.loopLagMs ?? 0) > 200 ? "bad" : (s?.loopLagMs ?? 0) > 50 ? "warn" : "default"}
        sub={s ? `up ${formatDuration(s.uptimeSec)}` : undefined}
        spark={spark("loopLagMs")}
      />
    </div>
  );
}

const tickTime = (range: RangeKey) => (t: number) => formatDate(t, range === "1h" || range === "24h" ? "HH:mm" : "MMM d");

const trafficConfig = {
  events_in: { label: "Events in", color: "var(--chart-1)" },
  events_out: { label: "Events out", color: "var(--chart-2)" },
  req: { label: "REQs", color: "var(--chart-3)" },
  rejected: { label: "Rejected", color: "var(--chart-4)" },
} satisfies ChartConfig;

function ChartCard({ title, description, children, loading, empty, error, retry, className, action }: { title: string; description?: string; children: React.ReactNode; loading?: boolean; empty?: boolean; error?: unknown; retry?: () => void; className?: string; action?: React.ReactNode }) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {loading ? <Skeleton className="h-64 w-full" /> : error ? <ErrorState error={error} retry={retry} /> : empty ? <EmptyState icon={Activity} title="No data for this range yet" className="h-64 border-0" /> : children}
      </CardContent>
    </Card>
  );
}

function TrafficChart({ range }: { range: RangeKey }) {
  const { data, isLoading, error, refetch } = useSeries(["events_in", "events_out", "req", "rejected"], range);
  return (
    <ChartCard title="Traffic" description={`Messages per interval · last ${RANGES[range].label}`} loading={isLoading} error={error} retry={() => refetch()} empty={!data?.length}>
      <ChartContainer config={trafficConfig} className="aspect-auto h-64 w-full">
        <AreaChart data={data} margin={{ left: 0, right: 8 }}>
          <defs>
            {Object.keys(trafficConfig).map((k) => (
              <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-${k})`} stopOpacity={0.35} />
                <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} tickFormatter={tickTime(range)} />
          <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={(v) => formatCompact(v)} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => formatDate(p?.[0]?.payload?.t)} indicator="line" />} />
          {Object.keys(trafficConfig).map((k) => (
            <Area key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} fill={`url(#fill-${k})`} strokeWidth={1.5} isAnimationActive={false} />
          ))}
          <ChartLegend content={<ChartLegendContent />} />
        </AreaChart>
      </ChartContainer>
    </ChartCard>
  );
}

const resourceConfig = {
  connections: { label: "Connections", color: "var(--chart-1)" },
  cpu: { label: "CPU %", color: "var(--chart-3)" },
  req_latency_p95: { label: "p95 ms", color: "var(--chart-2)" },
  loop_lag: { label: "Loop lag ms", color: "var(--chart-4)" },
} satisfies ChartConfig;

function ResourceChart({ range }: { range: RangeKey }) {
  const [metric, setMetric] = React.useState<"connections" | "cpu" | "latency" | "memory">("connections");
  const names = metric === "latency" ? ["req_latency_p95", "loop_lag"] : [metric];
  const { data, isLoading, error, refetch } = useSeries(names, range);
  const config: ChartConfig = metric === "memory" ? { memory: { label: "Memory", color: "var(--chart-5)" } } : resourceConfig;
  const fmt = metric === "memory" ? (v: number) => formatBytes(v, 0) : (v: number) => formatCompact(v);
  return (
    <ChartCard
      title="System"
      description={`Last ${RANGES[range].label}`}
      loading={isLoading}
      error={error}
      retry={() => refetch()}
      empty={!data?.length}
      action={
        <ToggleGroup type="single" size="sm" variant="outline" value={metric} onValueChange={(v) => v && setMetric(v as typeof metric)}>
          <ToggleGroupItem value="connections" className="px-2.5 text-xs">Conns</ToggleGroupItem>
          <ToggleGroupItem value="cpu" className="px-2.5 text-xs">CPU</ToggleGroupItem>
          <ToggleGroupItem value="memory" className="px-2.5 text-xs">Mem</ToggleGroupItem>
          <ToggleGroupItem value="latency" className="px-2.5 text-xs">Latency</ToggleGroupItem>
        </ToggleGroup>
      }
    >
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <LineChart data={data} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} tickFormatter={tickTime(range)} />
          <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={fmt} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => formatDate(p?.[0]?.payload?.t)} />} />
          {names.map((k) => (
            <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} dot={false} strokeWidth={2} isAnimationActive={false} />
          ))}
          {names.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}

const PIE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--muted-foreground)"];

function KindsCard({ range, className }: { range: RangeKey; className?: string }) {
  const { data, isLoading, error, refetch } = useKindStats(range);
  const [mode, setMode] = React.useState<"bar" | "pie">("bar");
  const rows = React.useMemo(() => {
    const sorted = [...(data ?? [])].sort((a, b) => b.count - a.count);
    const top = sorted.slice(0, mode === "pie" ? 5 : 10).map((r) => ({ name: kindName(r.kind), kind: r.kind, count: r.count }));
    const rest = sorted.slice(top.length).reduce((n, r) => n + r.count, 0);
    if (rest) top.push({ name: "Other", kind: -1, count: rest });
    return top.map((r, i) => ({ ...r, fill: PIE_COLORS[Math.min(i, PIE_COLORS.length - 1)] }));
  }, [data, mode]);
  const config: ChartConfig = { count: { label: "Events", color: "var(--chart-1)" } };
  return (
    <ChartCard
      title="Events by kind"
      className={className}
      loading={isLoading}
      error={error}
      retry={() => refetch()}
      empty={!rows.length}
      action={
        <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as "bar" | "pie")}>
          <ToggleGroupItem value="bar" className="px-2.5 text-xs">Bar</ToggleGroupItem>
          <ToggleGroupItem value="pie" className="px-2.5 text-xs">Pie</ToggleGroupItem>
        </ToggleGroup>
      }
    >
      <ChartContainer config={config} className="aspect-auto h-72 w-full">
        {mode === "bar" ? (
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 16 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" width={104} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator labelFormatter={(_, p) => (p?.[0]?.payload?.kind >= 0 ? `kind ${p[0].payload.kind}` : "Other")} />} />
            <Bar dataKey="count" radius={4} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.name} fill={r.kind === -1 ? "var(--muted-foreground)" : "var(--chart-1)"} />
              ))}
            </Bar>
          </BarChart>
        ) : (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
            <Pie data={rows} dataKey="count" nameKey="name" innerRadius="50%" strokeWidth={2} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.name} fill={r.fill} />
              ))}
            </Pie>
            <ChartLegend content={<ChartLegendContent nameKey="name" className="flex-wrap" />} />
          </PieChart>
        )}
      </ChartContainer>
    </ChartCard>
  );
}

function GeoCard({ range, className }: { range: RangeKey; className?: string }) {
  const { data, isLoading, error, refetch } = useGeo(range);
  const { data: sys } = useSystem();
  // the map's tiles come from a third party: only with GeoIP data to show, and only after the admin opts in
  const geoip = !!sys?.geoipEnabled;
  const [mapOn, setMapOn] = useBoolPref(worldMapPref);
  const [metric, setMetric] = React.useState<"connections" | "events">("connections");
  const countries = React.useMemo(() => {
    const m = new Map<string, { country: string; name: string; connections: number; events: number }>();
    for (const p of data ?? []) {
      const r = m.get(p.country) ?? { country: p.country, name: p.countryName, connections: 0, events: 0 };
      r.connections += p.connections;
      r.events += p.events;
      m.set(p.country, r);
    }
    return [...m.values()].sort((a, b) => b[metric] - a[metric]);
  }, [data, metric]);
  const total = countries.reduce((n, c) => n + c[metric], 0) || 1;
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle>World</CardTitle>
        <CardDescription>Where your users connect from</CardDescription>
        <CardAction>
          <ToggleGroup type="single" size="sm" variant="outline" value={metric} onValueChange={(v) => v && setMetric(v as typeof metric)}>
            <ToggleGroupItem value="connections" className="px-2.5 text-xs">Conns</ToggleGroupItem>
            <ToggleGroupItem value="events" className="px-2.5 text-xs">Events</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent className={cn("grid gap-4", geoip && "md:grid-cols-[1fr_15rem]")}>
        {geoip &&
          (mapOn ? (
            <ErrorBoundary label="Map" fallback={<div className="flex h-72 items-center justify-center rounded-lg bg-muted text-sm text-muted-foreground">Map unavailable (WebGL required)</div>}>
              <React.Suspense fallback={<Skeleton className="h-72 w-full rounded-lg" />}>
                {isLoading ? <Skeleton className="h-72 w-full rounded-lg" /> : <WorldMap points={data ?? []} metric={metric} className="h-72 w-full overflow-hidden rounded-lg border" />}
              </React.Suspense>
            </ErrorBoundary>
          ) : (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/30 p-4 text-center md:h-72">
              <Globe className="size-8 text-muted-foreground" />
              <p className="max-w-sm text-xs text-muted-foreground">
                The map draws countries with tiles from {WORLD_MAP_TILE_HOST}, a third-party server that then sees your IP address.
              </p>
              <Button variant="outline" size="sm" onClick={() => setMapOn(true)}>
                Load map from {WORLD_MAP_TILE_HOST}
              </Button>
            </div>
          ))}
        <div className={cn("overflow-y-auto", geoip && "max-h-72")}>
          {error ? (
            <ErrorState error={error} retry={() => refetch()} />
          ) : !countries.length && !isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{geoip ? "No located connections in this range yet." : "No geo data. Configure a GeoIP database to enable."}</p>
          ) : (
            <ul className="space-y-2">
              {countries.slice(0, 30).map((c) => (
                <li key={c.country} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">
                      {countryFlag(c.country)} {c.name}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{formatCompact(c[metric])}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${(c[metric] / total) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TopPubkeysCard({ range }: { range: RangeKey }) {
  const { data, isLoading, error, refetch } = useTopPubkeys(range, 10);
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Top publishers</CardTitle>
        <CardDescription>Most active pubkeys · last {RANGES[range].label}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <ErrorState error={error} retry={() => refetch()} />
        ) : !data?.length ? (
          <EmptyState title="No activity yet" className="border-0" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.pubkey}>
                  <TableCell className="max-w-0 w-full">
                    <UserChip pubkey={r.pubkey} profile={r.profile} size={28} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.events)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", r.rejected > 0 && "text-destructive")}>{formatNumber(r.rejected)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function RejectionsCard({ range }: { range: RangeKey }) {
  const { data, isLoading, error, refetch } = useRejections(range);
  const rows = [...(data ?? [])].sort((a, b) => b.count - a.count).slice(0, 10);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Rejection reasons</CardTitle>
        <CardDescription>Why events were refused</CardDescription>
        <CardAction>
          <Link to="/live" className="text-xs font-medium text-primary hover:underline">
            <Gauge className="mr-1 inline size-3.5" /> Live
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <ErrorState error={error} retry={() => refetch()} />
        ) : !rows.length ? (
          <EmptyState title="Nothing rejected" description="All incoming events passed your policies." className="border-0" />
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={`${r.code}-${r.reason}`} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="mr-1.5 font-mono text-xs text-muted-foreground">{r.code}</span>
                    {r.reason}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{formatNumber(r.count)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-destructive/70" style={{ width: `${(r.count / max) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PluginWidgets() {
  const { widgets } = usePluginRegistry();
  if (!widgets.length) return null;
  const span = { sm: "", md: "lg:col-span-2", lg: "lg:col-span-3" };
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">Plugins</h2>
      <div className="grid gap-4 lg:grid-cols-3">
        {widgets.map((w) => {
          const C = w.component;
          return (
            <Card key={`${w.plugin}:${w.id}`} className={cn("gap-3", span[w.size ?? "sm"])}>
              <CardHeader>
                <CardTitle>{w.title}</CardTitle>
                <CardDescription>{w.plugin}</CardDescription>
              </CardHeader>
              <CardContent>
                <ErrorBoundary label={`Widget ${w.title}`}>
                  <C api={w.api} />
                </ErrorBoundary>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
