import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, ExternalLink, Package, Puzzle } from "lucide-react";
import type { PluginView } from "@beamhop/sdk/admin-contract";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { ToneBadge } from "@/components/badges";
import { usePluginToggle, usePlugins } from "@/queries/misc";
import { useCan } from "@/queries/auth";
import { usePluginRegistry } from "@/plugins/registry";

export const Route = createFileRoute("/_app/plugins/")({ component: PluginsPage });

function PluginStatus({ p, uiError }: { p: PluginView; uiError?: string }) {
  if (p.status === "error") return <ToneBadge t="red">error</ToneBadge>;
  if (p.status === "disabled") return <ToneBadge t="gray">disabled</ToneBadge>;
  if (uiError) return <ToneBadge t="amber">UI failed</ToneBadge>;
  return <ToneBadge t="green">running</ToneBadge>;
}

function PluginsPage() {
  const { data, isLoading, error, refetch } = usePlugins();
  const toggle = usePluginToggle();
  const can = useCan();
  const reg = usePluginRegistry();
  return (
    <div className="space-y-4">
      <PageHeader title="Plugins" description="Extend the relay with policies, integrations and admin pages" />
      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : !data?.length ? (
        <EmptyState icon={Puzzle} title="No plugins installed" description="Add plugins to beamhop.config.json (npm packages or local paths) and restart the relay." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.map((p) => {
            const pages = reg.pages.filter((x) => x.plugin === p.name);
            return (
              <Card key={p.name} className="gap-3 p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Package className="size-5" />
                  </div>
                  <Link to="/plugins/$name" params={{ name: p.name }} className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium hover:underline">{p.name}</span>
                      <span className="text-xs text-muted-foreground">v{p.version}</span>
                      <PluginStatus p={p} uiError={reg.errors[p.name]} />
                      <Badge variant="outline" className="font-normal">{p.source}</Badge>
                    </div>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{p.description || "No description"}</p>
                  </Link>
                  <Switch
                    checked={p.enabled}
                    disabled={!can("plugins.manage") || toggle.isPending}
                    onCheckedChange={(enabled) => toggle.mutate({ name: p.name, enabled })}
                    aria-label={p.enabled ? "Disable plugin" : "Enable plugin"}
                  />
                </div>
                {(p.error || reg.errors[p.name]) && (
                  <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="break-all">{p.error ?? `UI: ${reg.errors[p.name]}`}</span>
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {pages.map((pg) => (
                    <Link key={pg.path} to="/p/$plugin/$" params={{ plugin: p.name, _splat: pg.path.replace(/^\/+/, "") }} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs hover:bg-secondary/70">
                      <ExternalLink className="size-3" /> {pg.title}
                    </Link>
                  ))}
                  <Link to="/plugins/$name" params={{ name: p.name }} className="ml-auto inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
                    Settings <ChevronRight className="size-4" />
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
