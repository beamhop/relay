import type * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Minus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/empty-state";
import { CopyButton } from "@/components/copy-button";
import { useSystem } from "@/queries/auth";
import { useLiveSnapshot, useLiveStatus } from "@/lib/live";
import { formatBytes, formatDuration, formatMs, formatPercent } from "@/lib/format";
import { toNpub } from "@/lib/nostr";

export const Route = createFileRoute("/_app/system")({ component: SystemPage });

const NIP_NAMES: Record<number, string> = {
  1: "Basic protocol", 2: "Follow list", 4: "Encrypted DMs (legacy)", 5: "DNS identifiers", 9: "Event deletion", 10: "Replies and threads", 11: "Relay info", 13: "Proof of work", 17: "Private DMs", 22: "Comments",
  23: "Long-form", 28: "Public chat", 29: "Relay-based groups", 40: "Expiration", 42: "Authentication", 45: "Counting", 50: "Search",
  56: "Reporting", 44: "Encrypted payloads", 51: "Lists", 59: "Gift wrap", 62: "Request to vanish", 65: "Relay list", 70: "Protected events", 77: "Negentropy", 86: "Relay management API", 96: "HTTP file storage", 98: "HTTP auth",
};

function SystemPage() {
  const { data: s, isLoading, error, refetch } = useSystem();
  const snap = useLiveSnapshot();
  const live = useLiveStatus();
  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  if (error || !s) return <ErrorState error={error ?? "Unavailable"} retry={() => refetch()} />;
  const npub = toNpub(s.relayPubkey);
  const rows: [string, React.ReactNode][] = [
    ["Name", s.name],
    ["Version", <code key="v">{s.version}</code>],
    ["Runtime", `${s.runtime} ${s.runtimeVersion}`],
    ["Database", s.dbDialect],
    ["Public URL", <a key="u" href={s.publicUrl} className="text-primary hover:underline" target="_blank" rel="noreferrer">{s.publicUrl}</a>],
    ["Uptime", formatDuration(snap?.uptimeSec ?? s.uptimeSec)],
    [
      "Relay pubkey",
      <span key="pk" className="flex min-w-0 items-center justify-end gap-1">
        <code className="truncate text-xs">{npub}</code>
        <CopyButton value={npub} size="icon-xs" />
      </span>,
    ],
    ["Live stream", live],
  ];
  const features: [string, boolean][] = [
    ["Blossom media", s.blossomEnabled],
    ["GeoIP", s.geoipEnabled],
    ["OpenTelemetry", s.otelEnabled],
    ["Web push", s.pushEnabled],
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="System" description="Runtime information about this beamhop instance" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Instance</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-4 py-2">
                  <dt className="shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 truncate text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Features</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2">
              {features.map(([k, on]) => (
                <div key={k} className="flex items-center gap-2 rounded-lg border p-2.5 text-sm">
                  {on ? <Check className="size-4 text-emerald-500" /> : <Minus className="size-4 text-muted-foreground" />}
                  <span className={on ? "" : "text-muted-foreground"}>{k}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          {snap && (
            <Card>
              <CardHeader>
                <CardTitle>Process</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <Metric label="CPU" value={formatPercent(snap.cpuPercent)} />
                <Metric label="Memory" value={formatBytes(snap.memoryRss)} />
                <Metric label="Loop lag" value={formatMs(snap.loopLagMs)} />
                <Metric label="p95 latency" value={formatMs(snap.reqLatencyP95)} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Supported NIPs</CardTitle>
          <CardDescription>Advertised in the NIP-11 relay information document</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {[...s.nips].sort((a, b) => a - b).map((n) => (
            <a key={n} href={`https://github.com/nostr-protocol/nips/blob/master/${String(n).padStart(2, "0")}.md`} target="_blank" rel="noreferrer">
              <Badge variant="secondary" className="font-normal hover:bg-secondary/70">
                NIP-{String(n).padStart(2, "0")}
                {NIP_NAMES[n] && <span className="text-muted-foreground"> · {NIP_NAMES[n]}</span>}
              </Badge>
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
